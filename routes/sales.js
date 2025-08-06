const express = require('express');
const { sale, saleitem, product, user, customer, discount } = require('../models');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');

const router = express.Router();

// Generate receipt number
const generateReceiptNumber = () => {
    const now = new Date();
    const timestamp = now.getTime().toString().slice(-8);
    return `RCP${timestamp}`;
};

// Create new sale
const ZRAIntegrationService = require('../views/generateSmartInvoice');

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

            // Check stock
            if (productData.stock_quantity < item.quantity) {
                await t.rollback();
                return res.status(400).json({
                    message: `Insufficient stock for ${productData.name}. Available: ${productData.stock_quantity}`
                });
            }

            const total_price = item.quantity * item.unit_price;
            subtotal += total_price;

            // Include product data for ZRA integration
            saleItems.push({
                product_id: item.product_id,
                quantity: item.quantity,
                unit_price: item.unit_price,
                total_price,
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
            discount: discountData
        };

        // Initialize ZRA Integration Service
        const zraService = new ZRAIntegrationService();

        // Process ZRA Integration before persisting the sale
        console.log('Processing ZRA integration...');
        const zraResults = await zraService.processZRAIntegration(
            saleDataForZRA,
            saleItems,
            req.user
        );

        // Check if ZRA integration was successful
        if (!zraResults.success) {
            await t.rollback();
            console.error('ZRA Integration failed:', zraResults.errors);

            return res.status(500).json({
                message: 'Failed to process sale with ZRA system',
                zra_errors: zraResults.errors,
                details: 'The sale could not be completed due to ZRA integration issues'
            });
        }

        console.log('ZRA integration successful, proceeding with sale creation...');

        // Create sale (only if ZRA integration was successful)
        const newSale = await sale.create({
            receipt_number: generateReceiptNumber(),
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
            zra_processed: true, // Flag to indicate ZRA processing
            zra_responses: JSON.stringify(zraResults.responses) // Store ZRA responses
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

            // Update product stock
            await product.update(
                {
                    stock_quantity: product.sequelize.literal(`stock_quantity - ${item.quantity}`)
                },
                {
                    where: { id: item.product_id },
                    transaction: t
                }
            );
        }

        await t.commit();

        // Fetch complete sale data for response
        const completeSale = await sale.findByPk(newSale.id, {
            include: [
                {
                    model: saleitem,
                    as: 'items',
                    include: [{ model: product, as: 'product' }]
                },
                { model: user, as: 'cashier', attributes: ['id', 'full_name'] },
                { model: customer, as: 'customer' },
                { model: discount, as: 'discount' }
            ]
        });

        res.status(201).json({
            message: 'Sale completed successfully',
            sale: completeSale,
            zra_integration: {
                success: true,
                responses: zraResults.responses
            }
        });

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

        res.status(500).json({ message: 'Server error' });
    }
});



// Get all sales with pagination
router.get('/', auth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const { count, rows } = await sale.findAndCountAll({
            limit,
            offset,
            order: [['sale_date', 'DESC']],
            include: [
                { model: user, as: 'cashier', attributes: ['id', 'full_name'] },
                { model: customer, as: 'customer' },
                { model: discount, as: 'discount' }
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
        console.error(error);
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
                { model: user, as: 'cashier', attributes: ['id', 'full_name'] },
                { model: customer, as: 'customer' },
                { model: discount, as: 'discount' }
            ]
        });

        if (!saleData) {
            return res.status(404).json({ message: 'Sale not found' });
        }

        res.json({ sale: saleData });

    } catch (error) {
        console.error(error);
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

        const sales = await sale.findAll({
            where: {
                sale_date: {
                    [Op.between]: [new Date(start_date), new Date(end_date)]
                }
            },
            include: [
                { model: user, as: 'cashier', attributes: ['id', 'full_name'] },
                { model: customer, as: 'customer' }
            ],
            order: [['sale_date', 'DESC']]
        });

        // Calculate summary
        const summary = {
            total_sales: sales.length,
            total_revenue: sales.reduce((sum, s) => sum + parseFloat(s.total_amount), 0),
            total_discounts: sales.reduce((sum, s) => sum + parseFloat(s.discount_amount), 0),
            payment_methods: {}
        };

        // Group by payment method
        sales.forEach(s => {
            summary.payment_methods[s.payment_method] =
                (summary.payment_methods[s.payment_method] || 0) + parseFloat(s.total_amount);
        });

        res.json({
            sales,
            summary
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get daily sales summary
router.get('/report/daily', auth, async (req, res) => {
    try {
        const today = new Date();
        const startOfDay = new Date(today.setHours(0, 0, 0, 0));
        const endOfDay = new Date(today.setHours(23, 59, 59, 999));

        const todaySales = await sale.findAll({
            where: {
                sale_date: {
                    [Op.between]: [startOfDay, endOfDay]
                }
            }
        });

        const summary = {
            date: startOfDay.toDateString(),
            total_sales: todaySales.length,
            total_revenue: todaySales.reduce((sum, s) => sum + parseFloat(s.total_amount), 0),
            total_discounts: todaySales.reduce((sum, s) => sum + parseFloat(s.discount_amount), 0),
            cash_sales: todaySales.filter(s => s.payment_method === 'cash').length,
            card_sales: todaySales.filter(s => s.payment_method === 'card').length,
            mobile_sales: todaySales.filter(s => s.payment_method === 'mobile_money').length
        };

        res.json({ summary });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;