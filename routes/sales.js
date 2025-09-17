const express = require('express');
const { sale, saleitem, product, user, customer, discount, store } = require('../models');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { body, validationResult } = require('express-validator');
const ZRAService = require('../services/zraService');

const router = express.Router();

// Generate sequential receipt number and unique invoice number
async function generateInvoiceAndReceiptNumber(storeId) {
    const lastSale = await sale.findOne({
        where: { store_id: storeId },
        order: [['id', 'DESC']],
    });

    let nextSeq = 1;
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

        await QRCode.toFile(filePath, qrData, { width: 250, margin: 2, errorCorrectionLevel: 'H' });

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
router.post('/', auth, validateSale, async (req, res) => {
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

        const isZRAEnabled = storeConfig.zra_enabled === 1;
        if (isZRAEnabled && (!storeConfig.store_identifier || !storeConfig.zra_tpin || !storeConfig.zra_bhf_id)) {
            console.error('❌ ZRA config missing:', storeConfig);
            await t.rollback();
            return res.status(400).json({ message: 'Missing ZRA configuration (SDC ID, TPIN, or BHF ID)' });
        }

        // Generate invoice & receipt
        const { receiptNumber, invoiceNo } = await generateInvoiceAndReceiptNumber(req.user.store_id);

        // Calculate totals with safe rounding
        let subtotal = 0;
        const saleItems = [];

        for (const item of items) {
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

            // Round item totals to 2 decimals
            const tax_exclusive_total = parseFloat((item.quantity * item.unit_price).toFixed(2));
            const item_tax_amount = parseFloat((tax_exclusive_total * tax_rate / 100).toFixed(2));
            const tax_inclusive_total = parseFloat((tax_exclusive_total + item_tax_amount).toFixed(2));

            subtotal += tax_exclusive_total;

            saleItems.push({
                product_id: item.product_id,
                quantity: item.quantity,
                unit_price: item.unit_price,
                total_price: tax_exclusive_total,
                tax_inclusive_total,
                product: productData
            });
        }

        // Round subtotal
        subtotal = parseFloat(subtotal.toFixed(2));

        // Apply discount with safe rounding
        let discount_amount = 0;
        let discountData = null;
        if (discount_id) {
            discountData = await discount.findByPk(discount_id, { transaction: t });
            if (discountData && discountData.is_active) {
                discount_amount = discountData.type === 'percentage'
                    ? parseFloat(((subtotal * discountData.value) / 100).toFixed(2))
                    : parseFloat(discountData.value.toFixed(2));
            }
        }

        // Calculate totals safely with rounding
        let taxable_amount = subtotal - discount_amount;
        taxable_amount = parseFloat(taxable_amount.toFixed(2));

        const tax_amount = parseFloat((taxable_amount * tax_rate / 100).toFixed(2));
        let total_amount = parseFloat((taxable_amount + tax_amount).toFixed(2));
        const amount_paid_rounded = parseFloat(amount_paid.toFixed(2));
        const change_amount = parseFloat((amount_paid_rounded - total_amount).toFixed(2));

        if (change_amount < 0) {
            console.error(`❌ Insufficient payment. Paid: ${amount_paid_rounded}, total: ${total_amount}`);
            await t.rollback();
            return res.status(400).json({ message: 'Insufficient payment amount' });
        }

        const customerData = customer_id ? await customer.findByPk(customer_id, { transaction: t }) : null;

        // Process ZRA if enabled
        let zraResults = null;
        let zraFields = {};
        let qrFilePath = null;
        let qrCodeUrl = null;

        if (isZRAEnabled) {
            try {
                const zraService = new ZRAService();
                const saleDataForZRA = {
                    subtotal, discount_amount, tax_amount, total_amount, tax_rate,
                    payment_method, amount_paid: amount_paid_rounded, change_amount, notes,
                    customer: customerData, discount: discountData,
                    items: saleItems, user: req.user, store_id: req.user.store_id,
                    store_config: { sdcid: storeConfig.store_identifier, tpin: storeConfig.zra_tpin, bhfId: storeConfig.zra_bhf_id },
                    invoice_number: invoiceNo, receipt_sequence: receiptNumber
                };

                zraResults = await zraService.processZRAIntegration(saleDataForZRA, saleItems, req.user);

                if (!zraResults.success) throw new Error('ZRA integration failed');

                const saveSalesData = zraResults.responses.find(r => r.endpoint === 'saveSales')?.data?.data;
                const qrCodeData = saveSalesData?.qrCodeUrl || JSON.stringify({ 
                    subtotal, tax_amount, discount_amount, total_amount, tax_rate, 
                    sale_date: new Date().toISOString(), store_id: req.user.store_id, invoice_number: invoiceNo 
                });

                const qrResult = await generateQrCode(qrCodeData, saveSalesData?.rcptNo || invoiceNo, "./public/qrcodes");
                qrFilePath = qrResult.filePath;
                qrCodeUrl = qrResult.publicUrl;

                zraFields = {
                    invnumber: saveSalesData?.invnumber || null,
                    receipt_no: saveSalesData?.rcptNo || null,
                    sdcid: saveSalesData?.sdcId || storeConfig.store_identifier,
                    receiptsig: saveSalesData?.rcptSign || null,
                    intrldata: saveSalesData?.intrlData || null,
                    vsdcrcpdate: saveSalesData?.vsdcRcptPbctDate || null,
                    qrcode_url: qrCodeUrl || saveSalesData?.qrCodeUrl || null,
                    qrfilepath: qrFilePath || null
                };

            } catch (err) {
                console.error('ZRA processing error:', err);
                if (storeConfig.zra_required === 1) {
                    await t.rollback();
                    return res.status(500).json({ message: 'Failed to process sale with ZRA', error: err.message });
                }
                // If ZRA is not required, continue with null values
                zraResults = { success: false, errors: [{ endpoint: 'general', error: err.message }] };
            }
        } 
        
        // Generate QR code for non-ZRA enabled stores or as fallback
        if (!qrCodeUrl) {
            try {
                const qrData = { 
                    subtotal, tax_amount, discount_amount, total_amount, tax_rate, 
                    sale_date: new Date().toISOString(), store_id: req.user.store_id, 
                    invoice_number: invoiceNo 
                };
                const qrResult = await generateQrCode(qrData, invoiceNo, "./public/qrcodes");
                qrFilePath = qrResult.filePath;
                qrCodeUrl = qrResult.publicUrl;
            } catch (qrError) {
                console.error('Fallback QR generation failed:', qrError);
                // Continue without QR code
            }
        }

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
            cis_invoice_no: invoiceNo,
            invoice_no: invoiceNo,
            zra_response: zraResults ? JSON.stringify(zraResults) : null,
            zra_status: isZRAEnabled ? (zraResults?.success ? 'success' : 'failed') : 'disabled',
            qrcode_url: qrCodeUrl,
            qrfilepath: qrFilePath,
            ...zraFields
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
                enabled: isZRAEnabled, 
                status: completeSale.zra_status,
                success: completeSale.zra_status === 'success',
                message: completeSale.zra_status === 'success' ? 'ZRA integration successful' : 
                        completeSale.zra_status === 'failed' ? 'ZRA integration failed' : 
                        completeSale.zra_status === 'disabled' ? 'ZRA integration disabled' : 'ZRA integration pending'
            }
        };

        if (zraResults?.errors) {
            response.zra_integration.errors = zraResults.errors;
        }

        res.status(201).json(response);

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