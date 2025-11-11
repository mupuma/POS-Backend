const express = require('express');
const { sale, saleitem, product, user, customer, discount,store,productinventory } = require('../models');
const auth = require('../middleware/auth');
const { Op,sequelize, fn, col,literal} = require('sequelize');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

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
        const {
            items, // [{ product_id, quantity, unit_price }]
            customer_id,
            discount_id,
            payment_method,
            amount_paid,
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
        const tax_amount = ((subtotal - discount_amount) * tax_rate) / 100;
        const total_amount = subtotal - discount_amount + tax_amount;
        const change_amount = amount_paid - total_amount;

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
            payment_method,
            amount_paid,
            change_amount,
            notes,
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

        // Generate incremental receipt number per store
        const receiptNumber = await zraService.generateReceiptNumber(req.user.store_id);

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
            payment_method,
            amount_paid,
            change_amount,
            notes: notes || null,
            // ZRA fields - may be null if offline
            invnumber: (salesData && salesData.cisInvcNo) || (saveSalesData ? (saveSalesData.invoiceNo || saveSalesData.invNumber || saveSalesData.invnumber) : null),
            receipt_no: saveSalesData ? (saveSalesData.rcptNo || null) : null,
            sdcid: saveSalesData ? (saveSalesData.sdcId || null) : null,
            receiptsig: saveSalesData ? (saveSalesData.rcptSign || null) : null,
            intrldata: saveSalesData ? (saveSalesData.intrlData || null) : null,
            qrcode_url: saveSalesData ? (saveSalesData.qrCodeUrl || null) : null,
            vsdcrcpdate: saveSalesData ? (saveSalesData.vsdcRcptPbctDate || null) : null,
            invoice_no: (saveSalesData && saveSalesData.sdcId && saveSalesData.rcptNo)
                ? generateInvoiceNumber(saveSalesData.sdcId, saveSalesData.rcptNo)
                : null,
            qrfilepath: qrFilePath,
            // Retry/Offline flags
            zra_status: zraFailed ? 'pending' : 'sent',
            zra_error: zraFailed ? (typeof salesResponse.error === 'string' ? salesResponse.error : JSON.stringify(salesResponse.error)) : null,
            retry_count: zraFailed ? 0 : 0,
            next_retry_at: zraFailed ? new Date(Date.now() + 1 * 60 * 1000) : null,
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
                { model: user, as: 'cashier', attributes: ['id', 'full_name'],
                    include:[{model:store,as:'store', attributes:['store_location','store_mobile_no']}]
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

        res.json({
            sales: rows,
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

        // Calculate summary
        const summary = {
            total_sales: sales.length,
            total_revenue: sales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0),
            total_discounts: sales.reduce((sum, s) => sum + parseFloat(s.discount_amount || 0), 0),
            payment_methods: {}
        };

        // Group by payment method
        sales.forEach(s => {
            const method = s.payment_method || 'unknown';
            summary.payment_methods[method] =
                (summary.payment_methods[method] || 0) + parseFloat(s.total_amount || 0);
        });

        res.json({
            sales,
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

        const summary = {
            date: startOfDay.toDateString(),
            total_sales: todaySales.length,
            total_revenue: todaySales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0),
            total_discounts: todaySales.reduce((sum, s) => sum + parseFloat(s.discount_amount || 0), 0),
            cash_sales: todaySales.filter(s => s.payment_method === 'cash').length,
            card_sales: todaySales.filter(s => s.payment_method === 'card').length,
            mobile_sales: todaySales.filter(s => s.payment_method === 'mobile_money').length,
            payment_summary: {
                cash: todaySales
                    .filter(s => s.payment_method === 'cash')
                    .reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0),
                card: todaySales
                    .filter(s => s.payment_method === 'card')
                    .reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0),
                mobile_money: todaySales
                    .filter(s => s.payment_method === 'mobile_money')
                    .reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0)
            }
        };

        res.json({ summary });

    } catch (error) {
        console.error('Daily report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get dashboard statistics
// Get dashboard statistics
router.get('/dashboard/stats', auth, async (req, res) => {
    try {
        const { creditnote, creditnoteitem } = require('../models');

        // Get current date ranges
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000 - 1);

        const startOfWeek = new Date(startOfToday);
        startOfWeek.setDate(startOfToday.getDate() - startOfToday.getDay());

        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const filterStoreId = req.user.store_id;

        // Base include for sales queries - filter by store
        const salesInclude = [
            {
                model: user,
                as: 'cashier',
                attributes: ['id', 'full_name', 'store_id'],
                where: { store_id: filterStoreId },
                required: true
            }
        ];

        // Today's sales statistics
        const todaysSales = await sale.findAll({
            where: {
                sale_date: {
                    [Op.between]: [startOfToday, endOfToday]
                }
            },
            include: salesInclude,
            order: [['sale_date', 'DESC']],
            limit: 10 // For recent sales
        });

        const todaysSalesTotal = todaysSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);
        const todaysTransactions = todaysSales.length;

        // Week's sales statistics
        const weekSales = await sale.findAll({
            where: {
                sale_date: {
                    [Op.between]: [startOfWeek, endOfToday]
                }
            },
            include: salesInclude
        });

        const weekSalesTotal = weekSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);

        // Month's sales statistics
        const monthSales = await sale.findAll({
            where: {
                sale_date: {
                    [Op.between]: [startOfMonth, endOfToday]
                }
            },
            include: salesInclude
        });

        const monthSalesTotal = monthSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);

        // Product statistics - count products available in this store
        const totalProducts = await productinventory.count({
            where: {
                store_id: filterStoreId
            },
            distinct: true,
            col: 'product_id'
        });

        // Inventory stats per current user's store
        const lowStockProducts = await productinventory.count({
            where: {
                store_id: filterStoreId,
                stock_quantity: {
                    [Op.between]: [1, 10]
                }
            }
        });

        const outOfStockProducts = await productinventory.count({
            where: {
                store_id: filterStoreId,
                stock_quantity: {
                    [Op.lte]: 0
                }
            }
        });

        // Customer statistics - count customers who have made purchases at this store
        const totalCustomers = await customer.count({
            include: [{
                model: sale,
                as: 'sales',
                include: [{
                    model: user,
                    as: 'cashier',
                    where: { store_id: filterStoreId },
                    attributes: [],
                    required: true
                }],
                attributes: [],
                required: true
            }],
            distinct: true
        });

        // Active users - users from this store who made sales today
        const activeUsers = await user.count({
            where: {
                store_id: filterStoreId
            },
            include: [{
                model: sale,
                as: 'sales',
                where: {
                    sale_date: {
                        [Op.between]: [startOfToday, endOfToday]
                    }
                },
                attributes: [],
                required: true
            }],
            distinct: true
        });

        // Top products (by quantity sold this month) - filtered by store
        const topProductsQuery = await saleitem.findAll({
            attributes: [
                'product_id',
                [fn('SUM', col('quantity')), 'total_quantity'],
                [fn('SUM', col('total_price')), 'total_revenue']
            ],
            include: [
                {
                    model: sale,
                    where: {
                        sale_date: {
                            [Op.between]: [startOfMonth, endOfToday]
                        }
                    },
                    include: [{
                        model: user,
                        as: 'cashier',
                        where: { store_id: filterStoreId },
                        attributes: [],
                        required: true
                    }],
                    attributes: []
                },
                {
                    model: product,
                    as: 'product',
                    attributes: ['name']
                }
            ],
            group: ['product_id', 'product.id', 'product.name'],
            order: [[fn('SUM', col('quantity')), 'DESC']],
            limit: 3,
            raw: false
        });

        // Format top products
        const topProducts = topProductsQuery.map(item => ({
            name: item.product.name,
            quantity: parseInt(item.dataValues.total_quantity),
            revenue: parseFloat(item.dataValues.total_revenue)
        }));

        // Recent sales (last 5 today's sales)
        const recentSalesData = todaysSales.slice(0, 5);
        const recentSales = await Promise.all(recentSalesData.map(async (s) => {
            // Get item count for this sale
            const itemCount = await saleitem.count({
                where: { sale_id: s.id }
            });

            return {
                time: new Date(s.sale_date).toLocaleTimeString('en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                }),
                amount: parseFloat(s.total_amount),
                items: itemCount,
                receipt_number: s.receipt_number,
                payment_method: s.payment_method
            };
        }));

        // Recent returns/credit notes (last 10) - filtered by store
        const recentReturnsData = await creditnote.findAll({
            limit: 10,
            order: [['createdAt', 'DESC']],
            include: [
                {
                    model: creditnoteitem,
                    as: 'items',
                    include: [{ model: product, as: 'product' }]
                },
                {
                    model: user,
                    as: 'cashier',
                    attributes: ['id', 'full_name', 'store_id'],
                    where: { store_id: filterStoreId },
                    required: true
                },
                { model: customer, as: 'customer' }
            ]
        });

        // Transform returns data to match expected format
        const recentReturns = recentReturnsData.map(creditNote => ({
            receipt_number: creditNote.receipt_number || creditNote.id?.toString() || '-',
            credit_note_number: creditNote.receipt_number,
            time: creditNote.createdAt?.toISOString() || '',
            timestamp: creditNote.createdAt?.toISOString() || '',
            created_at: creditNote.createdAt?.toISOString() || '',
            createdAt: creditNote.createdAt?.toISOString() || '',
            date: creditNote.createdAt?.toISOString() || '',
            refund_amount: parseFloat(creditNote.total_amount || 0),
            total_refund: parseFloat(creditNote.total_amount || 0),
            refund: parseFloat(creditNote.total_amount || 0),
            amount: parseFloat(creditNote.total_amount || 0),
            total: parseFloat(creditNote.total_amount || 0),
            grand_total: parseFloat(creditNote.total_amount || 0),
            items_count: creditNote.items ? creditNote.items.length : 0,
            itemsCount: creditNote.items ? creditNote.items.length : 0,
            items: creditNote.items ? creditNote.items.length : 0,
            quantity: creditNote.items ? creditNote.items.reduce((sum, item) => sum + (item.quantity || 0), 0) : 0
        }));

        // Calculate returns statistics - filtered by store
        const returnsStats = await creditnote.findAll({
            attributes: [
                [fn('COUNT', col('creditnote.id')), 'count'],
                [fn('SUM', col('creditnote.total_amount')), 'total']
            ],
            where: {
                createdAt: {
                    [Op.between]: [startOfToday, endOfToday]
                }
            },
            include: [{
                model: user,
                as: 'cashier',
                where: { store_id: filterStoreId },
                attributes: [],
                required: true
            }],
            raw: true
        });

        const totalReturnsToday = parseInt(returnsStats[0]?.count || 0);
        const totalReturnsAmount = parseFloat(returnsStats[0]?.total || 0);

        // Prepare response data
        const dashboardStats = {
            todaysSales: todaysSalesTotal,
            todaysTransactions: todaysTransactions,
            weekSales: weekSalesTotal,
            monthSales: monthSalesTotal,
            totalProducts: totalProducts,
            lowStockProducts: lowStockProducts,
            outOfStockProducts: outOfStockProducts,
            totalCustomers: totalCustomers,
            activeUsers: activeUsers,
            topProducts: topProducts,
            recentSales: recentSales,
            recentReturns: recentReturns,
            recentCreditNotes: recentReturns,
            recent_returns: recentReturns,
            totalReturnsToday: totalReturnsToday,
            totalReturnsAmount: parseFloat(totalReturnsAmount)
        };

        res.json({
            success: true,
            data: dashboardStats,
            timestamp: new Date().toISOString()
        });

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

        // Calculate statistics for the period
        const totalSales = periodSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);
        const totalTransactions = periodSales.length;
        const averageTransaction = totalTransactions > 0 ? totalSales / totalTransactions : 0;

        // Payment method breakdown
        const paymentMethods = {
            cash: 0,
            card: 0,
            mobile_money: 0
        };

        periodSales.forEach(sale => {
            if (paymentMethods.hasOwnProperty(sale.payment_method)) {
                paymentMethods[sale.payment_method] += parseFloat(sale.total_amount || 0);
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