const express = require('express');
const { sale, saleitem, product, user, customer, discount, store, productinventory, creditnoteitem} = require('../models');
const auth = require('../middleware/auth');
const { Op, sequelize, fn, col, literal } = require('sequelize');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const logger = require('../utils/logger');

const router = express.Router();
const siteId = process.env.SITE_ID || 'unknown-site';

// Import the correct ZRA Integration Service
const ZRAIntegrationService = require('../services/sale/generateSmartInvoice');

// Generate invoice number from SDC ID and receipt number
function generateInvoiceNumber(sdcid, receipt_no) {
    return "INV" + sdcid.substring(3) + "/" + receipt_no;
}
function getBaseDir() {
  // When bundled with pkg / nexe, process.pkg is defined
  if (process.pkg) {
    return path.dirname(process.execPath);
  }
  // In dev: use current working dir (where you run `node server.js`)
  return process.cwd();
}
// Generate QR Code and save to file
async function generateQrCode(qrcode_url, receiptNo) {
    try {
        const baseDir = getBaseDir();
        const saveDirectory = path.join(baseDir, 'qrcodes');

        if (!fs.existsSync(saveDirectory)) {
            fs.mkdirSync(saveDirectory, { recursive: true });
        }

        const fileName = `qrcode_${receiptNo}.png`;
        const filePath = path.join(saveDirectory, fileName);

        await QRCode.toFile(filePath, qrcode_url, {
            width: 150,
            margin: 2,
        });

        logger.info('qrcode_generated', {
            siteId,
            receiptNo,
            filePath
        });

        return filePath;
    } catch (err) {
        logger.error('qrcode_generation_error', {
            siteId,
            receiptNo,
            error: err.message,
            stack: err.stack
        });
        throw err;
    }
}
// Create new sale
router.post('/', auth, async (req, res) => {
    const startedAt = new Date();
    const t = await sale.sequelize.transaction();

    logger.info('sale_creation_started', {
        siteId,
        userId: req.user?.id,
        storeId: req.user?.store_id,
        itemsCount: req.body.items?.length,
        customerId: req.body.customer_id,
        discountId: req.body.discount_id,
        paymentMethod: req.body.payment_method,
        startedAt
    });

    try {
        const {
            items,
            customer_id,
            discount_id,
            payment_method,
            amount_paid,
            payments,
            tax_rate = 16,
            notes
        } = req.body;

        // Validate items
        if (!items || items.length === 0) {
            await t.rollback();
            logger.warn('sale_no_items', {
                siteId,
                userId: req.user?.id,
                storeId: req.user?.store_id
            });
            return res.status(400).json({ message: 'Sale must have at least one item' });
        }

        // Validate user has store_id
        if (!req.user.store_id) {
            await t.rollback();
            logger.warn('sale_no_store', {
                siteId,
                userId: req.user?.id
            });
            return res.status(400).json({ message: 'User must be associated with a store' });
        }

        logger.info('sale_items_validation_started', {
            siteId,
            itemsCount: items.length,
            taxRate: tax_rate
        });

        // Calculate totals
        let subtotal = 0;
        const saleItems = [];

        // Validate and calculate each item
        for (const item of items) {
            const productData = await product.findByPk(item.product_id, { transaction: t });

            if (!productData) {
                await t.rollback();
                logger.warn('sale_product_not_found', {
                    siteId,
                    userId: req.user?.id,
                    productId: item.product_id
                });
                return res.status(400).json({ message: `Product with ID ${item.product_id} not found` });
            }

            // Check stock from productinventory for the user's store
            const inventory = await productinventory.findOne({
                where: { product_id: item.product_id, store_id: req.user.store_id },
                transaction: t
            });

            const availableQty = inventory ? inventory.stock_quantity : 0;

            // Log stock status
            logger.debug('sale_item_stock_check', {
                productId: item.product_id,
                requestedQty: item.quantity,
                availableQty
            });

            // Determine effective price
            const effectiveUnitPrice = inventory && inventory.price_override != null
                ? Number(inventory.price_override)
                : Number(productData.price);

            const unit_price_inclusive = (item.unit_price == null || item.unit_price === '')
                ? effectiveUnitPrice
                : Number(item.unit_price);

            // Derive tax-exclusive values from tax-inclusive unit price
            const taxMultiplier = 1 + (Number(tax_rate) / 100);
            const unit_price_exclusive = unit_price_inclusive / taxMultiplier;

            const tax_exclusive_total = item.quantity * unit_price_exclusive;
            const tax_inclusive_total = item.quantity * unit_price_inclusive;

            subtotal += tax_exclusive_total;

            saleItems.push({
                product_id: item.product_id,
                quantity: item.quantity,
                unit_price: unit_price_inclusive,
                total_price: tax_inclusive_total,
                tax_exclusive_total,
                product: productData
            });

            logger.debug('sale_item_processed', {
                siteId,
                productId: item.product_id,
                productName: productData.name,
                quantity: item.quantity,
                unitPriceInclusive: unit_price_inclusive,
                totalPrice: tax_inclusive_total
            });
        }

        logger.info('sale_items_validated', {
            siteId,
            itemsCount: saleItems.length,
            subtotal
        });

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
                logger.info('sale_discount_applied', {
                    siteId,
                    discountId: discount_id,
                    discountType: discountData.type,
                    discountValue: discountData.value,
                    discountAmount
                });
            }
        }

        // Calculate tax and total
        const tax_amount = Math.round(((subtotal - discount_amount) * tax_rate) / 100 * 100) / 100;
        const total_amount = Math.round((subtotal - discount_amount + tax_amount) * 100) / 100;

        // Handle payments breakdown
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
            const entries = Object.entries(bd).filter(([k, v]) => v > 0);
            if (entries.length > 0) {
                payments_breakdown_obj = Object.fromEntries(entries);
                const sum = entries.reduce((s, [, v]) => s + v, 0);
                effective_amount_paid = Math.round(sum * 100) / 100;
                effective_payment_method = entries.length > 1 ? 'mixed' : entries[0][0];

                logger.info('sale_mixed_payment', {
                    siteId,
                    paymentMethods: entries.map(([k]) => k),
                    breakdown: payments_breakdown_obj,
                    totalPaid: effective_amount_paid
                });
            }
        }

        const change_amount = Math.round((effective_amount_paid - total_amount) * 100) / 100;

        // If mixed payment, subtract change from cash part
        if (effective_payment_method === 'mixed' && payments_breakdown_obj && payments_breakdown_obj.cash && change_amount > 0) {
            payments_breakdown_obj.cash = Math.round((Number(payments_breakdown_obj.cash) - change_amount) * 100) / 100;
            // If cash goes negative (e.g. they paid more in card than total), set it to 0
            if (payments_breakdown_obj.cash < 0) payments_breakdown_obj.cash = 0;
            
            // Clean up if cash becomes 0
            if (payments_breakdown_obj.cash === 0) {
                delete payments_breakdown_obj.cash;
                const entries = Object.entries(payments_breakdown_obj);
                if (entries.length === 1) {
                    effective_payment_method = entries[0][0];
                } else if (entries.length === 0) {
                    // Should not happen if change < amount paid
                    effective_payment_method = 'cash'; 
                }
            }
        }

        if (change_amount < 0) {
            await t.rollback();
            logger.warn('sale_insufficient_payment', {
                siteId,
                userId: req.user?.id,
                totalAmount: total_amount,
                amountPaid: effective_amount_paid,
                shortfall: Math.abs(change_amount)
            });
            return res.status(400).json({ message: 'Insufficient payment amount' });
        }

        logger.info('sale_totals_calculated', {
            siteId,
            subtotal,
            discountAmount: discount_amount,
            taxAmount: tax_amount,
            totalAmount: total_amount,
            amountPaid: effective_amount_paid,
            changeAmount: change_amount
        });

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
        logger.info('sale_zra_submission_started', {
            siteId,
            userId: req.user?.id,
            totalAmount: total_amount,
            itemsCount: saleItems.length
        });

        const zraService = new ZRAIntegrationService();

        let zraFailed = false;
        let zraError = null;
        let saveSalesData = null;

        // Process ZRA Sales endpoint first
        const salesData = await zraService.transformToZRASalesData(saleDataForZRA, saleItems, req.user);
        const salesResponse = await zraService.sendSalesData(salesData);

        if (!salesResponse.success) {
            zraFailed = true;
            logger.error('sale_zra_failed', {
                siteId,
                userId: req.user?.id,
                storeId: req.user?.store_id,
                error: salesResponse.error,
                totalAmount: total_amount
            });
            zraError = typeof salesResponse.error === 'string' ? salesResponse.error : JSON.stringify(salesResponse.error);
        } else {
            logger.info('sale_zra_success', {
                siteId,
                userId: req.user?.id,
                salesDataKeys: Object.keys(salesResponse.data.data || {}),
                totalAmount: total_amount
            });
            saveSalesData = salesResponse.data.data || null;
        }

        // Generate QR code
        let qrFilePath = null;
        if (saveSalesData && saveSalesData.qrCodeUrl && saveSalesData.rcptNo) {
            try {
                qrFilePath = await generateQrCode(
                    saveSalesData.qrCodeUrl,
                    saveSalesData.rcptNo
                );
            } catch (qrError) {
                logger.error('sale_qrcode_failed', {
                    siteId,
                    userId: req.user?.id,
                    rcptNo: saveSalesData.rcptNo,
                    error: qrError.message
                });
            }
        }

        logger.info('sale_record_creation_started', {
            siteId,
            userId: req.user?.id,
            zraStatus: zraFailed ? 'pending' : 'sent'
        });

        // Helper to safely limit string lengths
        const limitStr = (v, n) => (v == null ? null : String(v).slice(0, n));

        // Generate incremental receipt number per store
        const receiptNumber = await zraService.generateReceiptNumber(req.user.store_id);

        // Extract ZRA values
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

        // Create sale
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
            invnumber: limitStr(zraInvNumberRaw, 50),
            receipt_no: limitStr(zraReceiptNoRaw, 50),
            sdcid: limitStr(zraSdcIdRaw, 50),
            receiptsig: limitStr(zraRcptSignRaw, 50),
            intrldata: limitStr(zraIntrlDataRaw, 100),
            qrcode_url: limitStr(zraQrUrlRaw, 255),
            vsdcrcpdate: limitStr(zraVsdcDateRaw, 100),
            invoice_no: limitStr(computedInvoiceNoRaw, 100),
            qrfilepath: limitStr(qrFilePath, 255),
            zra_status: zraFailed ? 'pending' : 'sent',
            zra_error: zraFailed ? zraError : null,
            retry_count: 0,
            next_retry_at: zraFailed ? new Date(Date.now() + 2 * 60 * 1000) : null,
            last_retry_at: null,
        }, { transaction: t });

        logger.info('sale_record_created', {
            siteId,
            saleId: newSale.id,
            receiptNumber: newSale.receipt_number,
            totalAmount: newSale.total_amount,
            zraStatus: newSale.zra_status
        });

        // Create sale items and update stock
        for (const item of saleItems) {
            await saleitem.create({
                sale_id: newSale.id,
                product_id: item.product_id,
                quantity: item.quantity,
                unit_price: item.unit_price,
                total_price: item.total_price
            }, { transaction: t });

            await productinventory.update(
                {
                    stock_quantity: literal(`stock_quantity - ${item.quantity}`)
                },
                {
                    where: { product_id: item.product_id, store_id: req.user.store_id },
                    transaction: t
                }
            );

            logger.debug('sale_stock_updated', {
                siteId,
                saleId: newSale.id,
                productId: item.product_id,
                quantityReduced: item.quantity
            });
        }

        await t.commit();

        logger.info('sale_transaction_committed', {
            siteId,
            saleId: newSale.id,
            receiptNumber: newSale.receipt_number
        });

        // Fetch complete sale data for response
        const completeSale = await sale.findByPk(newSale.id, {
            include: [
                {
                    model: saleitem,
                    as: 'items',
                    include: [{ model: product, as: 'product' }]
                },
                {
                    model: user,
                    as: 'cashier',
                    attributes: ['id', 'full_name'],
                    include: [{ model: store, as: 'store', attributes: ['store_location', 'store_mobile_no'] }]
                },
                { model: customer, as: 'customer' },
                { model: discount, as: 'discount' }
            ]
        });

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('sale_completed', {
            siteId,
            saleId: newSale.id,
            receiptNumber: newSale.receipt_number,
            userId: req.user?.id,
            storeId: req.user?.store_id,
            totalAmount: total_amount,
            itemsCount: saleItems.length,
            zraStatus: newSale.zra_status,
            durationMs
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

        // Process stock endpoints in the background only if ZRA succeeded
        if (!zraFailed) {
            processStockEndpointsInBackground(newSale.id, saleDataForZRA, saleItems, req.user, zraService);
        }

    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        await t.rollback();

        logger.error('sale_error', {
            siteId,
            userId: req.user?.id,
            storeId: req.user?.store_id,
            error: error.message,
            stack: error.stack,
            errorName: error.name,
            durationMs
        });

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
 */
async function processStockEndpointsInBackground(saleId, saleData, items, user, zraService) {
    const NotificationService = require('../services/NotificationService');
    const notificationService = new NotificationService();

    logger.info('sale_stock_endpoints_background_started', {
        siteId,
        saleId,
        userId: user?.id
    });

    try {
        // Transform data for stock endpoints
        const stockItemsData = zraService.transformToZRAStockItemsData(saleData, items, user);
        const stockMasterData = await zraService.transformToZRAStockMasterData(items, user);

        logger.info('sale_stock_data_transformed', {
            siteId,
            saleId,
            stockItemsCount: stockItemsData?.length || 0
        });

        // Process stock items endpoint
        const stockItemsResponse = await zraService.sendStockItemsData(stockItemsData);

        if (!stockItemsResponse.success) {
            logger.error('sale_stock_items_failed', {
                siteId,
                saleId,
                userId: user?.id,
                error: stockItemsResponse.error
            });

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
            logger.info('sale_stock_items_success', {
                siteId,
                saleId,
                userId: user?.id
            });
        }

        // Process stock master endpoint
        // Check if any item's stock level is below its minimum stock level
        let belowMinimum = false;
        for (const item of items) {
            const productId = item.product_id || item.product?.id;
            const storeId = user?.store_id;
            
            if (productId && storeId) {
                const inv = await productinventory.findOne({
                    where: { product_id: productId, store_id: storeId }
                });
                
                const currentStock = inv?.stock_quantity ?? 0;
                const minStock = inv?.min_stock_level ?? 0;
                
                if (currentStock < minStock) {
                    belowMinimum = true;
                    logger.info('sale_stock_below_minimum', {
                        productId,
                        storeId,
                        currentStock,
                        minStock
                    });
                    break;
                }
            }
        }

        let stockMasterResponse = { success: true, skipped: false };
        if (!belowMinimum) {
            stockMasterResponse = await zraService.sendStockMasterData(stockMasterData);
        } else {
            logger.info('sale_stock_master_skipped', {
                saleId,
                message: 'Skipping ZRA stock master update because stock levels are below minimum'
            });
            stockMasterResponse.skipped = true;
        }

        if (!stockMasterResponse.success) {
            logger.error('sale_stock_master_failed', {
                siteId,
                saleId,
                userId: user?.id,
                error: stockMasterResponse.error
            });

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
            logger.info('sale_stock_master_success', {
                siteId,
                saleId,
                userId: user?.id
            });
        }

        // Create success notification if both succeeded or one was skipped
        if (stockItemsResponse.success && (stockMasterResponse.success || stockMasterResponse.skipped)) {
            await notificationService.createNotification({
                type: 'ZRA_INTEGRATION_COMPLETE',
                title: 'ZRA Integration Complete',
                message: stockMasterResponse.skipped 
                    ? `ZRA Sales and Stock Items processed successfully for sale #${saleId}. Stock Master update was skipped due to low stock levels.`
                    : `All ZRA endpoints processed successfully for sale #${saleId}`,
                severity: stockMasterResponse.skipped ? 'warning' : 'success',
                user_id: user.id,
                metadata: {
                    sale_id: saleId,
                    all_endpoints_success: !stockMasterResponse.skipped,
                    stock_master_skipped: stockMasterResponse.skipped
                }
            });

            logger.info('sale_zra_integration_complete', {
                siteId,
                saleId,
                userId: user?.id
            });
        }

    } catch (error) {
        logger.error('sale_stock_endpoints_error', {
            siteId,
            saleId,
            userId: user?.id,
            error: error.message,
            stack: error.stack
        });

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

// Get all sales with pagination and search
// GET /sales - paginated list with full search & filter support
router.get('/', auth, async (req, res) => {
    const startedAt = new Date();

    try {
        const page        = parseInt(req.query.page)   || 1;
        const limit       = parseInt(req.query.limit)  || 20;
        const offset      = (page - 1) * limit;
        const filterStoreId = req.user.store_id;

        // Search / filter params
        const receipt_no  = req.query.q?.trim()              || null;
        const start_date  = req.query.start_date             || null;
        const end_date    = req.query.end_date               || null;
        const start_time  = req.query.start_time             || null; // "HH:MM"
        const end_time    = req.query.end_time               || null; // "HH:MM"
        const min_amount  = parseFloat(req.query.min_amount) || null;
        const max_amount  = parseFloat(req.query.max_amount) || null;

        logger.info('sales_list_started', {
            siteId,
            userId: req.user?.id,
            storeId: filterStoreId,
            page,
            limit,
            receipt_no,
            start_date,
            end_date,
            start_time,
            end_time,
            min_amount,
            max_amount,
            startedAt
        });

        const where = {};

        // ── Date + time range ───────────────────────────────────────────────
        if (start_date || end_date) {
            // Validate ordering before building the clause
            if (start_date && end_date && new Date(end_date) < new Date(start_date)) {
                return res.status(400).json({ message: 'End date cannot be before start date' });
            }

            where.sale_date = {};

            if (start_date) {
                // If a start_time is provided, combine it with the date; otherwise use start of day
                const startDateTime = start_time
                    ? new Date(`${new Date(start_date).toISOString().split('T')[0]}T${start_time}:00.000Z`)
                    : new Date(start_date);
                where.sale_date[Op.gte] = startDateTime;
            }

            if (end_date) {
                // If an end_time is provided, combine it with the date; otherwise use end of day (set by Flutter: 23:59:59.999)
                const endDateTime = end_time
                    ? new Date(`${new Date(end_date).toISOString().split('T')[0]}T${end_time}:59.999Z`)
                    : new Date(end_date);
                where.sale_date[Op.lte] = endDateTime;
            }
        } else if (start_time || end_time) {
            // Time filter with no date: apply today's date as the anchor
            const todayStr = new Date().toISOString().split('T')[0];
            where.sale_date = {};
            if (start_time) {
                where.sale_date[Op.gte] = new Date(`${todayStr}T${start_time}:00.000Z`);
            }
            if (end_time) {
                where.sale_date[Op.lte] = new Date(`${todayStr}T${end_time}:59.999Z`);
            }
        }

        // ── Amount range ────────────────────────────────────────────────────
        if (min_amount !== null || max_amount !== null) {
            where.total_amount = {};
            if (min_amount !== null) where.total_amount[Op.gte] = min_amount;
            if (max_amount !== null) where.total_amount[Op.lte] = max_amount;
        }

        // ── Free-text search ────────────────────────────────────────────────
        if (receipt_no) {
            const searchTerms = `%${receipt_no}%`;
            where[Op.or] = [
                { receipt_number: { [Op.like]: searchTerms } },
                { receipt_no:     { [Op.like]: searchTerms } },
                { invoice_no:     { [Op.like]: searchTerms } },
                { notes:          { [Op.like]: searchTerms } },
                { payment_method: { [Op.like]: searchTerms } },
                literal(`cashier.full_name LIKE ${sequelize.escape(searchTerms)}`),
                literal(`cashier.username  LIKE ${sequelize.escape(searchTerms)}`),
                literal(`EXISTS (
                    SELECT 1 FROM sale_items si
                    JOIN products p ON si.product_id = p.id
                    WHERE si.sale_id = \`sale\`.\`id\`
                      AND (p.name LIKE ${sequelize.escape(searchTerms)}
                        OR p.sku  LIKE ${sequelize.escape(searchTerms)})
                )`)
            ];
        }

        // ── Associations ────────────────────────────────────────────────────
        const userInclude = {
            model: user,
            as: 'cashier',
            attributes: ['id', 'full_name', 'store_id', 'username'],
            ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {})
        };

        const include = [
            userInclude,
            { model: customer,  as: 'customer' },
            { model: discount,  as: 'discount' },
            {
                model: saleitem,
                as: 'items',
                include: [{ model: product, as: 'product' }]
            }
        ];

        // ── Query ───────────────────────────────────────────────────────────
        const { count, rows } = await sale.findAndCountAll({
            where,
            limit,
            offset,
            order: [['sale_date', 'DESC']],
            include,
            distinct: true  // required when including hasMany with limit/offset
        });

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('sales_list_completed', {
            siteId,
            userId: req.user?.id,
            storeId: filterStoreId,
            totalRecords: count,
            returnedRecords: rows.length,
            page,
            durationMs
        });

        res.json({
            sales: rows,
            pagination: {
                current_page:  page,
                total_pages:   Math.ceil(count / limit),
                total_records: count,
                per_page:      limit
            }
        });

    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('sales_list_error', {
            siteId,
            userId: req.user?.id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});
// Mark a sale as receipt printed (idempotent)
router.post('/:id/mark-printed', auth, async (req, res) => {
    const startedAt = new Date();

    try {
        const id = req.params.id;

        logger.info('sale_mark_printed_started', {
            siteId,
            saleId: id,
            userId: req.user?.id,
            startedAt
        });

        const saleData = await sale.findByPk(id, {
            include: [
                { model: user, as: 'cashier', attributes: ['id', 'store_id'] }
            ]
        });

        if (!saleData) {
            logger.warn('sale_mark_printed_not_found', {
                siteId,
                saleId: id,
                userId: req.user?.id
            });
            return res.status(404).json({ message: 'Sale not found' });
        }

        // Enforce store access
        if (req.user && (req.user.role === 'cashier' || req.user.role === 'admin')) {
            const cashierStoreId = saleData.cashier && saleData.cashier.store_id;
            if (!cashierStoreId || cashierStoreId !== req.user.store_id) {
                logger.warn('sale_mark_printed_unauthorized', {
                    siteId,
                    saleId: id,
                    userId: req.user?.id,
                    userStoreId: req.user.store_id,
                    saleStoreId: cashierStoreId
                });
                return res.status(403).json({ message: 'Access denied' });
            }
        }

        const wasPrinted = !!saleData.receipt_printed;
        if (!wasPrinted) {
            saleData.receipt_printed = true;
            await saleData.save();
        }

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('sale_mark_printed_completed', {
            siteId,
            saleId: id,
            userId: req.user?.id,
            wasPrinted,
            durationMs
        });

        return res.json({
            sale: saleData,
            updated: !wasPrinted,
            message: wasPrinted ? 'Already marked as printed' : 'Marked as printed'
        });
    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('sale_mark_printed_error', {
            siteId,
            saleId: req.params.id,
            userId: req.user?.id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

// Get sales by date range
router.get('/report/date-range', auth, async (req, res) => {
    const startedAt = new Date();

    try {
        const { start_date, end_date } = req.query;

        logger.info('sales_date_range_report_started', {
            siteId,
            userId: req.user?.id,
            storeId: req.user?.store_id,
            startDate: start_date,
            endDate: end_date,
            startedAt
        });

        if (!start_date || !end_date) {
            await t.rollback();
            logger.warn('sales_date_range_missing_params', {
                siteId,
                userId: req.user?.id
            });
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        // Validate date format
        const startDate = new Date(start_date);
        const endDate = new Date(end_date);

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            logger.warn('sales_date_range_invalid_format', {
                siteId,
                userId: req.user?.id,
                startDate: start_date,
                endDate: end_date
            });
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
            const bd = s.payments_breakdown;
            const changeAmount = Number(s.change_amount || 0);
            if (bd && typeof bd === 'object') {
                Object.entries(bd).forEach(([method, amt]) => {
                    const key = method || 'unknown';
                    let finalAmt = Number(amt || 0);
                    if (s.payment_method === 'mixed' && key === 'cash' && changeAmount > 0) {
                        finalAmt = Math.max(0, finalAmt - changeAmount);
                    }
                    summary.payment_methods[key] = (summary.payment_methods[key] || 0) + finalAmt;
                });
            } else {
                const method = s.payment_method || 'unknown';
                summary.payment_methods[method] = (summary.payment_methods[method] || 0) + parseFloat(s.total_amount || 0);
            }
        });

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('sales_date_range_report_completed', {
            siteId,
            userId: req.user?.id,
            storeId: filterStoreId,
            startDate: start_date,
            endDate: end_date,
            salesCount: sales.length,
            totalRevenue: summary.total_revenue,
            durationMs
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
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('sales_date_range_report_error', {
            siteId,
            userId: req.user?.id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

// Get daily sales summary
router.get('/report/daily', auth, async (req, res) => {
    const startedAt = new Date();

    try {
        const today = new Date();
        const startOfDay = new Date(today.setHours(0, 0, 0, 0));
        const endOfDay = new Date(today.setHours(23, 59, 59, 999));

        const isAdmin = req.user && req.user.role === 'admin';
        const filterStoreId = isAdmin ? (parseInt(req.query.store_id) || null) : req.user.store_id;

        logger.info('sales_daily_report_started', {
            siteId,
            userId: req.user?.id,
            storeId: filterStoreId,
            isAdmin,
            startedAt
        });

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
            payment_summary: (() => {
                const totals = { cash: 0, card: 0, mobile_money: 0 };
                todaySales.forEach(s => {
                    const bd = s.payments_breakdown;
                    const changeAmount = Number(s.change_amount || 0);
                    if (bd && typeof bd === 'object') {
                        Object.entries(bd).forEach(([method, amt]) => {
                            if (totals.hasOwnProperty(method)) {
                                let finalAmt = Number(amt || 0);
                                if (s.payment_method === 'mixed' && method === 'cash' && changeAmount > 0) {
                                    finalAmt = Math.max(0, finalAmt - changeAmount);
                                }
                                totals[method] += finalAmt;
                            }
                        });
                    } else if (totals.hasOwnProperty(s.payment_method)) {
                        totals[s.payment_method] += Number(s.total_amount || 0);
                    }
                });
                return totals;
            })()
        };

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('sales_daily_report_completed', {
            siteId,
            userId: req.user?.id,
            storeId: filterStoreId,
            date: startOfDay.toDateString(),
            totalSales: summary.total_sales,
            totalRevenue: summary.total_revenue,
            durationMs
        });

        res.json({ summary });

    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('sales_daily_report_error', {
            siteId,
            userId: req.user?.id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

// Get dashboard statistics
router.get('/dashboard/stats', auth, async (req, res) => {
    const startedAt = new Date();

    try {
        logger.info('sales_dashboard_stats_started', {
            siteId,
            userId: req.user?.id,
            storeId: req.user?.store_id,
            startedAt
        });

        const { computeDashboardStats } = require('../services/reports/dashboardStats');
        const data = await computeDashboardStats(req);

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('sales_dashboard_stats_completed', {
            siteId,
            userId: req.user?.id,
            storeId: req.user?.store_id,
            dataKeys: Object.keys(data || {}),
            durationMs
        });

        res.json({ success: true, data, timestamp: new Date().toISOString() });
    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('sales_dashboard_stats_error', {
            siteId,
            userId: req.user?.id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({
            success: false,
            message: 'Failed to load dashboard statistics',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// Get dashboard statistics with date filter
router.get('/dashboard/stats/:period', auth, async (req, res) => {
    const startedAt = new Date();

    try {
        const { period } = req.params;

        logger.info('sales_period_stats_started', {
            siteId,
            userId: req.user?.id,
            storeId: req.user?.store_id,
            period,
            startedAt
        });

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
                logger.warn('sales_period_stats_invalid_period', {
                    siteId,
                    userId: req.user?.id,
                    period
                });
                return res.status(400).json({
                    success: false,
                    message: 'Invalid period. Use: today, week, month, or year'
                });
        }

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

        const totalSales = periodSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);
        const totalTransactions = periodSales.length;
        const averageTransaction = totalTransactions > 0 ? totalSales / totalTransactions : 0;

        const paymentMethods = {
            cash: 0,
            card: 0,
            mobile_money: 0
        };

        periodSales.forEach(s => {
            const bd = s.payments_breakdown;
            const changeAmount = Number(s.change_amount || 0);
            if (bd && typeof bd === 'object') {
                Object.entries(bd).forEach(([method, amt]) => {
                    if (paymentMethods.hasOwnProperty(method)) {
                        let finalAmt = Number(amt || 0);
                        if (s.payment_method === 'mixed' && method === 'cash' && changeAmount > 0) {
                            finalAmt = Math.max(0, finalAmt - changeAmount);
                        }
                        paymentMethods[method] += finalAmt;
                    }
                });
            } else if (paymentMethods.hasOwnProperty(s.payment_method)) {
                paymentMethods[s.payment_method] += parseFloat(s.total_amount || 0);
            }
        });

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('sales_period_stats_completed', {
            siteId,
            userId: req.user?.id,
            storeId: filterStoreId,
            period,
            totalTransactions,
            totalSales,
            durationMs
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
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('sales_period_stats_error', {
            siteId,
            userId: req.user?.id,
            period: req.params.period,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({
            success: false,
            message: 'Failed to load period statistics',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

module.exports = router;