const express = require('express');
const { sale, saleitem, product, user, customer, discount, store } = require('../models');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { body, validationResult } = require('express-validator');
const ZRAService = require('../services/zraService');
const ZRAIntegrationService = require('../services/generateSmartInvoice'); // Adjust path as needed
const SageShipment = require('../services/createSageShipment');
const AccountsReceivableBatch = require("../services/createSageArBatch");
const router = express.Router();

// Generate sequential receipt number and unique invoice number
async function generateInvoiceAndReceiptNumber(storeId) {
    const lastSale = await sale.findOne({
        where: { store_id: storeId },
        order: [['id', 'DESC']],
    });

    let nextSeq ;
    if (lastSale && lastSale.receipt_number) {
        nextSeq = parseInt(lastSale.receipt_number, 10) + 1;
    }
    const receiptNumber = String(nextSeq).padStart(6, '0');
    const timestamp = Date.now().toString();
    const invoiceNo = `INV${storeId.toString().padStart(3, '0')}${timestamp}/${receiptNumber}`;
    return { receiptNumber, invoiceNo };
}

// Generate QR code locally
async function generateQrCode(data, identifier, saveDirectory) {
    try {
        const qrData = typeof data === 'string' ? data : JSON.stringify(data);

        if (!fs.existsSync(saveDirectory)) fs.mkdirSync(saveDirectory, { recursive: true });

        const safeId = identifier.replace(/[^a-zA-Z0-9_-]/g, '_');
        const fileName = `qrcode_${safeId}_${Date.now()}.png`;
        const filePath = path.join(saveDirectory, fileName);
        const publicUrl = `/qrcodes/${fileName}`;

        await QRCode.toFile(filePath, qrData, { width: 150, margin: 2, errorCorrectionLevel: 'H' });

        return { filePath, publicUrl };
    } catch (err) {
        console.error('QR code generation failed:', err);
        throw err;
    }
}

// Validation Rules
const validateSale = [
    body('items').isArray({ min: 1 }).withMessage('Sale must have at least one item'),
    body('items.*.product_id').isInt({ min: 1 }).withMessage('Invalid product ID'),
    body('items.*.quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be at least 0.01'),
    body('items.*.unit_price').isFloat({ min: 0 }).withMessage('Unit price must be non-negative'),
    body('customer_id').optional().isInt({ min: 1 }).withMessage('Invalid customer ID'),
    body('discount_id').optional().isInt({ min: 1 }).withMessage('Invalid discount ID'),
    body('payment_method').isIn(['cash', 'card', 'mobile_money']).withMessage('Invalid payment method'),
    body('amount_paid').isFloat({ min: 0 }).withMessage('Amount paid must be non-negative'),
    body('tax_rate').optional().isFloat({ min: 0, max: 100 }).withMessage('Tax rate must be between 0 and 100'),
    body('notes').optional().isString().trim().isLength({ max: 1000 }).withMessage('Notes must be less than 1000 characters')
];

// POST /sales - Create Sale
router.post('/', auth,  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
    
    const t = await sale.sequelize.transaction();

    try {
        const {
            items,
            customer_id,
            discount_id,
            payment_method,
            amount_paid,
            tax_rate = 16,
            notes
        } = req.body;

        if (!req.user.store_id) {
            await t.rollback();
            return res.status(400).json({ message: 'User must be associated with a store' });
        }

        const storeConfig = await store.findByPk(req.user.store_id, { transaction: t });
        if (!storeConfig) {
            await t.rollback();
            return res.status(400).json({ message: 'Store configuration not found' });
        }

        /* const isZRAEnabled = storeConfig.zra_enabled === 1;
         if (isZRAEnabled && (!storeConfig.store_identifier || !storeConfig.zra_tpin || !storeConfig.zra_bhf_id)) {
             console.error('❌ ZRA config missing:', storeConfig);
             await t.rollback();
             return res.status(400).json({ message: 'Missing ZRA configuration (SDC ID, TPIN, or BHF ID)' });
         }*/

        // Generate invoice & receipt
        const { receiptNumber, invoiceNo } = await generateInvoiceAndReceiptNumber(req.user.store_id);

        // Calculate totals with safe rounding
        let subtotal = 0;
        const saleItems = [];

        for (const item of items) {
            console.log('Processing item:', item);
            const productData = await product.findByPk(item.product_id, { transaction: t });
            if (!productData) {
                await t.rollback();
                return res.status(400).json({ message: `Product with ID ${item.product_id} not found` });
            }

            if (productData.stock_quantity < item.quantity) {
                console.error(`❌ Insufficient stock for ${productData.name}. Available: ${productData.stock_quantity}`);
                await t.rollback();
                return res.status(400).json({
                    message: `Insufficient stock for ${productData.name}. Available: ${productData.stock_quantity}`
                });
            }

              // Unit price is tax-exclusive, calculate tax-inclusive total
            const tax_exclusive_total = item.quantity * item.unit_price;
            const item_tax_amount = (tax_exclusive_total * (16 /100)); //tax rate is 0.16 for 16%
            const tax_inclusive_total = tax_exclusive_total + item_tax_amount;

            subtotal += tax_exclusive_total; // Subtotal remains tax-exclusive

            // Include product data for ZRA integration
            saleItems.push({
                product_id: item.product_id,
                quantity: item.quantity,
                unit_price: item.unit_price, // Tax-exclusive unit price
                tax_exclusive_total: tax_exclusive_total, // Tax-exclusive total
                tax_inclusive_total: tax_inclusive_total, // Tax-inclusive total for ZRA
                product: productData // Include full product data
            });
        }
        console.log(saleItems)
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
        const tax_amount = (subtotal - discount_amount) * (tax_rate/100)
        const total_amount = subtotal - discount_amount + tax_amount;
        const change_amount = amount_paid - total_amount;
        if (change_amount < 0) {
            console.error(`❌ Insufficient payment. Paid: ${amount_paid_rounded}, total: ${total_amount}`);
            await t.rollback();
            return res.status(400).json({ message: 'Insufficient payment amount' });
        }

        const customerData = customer_id ? await customer.findByPk(customer_id, { transaction: t }) : null;

        const saleDataForZRA = {
            subtotal,
            discount_amount,
            tax_amount,
            total_amount,
            tax_rate,
            payment_method,
            amount_paid: amount_paid,
            change_amount, notes,
            customer: customerData,
            discount: discountData,
            invoice_number: invoiceNo,

        };
        const zraService = new ZRAIntegrationService();

        console.log('Processing ZRA sale endpoint...');

        // Process only the ZRA Sales endpoint first
        const salesData = await zraService.transformToZRASalesData(saleDataForZRA, saleItems, req.user);
        const salesResponse = await zraService.sendSalesData(salesData);
        console.log('ZRA Sales Response:', salesResponse);
        // Check if ZRA sales integration was successful
        if (!salesResponse.success) {
            await t.rollback();
            console.error('ZRA Sales Integration failed:', salesResponse.error);

            return res.status(500).json({
                message: 'Failed to process sale with ZRA system',
                zra_errors: [salesResponse.error],
                details: 'The sale could not be completed due to ZRA sales integration issues'
            });
        }

        console.log('ZRA sales integration successful:', salesResponse.data);

        // Get the data from the saveSales response
        const saveSalesData = salesResponse.data.data;

        if (!saveSalesData) {
            await t.rollback();
            return res.status(500).json({
                message: 'No data received from ZRA saveSales endpoint'
            });
        }

        console.log('ZRA Sales Data:', saveSalesData);

        // Generate QR code file path (but don't await it here to avoid blocking)
        let qrFilePath = null;
        if (saveSalesData.qrCodeUrl && saveSalesData.rcptNo) {
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



        // Create sale with rounded totals
        const newSale = await sale.create({
            receipt_number: receiptNumber,
            user_id: req.user.id,
            customer_id: customer_id || null,
            discount_id: discount_id || null,
            subtotal: parseFloat(subtotal.toFixed(2)),
            discount_amount: parseFloat(discount_amount.toFixed(2)),
            tax_amount: parseFloat(tax_amount.toFixed(2)),
            total_amount: parseFloat(total_amount.toFixed(2)),
            payment_method,
            amount_paid: parseFloat(amount_paid_rounded.toFixed(2)),
            change_amount: parseFloat(change_amount.toFixed(2)),
            tax_rate,
            notes: notes || null,
            store_id: req.user.store_id,
            cis_invoice_no: saveSalesData.invnumber || null,
            receipt_no: saveSalesData.rcptNo || null,
            sdcid: saveSalesData.sdcId || null,
            receiptsig: saveSalesData.rcptSign || null,
            intrldata: saveSalesData.intrlData || null,
            qrcode_url: saveSalesData.qrCodeUrl || null,
            vsdcrcpdate: saveSalesData.vsdcRcptPbctDate || null,
            invoice_no: (saveSalesData.sdcId && saveSalesData.rcptNo)
                ? generateInvoiceNumber(saveSalesData.sdcId, saveSalesData.rcptNo)
                : null,
            qrfilepath: qrFilePath,
        }, { transaction: t });

        // Create sale items and update stock
        for (const item of saleItems) {
            await saleitem.create({
                sale_id: newSale.id,
                product_id: item.product_id,
                quantity: item.quantity,
                unit_price: item.unit_price,
                total_price: item.total_price
            }, { transaction: t });

            await product.update(
                { stock_quantity: product.sequelize.literal(`stock_quantity - ${item.quantity}`) },
                { where: { id: item.product_id }, transaction: t }
            );
        }

        await t.commit();

        // Fetch complete sale data for response
        const completeSale = await sale.findByPk(newSale.id, {
            include: [
                { model: saleitem, as: 'items', include: [{ model: product, as: 'product' }] },
                { model: user, as: 'cashier', attributes: ['id', 'full_name'] },
                { model: customer, as: 'customer' },
                { model: discount, as: 'discount' },
                { model: store, as: 'store' }
            ]
        });

        // Prepare response
        const response = {
            message: 'Sale completed successfully',
            sale: completeSale,
            qr_code: qrCodeUrl,
            zra_integration: {
                success: true,
                sales_endpoint: {
                    success: true,
                    message: 'Sales data submitted successfully to ZRA'
                }
            }
        };


        res.status(201).json(response);
        processStockEndpointsInBackground(newSale.id, saleDataForZRA, saleItems, req.user, zraService);


    } catch (error) {
        await t.rollback();
        console.error('Sale creation error:', error);

        // Handle specific error types
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
        const stockMasterData = zraService.transformToZRAStockMasterData(items, user);

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
async function persistShipmentDataToSage(saleData, saleItems, user) {
    try {
        const sageService = new SageShipment();
        const sageResponse = await sageService.createShipmentBatch(saleData, saleItems, user);

        if (!sageResponse.success) {
            console.error('Sage shipment creation failed:', sageResponse.error);
            return { success: false, error: 'Failed to create shipment in Sage system' };
        }

        console.log('Sage shipment created successfully:', sageResponse.data);
        return { success: true, data: sageResponse.data };

    } catch (error) {
        console.error('Error persisting data to Sage:', error);
        return { success: false, error: 'Error occurred while communicating with Sage system' };
    }

}

async function persistInvoiceDataToSage(saleData, saleItems, user) {
    try {

        const sageService = new AccountsReceivableBatch();
        const sageResponse = await sageService.createSageArBatch(saleData, saleItems, user);

        if (!sageResponse.success) {
            console.error('Sage AR invoice creation failed:', sageResponse.error);
            return { success: false, error: 'Failed to create AR invoice in Sage system' };
        }

        console.log('Sage AR invoice created successfully:', sageResponse.data);
        return { success: true, data: sageResponse.data };

    } catch (error) {
        console.error('Error persisting data to Sage:', error);
        return { success: false, error: 'Error occurred while communicating with Sage system' };
    }

}
// GET /sales - Get all sales with pagination and filtering
router.get('/', auth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        
        // Build where clause for filtering
        const whereClause = {};
        
        if (req.query.start_date && req.query.end_date) {
            whereClause.sale_date = {
                [Op.between]: [new Date(req.query.start_date), new Date(req.query.end_date)]
            };
        }
        
        if (req.query.payment_method) {
            whereClause.payment_method = req.query.payment_method;
        }
        
        if (req.query.zra_status) {
            whereClause.zra_status = req.query.zra_status;
        }
        
        if (req.query.store_id) {
            whereClause.store_id = req.query.store_id;
        } else if (req.user.store_id && !req.user.is_admin) {
            // Non-admin users can only see their store's sales
            whereClause.store_id = req.user.store_id;
        }

        const { count, rows } = await sale.findAndCountAll({
            where: whereClause,
            limit,
            offset,
            order: [['sale_date', 'DESC']],
            include: [
                { model: user, as: 'cashier', attributes: ['id', 'full_name'] },
                { model: customer, as: 'customer' },
                { model: discount, as: 'discount' },
                { model: store, as: 'store', attributes: ['id', 'name'] }
            ]
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
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// GET /sales/:id - Get sale by ID (for receipt generation)
router.get('/:id', auth, async (req, res) => {
    try {
        const whereClause = { id: req.params.id };
        
        // Non-admin users can only access their store's sales
        if (req.user.store_id && !req.user.is_admin) {
            whereClause.store_id = req.user.store_id;
        }

        const saleData = await sale.findOne({
            where: whereClause,
            include: [
                {
                    model: saleitem,
                    as: 'items',
                    include: [{ model: product, as: 'product' }]
                },
                { model: user, as: 'cashier', attributes: ['id', 'full_name', 'email'] },
                { model: customer, as: 'customer' },
                { model: discount, as: 'discount' },
                { model: store, as: 'store' }
            ]
        });

        if (!saleData) {
            return res.status(404).json({ message: 'Sale not found' });
        }

        res.json({ sale: saleData });

    } catch (error) {
        console.error('Get sale by ID error:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// GET /sales/report/date-range - Get sales by date range with summary
router.get('/report/date-range', auth, async (req, res) => {
    try {
        const { start_date, end_date, store_id } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);
        endDate.setHours(23, 59, 59, 999); // Include the entire end date

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            return res.status(400).json({ message: 'Invalid date format' });
        }

        // Build where clause
        const whereClause = {
            sale_date: {
                [Op.between]: [startDate, endDate]
            }
        };
        
        // Filter by store if provided and user has access
        if (store_id) {
            if (req.user.is_admin || req.user.store_id == store_id) {
                whereClause.store_id = store_id;
            } else {
                return res.status(403).json({ message: 'Access denied to this store data' });
            }
        } else if (req.user.store_id && !req.user.is_admin) {
            // Non-admin users can only see their store's data
            whereClause.store_id = req.user.store_id;
        }

        const sales = await sale.findAll({
            where: whereClause,
            include: [
                { model: user, as: 'cashier', attributes: ['id', 'full_name'] },
                { model: customer, as: 'customer' },
                { model: store, as: 'store', attributes: ['id', 'name'] }
            ],
            order: [['sale_date', 'DESC']]
        });

        // Calculate summary
        const summary = {
            total_sales: sales.length,
            total_revenue: sales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0),
            total_discounts: sales.reduce((sum, s) => sum + parseFloat(s.discount_amount || 0), 0),
            total_taxes: sales.reduce((sum, s) => sum + parseFloat(s.tax_amount || 0), 0),
            payment_methods: {}
        };

        sales.forEach(s => {
            const method = s.payment_method || 'unknown';
            summary.payment_methods[method] =
                (summary.payment_methods[method] || 0) + parseFloat(s.total_amount || 0);
        });

        res.json({
            sales,
            summary,
            date_range: {
                start_date: startDate.toISOString(),
                end_date: endDate.toISOString()
            }
        });

    } catch (error) {
        console.error('Date range report error:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// GET /sales/report/daily - Get daily sales summary
router.get('/report/daily', auth, async (req, res) => {
    try {
        const { date } = req.query;
        let targetDate;
        
        if (date) {
            targetDate = new Date(date);
        } else {
            targetDate = new Date();
        }
        
        if (isNaN(targetDate.getTime())) {
            return res.status(400).json({ message: 'Invalid date format' });
        }

        const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
        const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));

        // Build where clause
        const whereClause = {
            sale_date: {
                [Op.between]: [startOfDay, endOfDay]
            }
        };
        
        // Non-admin users can only see their store's data
        if (req.user.store_id && !req.user.is_admin) {
            whereClause.store_id = req.user.store_id;
        }

        const todaySales = await sale.findAll({
            where: whereClause,
            include: [
                { model: store, as: 'store', attributes: ['id', 'name'] }
            ]
        });

        const summary = {
            date: startOfDay.toISOString().split('T')[0],
            total_sales: todaySales.length,
            total_revenue: todaySales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0),
            total_discounts: todaySales.reduce((sum, s) => sum + parseFloat(s.discount_amount || 0), 0),
            total_taxes: todaySales.reduce((sum, s) => sum + parseFloat(s.tax_amount || 0), 0),
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
            },
            by_store: {}
        };

        // Calculate summary by store
        todaySales.forEach(sale => {
            const storeName = sale.store ? sale.store.name : 'Unknown';
            if (!summary.by_store[storeName]) {
                summary.by_store[storeName] = {
                    total_sales: 0,
                    total_revenue: 0
                };
            }
            summary.by_store[storeName].total_sales += 1;
            summary.by_store[storeName].total_revenue += parseFloat(sale.total_amount || 0);
        });

        res.json({ summary });

    } catch (error) {
        console.error('Daily report error:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// GET /sales/:id/zra-status - Get ZRA status for a sale
router.get('/:id/zra-status', auth, async (req, res) => {
    try {
        const whereClause = { id: req.params.id };
        
        // Non-admin users can only access their store's sales
        if (req.user.store_id && !req.user.is_admin) {
            whereClause.store_id = req.user.store_id;
        }

        const saleData = await sale.findOne({
            where: whereClause,
            attributes: ['id', 'receipt_number', 'zra_status', 'cis_invoice_no', 'zra_response']
        });

        if (!saleData) {
            return res.status(404).json({ message: 'Sale not found' });
        }

        res.json({ 
            zra_status: saleData.zra_status,
            cis_invoice_no: saleData.cis_invoice_no,
            receipt_number: saleData.receipt_number,
            response: saleData.zra_response
        });

    } catch (error) {
        console.error('Get ZRA status error:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

module.exports = router;