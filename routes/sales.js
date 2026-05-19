const express = require('express');
const { sale, saleitem, product, user, customer, discount, store, productinventory, sync_outbox } = require('../models');
const auth = require('../middleware/auth');
const { Op, sequelize, fn, col, literal } = require('sequelize');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { annotateSalesWithReturnState } = require('../services/sales/returnState');

const router = express.Router();

// Import the correct ZRA Integration Service
const ZRAIntegrationService = require('../services/sale/generateSmartInvoice'); // Adjust path as needed
// Deprecated random receipt generator (kept for reference)
// const generateReceiptNumber = () => {
//     const now = new Date();
//     const timestamp = now.getTime().toString().slice(-8);
//     return `RCP${timestamp}`;
// };

// Generate invoice number from SDC ID and receipt number
function generateInvoiceNumber(sdcid, receipt_no) {
    return "INV" + sdcid.substring(3) + "/" + receipt_no;
}

// Generate QR Code and save to file
async function generateQrCode(qrcode_url, receiptNo, saveDirectory) {
    try {
        // Ensure the save directory exists
        if (!fs.existsSync(saveDirectory)) {
            fs.mkdirSync(saveDirectory, { recursive: true });
        }

        // Sanitize receiptNo for filename
        const fileName = `qrcode_${receiptNo}.png`;
        const filePath = path.resolve(saveDirectory, fileName);

        // Generate QR code and save to file
        await QRCode.toFile(filePath, qrcode_url, {
            width: 150,
            margin: 2,
        });

        console.log(`QR code saved to ${filePath}`);
        return filePath;
    } catch (err) {
        console.error('Error generating QR code:', err);
        throw err;
    }
}


// Create new sale
router.post('/', auth, async (req, res) => {
    const t = await sale.sequelize.transaction();

    try {
        console.log(req.body)
        const {
            items, // [{ product_id, quantity, unit_price }]
            customer_id,
            discount_id,
            payment_method,
            amount_paid,
            payments, // optional: { cash: number, card: number, mobile_money: number }
            tax_rate = 16, // percentage
            notes
        } = req.body;

        // Validate items
        if (!items || items.length === 0) {
            return res.status(400).json({ message: 'Sale must have at least one item' });
        }

        // Validate user has store_id
        if (!req.user.store_id) {
            await t.rollback();
            return res.status(400).json({ message: 'User must be associated with a store' });
        }

        // Calculate totals
        let subtotal = 0;
        const saleItems = [];

        // Validate and calculate each item - also fetch product details for ZRA
        for (const item of items) {
            const productData = await product.findByPk(item.product_id, { transaction: t });

            if (!productData) {
                await t.rollback();
                return res.status(400).json({ message: `Product with ID ${item.product_id} not found` });
            }

            // Check stock from productinventory for the user's store
            const inventory = await productinventory.findOne({
                where: { product_id: item.product_id, store_id: req.user.store_id },
                transaction: t
            });

            const availableQty = inventory ? inventory.stock_quantity : 0;

            if (availableQty < item.quantity) {
                await t.rollback();
                return res.status(400).json({
                    message: `Insufficient stock for ${productData.name}. Available: ${availableQty}`
                });
            }

            // Determine effective price: store override if present, else product price (assumed tax-inclusive)
            const effectiveUnitPrice = inventory && inventory.price_override != null
                ? Number(inventory.price_override)
                : Number(productData.price);

            // If client didn't send unit_price, default to effective per-store price (tax-inclusive)
            const unit_price_inclusive = (item.unit_price == null || item.unit_price === '')
                ? effectiveUnitPrice
                : Number(item.unit_price);

            // Derive tax-exclusive values from tax-inclusive unit price
            const taxMultiplier = 1 + (Number(tax_rate) / 100);
            const unit_price_exclusive = unit_price_inclusive / taxMultiplier;

            const tax_exclusive_total = item.quantity * unit_price_exclusive;
            const tax_inclusive_total = item.quantity * unit_price_inclusive;

            subtotal += tax_exclusive_total; // Subtotal remains tax-exclusive for tax calculations

            // Include product data for ZRA integration and store inclusive for display/DB
            saleItems.push({
                product_id: item.product_id,
                quantity: item.quantity,
                unit_price: unit_price_inclusive, // Tax-inclusive unit price for display/storage
                total_price: tax_inclusive_total, // Tax-inclusive total for display/storage
                tax_exclusive_total: tax_exclusive_total, // Provide tax-exclusive total for integrations
                product: productData // Include full product data
            });
        }

        // Apply discount
        let discount_amount = 0;
        let discountData = null;
        if (discount_id) {
            discountData = await discount.findByPk(discount_id, { transaction: t });
            if (discountData && discountData.is_active) {
                if (discountData.type === 'percentage') {
                    discount_amount = (subtotal * discountData.value) / 100;
                } else {
                    discount_amount = discountData.value;
                }
            }
        }

        // Calculate tax and total
        const tax_amount = Math.round(((subtotal - discount_amount) * tax_rate) / 100 * 100) / 100;
        const total_amount = Math.round((subtotal - discount_amount + tax_amount) * 100) / 100;

        // Handle payments breakdown (mixed payments)
        const normalizeNum = (n) => {
            const v = Number(n);
            return isNaN(v) ? 0 : Math.max(0, v);
        };
        let payments_breakdown_obj = null;
        let effective_payment_method = payment_method;
        let effective_amount_paid = Number(amount_paid || 0);

        if (payments && typeof payments === 'object') {
            const bd = {
                cash: normalizeNum(payments.cash),
                card: normalizeNum(payments.card),
                mobile_money: normalizeNum(payments.mobile_money)
            };
            // Remove zero entries
            const entries = Object.entries(bd).filter(([k, v]) => v > 0);
            if (entries.length > 0) {
                payments_breakdown_obj = Object.fromEntries(entries);
                const sum = entries.reduce((s, [, v]) => s + v, 0);
                effective_amount_paid = Math.round(sum * 100) / 100;
                effective_payment_method = entries.length > 1 ? 'mixed' : entries[0][0];
            }
        }

        const change_amount = Math.round((effective_amount_paid - total_amount) * 100) / 100;



        if (change_amount < 0) {
            await t.rollback();
            return res.status(400).json({ message: 'Insufficient payment amount' });
        }

        // Get customer data for ZRA
        let customerData = null;
        if (customer_id) {
            customerData = await customer.findByPk(customer_id, { transaction: t });
        }

        // Prepare sale data for ZRA integration
        const saleDataForZRA = {
            subtotal,
            discount_amount,
            tax_amount,
            total_amount,
            tax_rate,
            payment_method: effective_payment_method,
            amount_paid: effective_amount_paid,
            change_amount,
            notes: notes || null,
            payments_breakdown: payments_breakdown_obj,
            customer: customerData,
            discount: discountData,
        };

        // Initialize ZRA Integration Service
        const zraService = new ZRAIntegrationService();

        console.log('Processing ZRA sale endpoint...');
        let zraFailed = false;
        let zraError = null;
        let saveSalesData = null;

        // Process only the ZRA Sales endpoint first
        const salesData = await zraService.transformToZRASalesData(saleDataForZRA, saleItems, req.user);
        const salesResponse = await zraService.sendSalesData(salesData);

        if (!salesResponse.success) {
            // Do NOT rollback the sale — mark for retry and continue saving locally
            zraFailed = true;
            console.error('ZRA Sales Integration failed:', salesResponse.error);
            zraError = typeof salesResponse.error === 'string' ? salesResponse.error : JSON.stringify(salesResponse.error);
        } else {
            console.log('ZRA sales integration successful:', salesResponse.data);
            saveSalesData = salesResponse.data.data || null;
        }

        if (saveSalesData) {
            console.log('ZRA Sales Data:', saveSalesData);
        }

        // Generate QR code file path (but don't await it here to avoid blocking)
        let qrFilePath = null;
        if (saveSalesData && saveSalesData.qrCodeUrl && saveSalesData.rcptNo) {
            try {
                qrFilePath = await generateQrCode(
                    saveSalesData.qrCodeUrl,
                    saveSalesData.rcptNo,
                    "./qrcodes"
                );
            } catch (qrError) {
                console.error('QR Code generation failed:', qrError);
                // Don't fail the entire transaction for QR code generation
            }
        }

        console.log('Creating sale record...');

        // Helper to safely limit string lengths to avoid DB truncation errors
        const limitStr = (v, n) => (v == null ? null : String(v).slice(0, n));

        // Generate incremental receipt number per store
        const receiptNumber = await zraService.generateReceiptNumber(req.user.store_id);

        // Extract potential ZRA values first
        const zraInvNumberRaw = (salesData && salesData.cisInvcNo) || (saveSalesData ? (saveSalesData.invoiceNo || saveSalesData.invNumber || saveSalesData.invnumber) : null);
        const zraReceiptNoRaw = saveSalesData ? (saveSalesData.rcptNo || null) : null;
        const zraSdcIdRaw = saveSalesData ? (saveSalesData.sdcId || null) : null;
        const zraRcptSignRaw = saveSalesData ? (saveSalesData.rcptSign || null) : null;
        const zraIntrlDataRaw = saveSalesData ? (saveSalesData.intrlData || null) : null;
        const zraQrUrlRaw = saveSalesData ? (saveSalesData.qrCodeUrl || null) : null;
        const zraVsdcDateRaw = saveSalesData ? (saveSalesData.vsdcRcptPbctDate || null) : null;
        const computedInvoiceNoRaw = (saveSalesData && saveSalesData.sdcId && saveSalesData.rcptNo)
            ? generateInvoiceNumber(saveSalesData.sdcId, saveSalesData.rcptNo)
            : null;

        // Create sale regardless of ZRA status
        const newSale = await sale.create({
            receipt_number: receiptNumber,
            user_id: req.user.id,
            customer_id: customer_id || null,
            subtotal,
            discount_id: discount_id || null,
            discount_amount,
            tax_amount,
            total_amount,
            payment_method: effective_payment_method,
            amount_paid: effective_amount_paid,
            change_amount,
            notes: notes || null,
            payments_breakdown: payments_breakdown_obj,
            // ZRA fields - may be null if offline (apply safe length limits to match model)
            invnumber: limitStr(zraInvNumberRaw, 50),
            receipt_no: limitStr(zraReceiptNoRaw, 50),
            sdcid: limitStr(zraSdcIdRaw, 50),
            receiptsig: limitStr(zraRcptSignRaw, 50),
            intrldata: limitStr(zraIntrlDataRaw, 100),
            qrcode_url: limitStr(zraQrUrlRaw, 255),
            vsdcrcpdate: limitStr(zraVsdcDateRaw, 100),
            invoice_no: limitStr(computedInvoiceNoRaw, 100),
            qrfilepath: limitStr(qrFilePath, 255),
            // Retry/Offline flags
            zra_status: zraFailed ? 'pending' : 'sent',
            zra_error: zraFailed ? (typeof salesResponse.error === 'string' ? salesResponse.error : JSON.stringify(salesResponse.error)) : null,
            retry_count: zraFailed ? 0 : 0,
            next_retry_at: zraFailed ? new Date(Date.now() + 2 * 60 * 1000) : null,
            last_retry_at: null,
        }, { transaction: t });

        console.log('Sale created successfully:', newSale.id);

        // Create sale items and update stock
        for (const item of saleItems) {
            await saleitem.create({
                sale_id: newSale.id,
                product_id: item.product_id,
                quantity: item.quantity,
                unit_price: item.unit_price,
                total_price: item.total_price
            }, { transaction: t });

            // Update product stock
            await productinventory.update(
                {
                    stock_quantity: literal(`stock_quantity - ${item.quantity}`)
                },
                {
                    where: { product_id: item.product_id, store_id: req.user.store_id },
                    transaction: t
                }
            );

        }

        // Create sync outbox entry
        const outboxPayload = {
            branch_id: String(process.env.ZRA_BHF_ID || '000').trim() || '000',
            terminal_id: String(process.env.TERMINAL_ID || process.env.ZRA_TERMINAL_ID || '000').trim() || '000',
            sale: {
                id: newSale.id,
                receipt_number: receiptNumber,
                user_id: req.user.id,
                store_id: req.user.store_id,
                branch_id: String(process.env.ZRA_BHF_ID || '000').trim() || '000',
                terminal_id: String(process.env.TERMINAL_ID || process.env.ZRA_TERMINAL_ID || '000').trim() || '000',
                customer_id: customer_id || null,
                discount_id: discount_id || null,
                subtotal,
                discount_amount,
                tax_amount,
                total_amount,
                payment_method: effective_payment_method,
                amount_paid: effective_amount_paid,
                change_amount,
                notes: notes || null,
                payments_breakdown: payments_breakdown_obj,
                sale_date: new Date().toISOString()
            },
            items: saleItems.map(item => ({
                product_id: item.product_id,
                quantity: Number(item.quantity),
                unit_price: Number(item.unit_price),
                total_price: Number(item.total_price),
                tax_exclusive_total: Number(item.tax_exclusive_total),
                product: {
                    id: item.product.id,
                    name: item.product.name,
                    product_code: item.product.product_code,
                    formatted_product_code: item.product.formatted_product_code || null,
                    price: Number(item.product.price)
                }
            })),
            customer: customerData,
            discount: discountData
        };

        await sync_outbox.create({
            event_type: 'sale.created',
            aggregate_type: 'sale',
            aggregate_id: newSale.id,
            store_id: req.user.store_id,
            user_id: req.user.id,
            receipt_number: receiptNumber,
            idempotency_key: `sale.created:store-${req.user.store_id}:sale-${newSale.id}:receipt-${receiptNumber}`,
            payload: outboxPayload,
            status: 'pending',
            attempt_count: 0,
            next_retry_at: new Date()
        }, { transaction: t });

        await t.commit();
        console.log('Transaction committed successfully');

        // Fetch complete sale data for response
        const completeSale = await sale.findByPk(newSale.id, {
            include: [
                {
                    model: saleitem,
                    as: 'items',
                    include: [{ model: product, as: 'product' }]
                },
                {
                    model: user, as: 'cashier', attributes: ['id', 'full_name'],
                    include: [{ model: store, as: 'store', attributes: ['store_location', 'store_mobile_no'] }]
                },
                { model: customer, as: 'customer' },
                { model: discount, as: 'discount' }
            ]
        });

        // Send response immediately
        res.status(201).json({
            message: zraFailed ? 'Sale saved (ZRA pending due to network). Will retry automatically.' : 'Sale completed successfully',
            sale: completeSale,
            zra_integration: {
                success: !zraFailed,
                sales_endpoint: {
                    success: !zraFailed,
                    message: zraFailed ? (zraError || 'ZRA unavailable; queued for retry') : 'Sales data submitted successfully to ZRA'
                }
            }
        });

        // Process stock endpoints in the background only if ZRA succeeded (to keep sequence)
        if (!zraFailed) {
            processStockEndpointsInBackground(newSale.id, saleDataForZRA, saleItems, req.user, zraService);
        }

    } catch (error) {
        await t.rollback();
        console.error('Sale creation error:', error);

        // Check if this is a ZRA-related error
        if (error.message && error.message.includes('ZRA')) {
            return res.status(500).json({
                message: 'ZRA integration error',
                error: error.message
            });
        }

        // Check for specific error types
        if (error.name === 'SequelizeValidationError') {
            return res.status(400).json({
                message: 'Validation error',
                errors: error.errors.map(e => e.message)
            });
        }

        if (error.name === 'SequelizeForeignKeyConstraintError') {
            return res.status(400).json({
                message: 'Invalid reference to related data'
            });
        }

        res.status(500).json({
            message: 'Server error',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * Process stock endpoints in background and create notifications if they fail
 * @param {number} saleId
 * @param {object} saleData
 * @param {array} items
 * @param {object} user
 * @param {ZRAIntegrationService} zraService
 */
async function processStockEndpointsInBackground(saleId, saleData, items, user, zraService) {
    const NotificationService = require('../services/NotificationService');
    const notificationService = new NotificationService();

    try {
        console.log('Processing stock endpoints in background for sale:', saleId);

        // Transform data for stock endpoints
        const stockItemsData = zraService.transformToZRAStockItemsData(saleData, items, user);
        const stockMasterData = await zraService.transformToZRAStockMasterData(items, user);

        // Process stock items endpoint
        const stockItemsResponse = await zraService.sendStockItemsData(stockItemsData);

        if (!stockItemsResponse.success) {
            console.error('Stock Items endpoint failed:', stockItemsResponse.error);

            await notificationService.createNotification({
                type: 'ZRA_STOCK_ITEMS_FAILED',
                title: 'ZRA Stock Items Update Failed',
                message: `Failed to update stock items in ZRA for sale #${saleId}. Error: ${stockItemsResponse.error}`,
                severity: 'warning',
                user_id: user.id,
                metadata: {
                    sale_id: saleId,
                    endpoint: 'saveStockItems',
                    error: stockItemsResponse.error
                }
            });
        } else {
            console.log('Stock Items endpoint successful for sale:', saleId);
        }

        // Process stock master endpoint
        const stockMasterResponse = await zraService.sendStockMasterData(stockMasterData);

        if (!stockMasterResponse.success) {
            console.error('Stock Master endpoint failed:', stockMasterResponse.error);

            await notificationService.createNotification({
                type: 'ZRA_STOCK_MASTER_FAILED',
                title: 'ZRA Stock Master Update Failed',
                message: `Failed to update stock master in ZRA for sale #${saleId}. Error: ${stockMasterResponse.error}`,
                severity: 'warning',
                user_id: user.id,
                metadata: {
                    sale_id: saleId,
                    endpoint: 'saveStockMaster',
                    error: stockMasterResponse.error
                }
            });
        } else {
            console.log('Stock Master endpoint successful for sale:', saleId);
        }

        // Create success notification if both stock endpoints succeeded
        if (stockItemsResponse.success && stockMasterResponse.success) {
            await notificationService.createNotification({
                type: 'ZRA_INTEGRATION_COMPLETE',
                title: 'ZRA Integration Complete',
                message: `All ZRA endpoints processed successfully for sale #${saleId}`,
                severity: 'success',
                user_id: user.id,
                metadata: {
                    sale_id: saleId,
                    all_endpoints_success: true
                }
            });
        }

    } catch (error) {
        console.error('Error in background stock processing:', error);

        await notificationService.createNotification({
            type: 'ZRA_BACKGROUND_ERROR',
            title: 'ZRA Background Processing Error',
            message: `An error occurred while processing ZRA stock endpoints for sale #${saleId}. Error: ${error.message}`,
            severity: 'error',
            user_id: user.id,
            metadata: {
                sale_id: saleId,
                error: error.message
            }
        });
    }
}

// Get all sales with pagination
router.get('/', auth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const filterStoreId = req.user.store_id;

        const include = [
            { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
            { model: customer, as: 'customer' },
            { model: discount, as: 'discount' },
            { model: saleitem, as: 'items', include: [{ model: product, as: 'product' }] }
        ];

        const { count, rows } = await sale.findAndCountAll({
            limit,
            offset,
            order: [['sale_date', 'DESC']],
            include
        });

        const sales = await annotateSalesWithReturnState(rows);

        res.json({
            sales,
            pagination: {
                current_page: page,
                total_pages: Math.ceil(count / limit),
                total_records: count,
                per_page: limit
            }
        });

    } catch (error) {
        console.error('Get sales error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get sale by ID (for receipt generation)
router.get('/:id', auth, async (req, res) => {
    try {
        const saleData = await sale.findByPk(req.params.id, {
            include: [
                {
                    model: saleitem,
                    as: 'items',
                    include: [{ model: product, as: 'product' }]
                },
                { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'] },
                { model: customer, as: 'customer' },
                { model: discount, as: 'discount' }
            ]
        });
        if (!saleData) {
            return res.status(404).json({ message: 'Sale not found' });
        }
        // Users can only access sales for their own store (applies to cashiers and admins)
        if (req.user && (req.user.role === 'cashier' || req.user.role === 'admin')) {
            const cashierStoreId = saleData.cashier && saleData.cashier.store_id;
            if (!cashierStoreId || cashierStoreId !== req.user.store_id) {
                return res.status(403).json({ message: 'Access denied' });
            }
        }

        res.json({ sale: saleData });

    } catch (error) {
        console.error('Get sale by ID error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Mark a sale as receipt printed (idempotent)
router.post('/:id/mark-printed', auth, async (req, res) => {
    try {
        const id = req.params.id;
        const saleData = await sale.findByPk(id, {
            include: [
                { model: user, as: 'cashier', attributes: ['id', 'store_id'] }
            ]
        });
        if (!saleData) {
            return res.status(404).json({ message: 'Sale not found' });
        }
        // Enforce store access: cashiers/admins can only modify within their store
        if (req.user && (req.user.role === 'cashier' || req.user.role === 'admin')) {
            const cashierStoreId = saleData.cashier && saleData.cashier.store_id;
            if (!cashierStoreId || cashierStoreId !== req.user.store_id) {
                return res.status(403).json({ message: 'Access denied' });
            }
        }

        const wasPrinted = !!saleData.receipt_printed;
        if (!wasPrinted) {
            saleData.receipt_printed = true;
            await saleData.save();
        }
        return res.json({
            sale: saleData,
            updated: !wasPrinted,
            message: wasPrinted ? 'Already marked as printed' : 'Marked as printed'
        });
    } catch (error) {
        console.error('Mark printed error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get sales by date range
router.get('/report/date-range', auth, async (req, res) => {
    try {
        const { start_date, end_date } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        // Validate date format
        const startDate = new Date(start_date);
        const endDate = new Date(end_date);

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            return res.status(400).json({ message: 'Invalid date format' });
        }

        const filterStoreId = req.user.store_id;

        const include = [
            { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
            { model: customer, as: 'customer' }
        ];

        const sales = await sale.findAll({
            where: {
                sale_date: {
                    [Op.between]: [startDate, endDate]
                }
            },
            include,
            order: [['sale_date', 'DESC']]
        });

        const activeSales = (await annotateSalesWithReturnState(sales)).filter(s => !s.is_fully_returned);

        // Calculate summary
        const summary = {
            total_sales: activeSales.length,
            total_revenue: activeSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0),
            total_discounts: activeSales.reduce((sum, s) => sum + parseFloat(s.discount_amount || 0), 0),
            payment_methods: {}
        };

        // Group by payment method (allocate by payments_breakdown when available)
        activeSales.forEach(s => {
            const bd = s.payments_breakdown;
            if (bd && typeof bd === 'object') {
                Object.entries(bd).forEach(([method, amt]) => {
                    const key = method || 'unknown';
                    summary.payment_methods[key] = (summary.payment_methods[key] || 0) + Number(amt || 0);
                });
            } else {
                const method = s.payment_method || 'unknown';
                summary.payment_methods[method] = (summary.payment_methods[method] || 0) + parseFloat(s.total_amount || 0);
            }
        });

        res.json({
            sales: activeSales,
            summary,
            date_range: {
                start_date: start_date,
                end_date: end_date
            }
        });

    } catch (error) {
        console.error('Date range report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get daily sales summary
router.get('/report/daily', auth, async (req, res) => {
    try {
        const today = new Date();
        const startOfDay = new Date(today.setHours(0, 0, 0, 0));
        const endOfDay = new Date(today.setHours(23, 59, 59, 999));

        const isAdmin = req.user && req.user.role === 'admin';
        const filterStoreId = isAdmin ? (parseInt(req.query.store_id) || null) : req.user.store_id;
        const include = [
            { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) }
        ];

        const todaySales = await sale.findAll({
            where: {
                sale_date: {
                    [Op.between]: [startOfDay, endOfDay]
                }
            },
            include
        });

        const activeTodaySales = (await annotateSalesWithReturnState(todaySales)).filter(s => !s.is_fully_returned);

        const summary = {
            date: startOfDay.toDateString(),
            total_sales: activeTodaySales.length,
            total_revenue: activeTodaySales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0),
            total_discounts: activeTodaySales.reduce((sum, s) => sum + parseFloat(s.discount_amount || 0), 0),
            cash_sales: activeTodaySales.filter(s => s.payment_method === 'cash').length,
            card_sales: activeTodaySales.filter(s => s.payment_method === 'card').length,
            mobile_sales: activeTodaySales.filter(s => s.payment_method === 'mobile_money').length,
            payment_summary: (() => {
                const totals = { cash: 0, card: 0, mobile_money: 0 };
                activeTodaySales.forEach(s => {
                    const bd = s.payments_breakdown;
                    if (bd && typeof bd === 'object') {
                        Object.entries(bd).forEach(([method, amt]) => {
                            if (totals.hasOwnProperty(method)) {
                                totals[method] += Number(amt || 0);
                            }
                        });
                    } else if (totals.hasOwnProperty(s.payment_method)) {
                        totals[s.payment_method] += Number(s.total_amount || 0);
                    }
                });
                return totals;
            })()
        };

        res.json({ summary });

    } catch (error) {
        console.error('Daily report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get dashboard statistics
router.get('/dashboard/stats', auth, async (req, res) => {
    try {
        const { computeDashboardStats } = require('../services/reports/dashboardStats');
        const data = await computeDashboardStats(req);
        res.json({ success: true, data, timestamp: new Date().toISOString() });
    } catch (error) {
        console.error('Dashboard stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load dashboard statistics',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// Get dashboard statistics with date filter (optional)
router.get('/dashboard/stats/:period', auth, async (req, res) => {
    try {
        const { period } = req.params; // 'today', 'week', 'month', 'year'

        let startDate, endDate;
        const now = new Date();

        switch (period) {
            case 'today':
                startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000 - 1);
                break;
            case 'week':
                startDate = new Date(now);
                startDate.setDate(now.getDate() - now.getDay());
                startDate.setHours(0, 0, 0, 0);
                endDate = new Date();
                break;
            case 'month':
                startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                endDate = new Date();
                break;
            case 'year':
                startDate = new Date(now.getFullYear(), 0, 1);
                endDate = new Date();
                break;
            default:
                return res.status(400).json({
                    success: false,
                    message: 'Invalid period. Use: today, week, month, or year'
                });
        }

        // Get sales for the specified period
        const filterStoreId = req.user.store_id;
        const include = [
            { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
            {
                model: saleitem,
                as: 'items',
                include: [{
                    model: product,
                    as: 'product',
                    attributes: ['name']
                }]
            }
        ];
        const periodSales = await sale.findAll({
            where: {
                sale_date: {
                    [Op.between]: [startDate, endDate]
                }
            },
            include
        });

        const activePeriodSales = (await annotateSalesWithReturnState(periodSales)).filter(s => !s.is_fully_returned);

        // Calculate statistics for the period
        const totalSales = activePeriodSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);
        const totalTransactions = activePeriodSales.length;
        const averageTransaction = totalTransactions > 0 ? totalSales / totalTransactions : 0;

        // Payment method breakdown
        const paymentMethods = {
            cash: 0,
            card: 0,
            mobile_money: 0
        };

        activePeriodSales.forEach(s => {
            const bd = s.payments_breakdown;
            if (bd && typeof bd === 'object') {
                Object.entries(bd).forEach(([method, amt]) => {
                    if (paymentMethods.hasOwnProperty(method)) {
                        paymentMethods[method] += Number(amt || 0);
                    }
                });
            } else if (paymentMethods.hasOwnProperty(s.payment_method)) {
                paymentMethods[s.payment_method] += parseFloat(s.total_amount || 0);
            }
        });

        res.json({
            success: true,
            period: period,
            date_range: {
                start: startDate.toISOString(),
                end: endDate.toISOString()
            },
            data: {
                totalSales,
                totalTransactions,
                averageTransaction,
                paymentMethods
            }
        });

    } catch (error) {
        console.error('Period stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load period statistics',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

module.exports = router;