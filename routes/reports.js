// Add these routes to your backend router
const express = require("express");
const router = express.Router();
const { sale, saleitem, product, user, customer, category, productinventory, sequelize } = require('../models');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');
// Dashboard Statistics
router.get('/dashboard', auth, async (req, res) => {
    try {
        const today = new Date();
        const startOfDay = new Date(today.setHours(0, 0, 0, 0));
        const endOfDay = new Date(today.setHours(23, 59, 59, 999));

        const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
        const startOfYesterday = new Date(yesterday.setHours(0, 0, 0, 0));
        const endOfYesterday = new Date(yesterday.setHours(23, 59, 59, 999));

        const filterStoreId = req.user.store_id;
        const cashierInclude = [{ model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) }];

        // Today's sales
        const todaySales = await sale.findAll({
            where: {
                sale_date: { [Op.between]: [startOfDay, endOfDay] }
            },
            include: cashierInclude
        });

        // Yesterday's sales for comparison
        const yesterdaySales = await sale.findAll({
            where: {
                sale_date: { [Op.between]: [startOfYesterday, endOfYesterday] }
            },
            include: cashierInclude
        });

        // Low stock count (by store inventory)
        const lowStockCount = await productinventory.count({
            where: {
                store_id: filterStoreId,
                stock_quantity: { [Op.lte]: sequelize.col('min_stock_level') }
            }
        });

        // Total products
        const totalProducts = await product.count({ where: { is_active: true } });

        const todayRevenue = todaySales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);
        const yesterdayRevenue = yesterdaySales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);

        res.json({
            today_sales: {
                count: todaySales.length,
                revenue: todayRevenue
            },
            yesterday_sales: {
                count: yesterdaySales.length,
                revenue: yesterdayRevenue
            },
            inventory: {
                total_products: totalProducts,
                low_stock_items: lowStockCount
            },
            revenue_change: yesterdayRevenue > 0 ?
                ((todayRevenue - yesterdayRevenue) / yesterdayRevenue * 100) : 0,
            sales_change: yesterdaySales.length > 0 ?
                ((todaySales.length - yesterdaySales.length) / yesterdaySales.length * 100) : 0
        });

    } catch (error) {
        console.error('Dashboard stats error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Sales Report (comprehensive)
router.get('/sales', auth, async (req, res) => {
    try {
        const { start_date, end_date, report_type = 'summary', category_id, product_id } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);

        let whereClause = {
            sale_date: { [Op.between]: [startDate, endDate] }
        };

        const filterStoreId = req.user.store_id;

        const includeClause = [
            { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
            { model: customer, as: 'customer' },
            {
                model: saleitem,
                as: 'items',
                include: [{
                    model: product,
                    as: 'product',
                    include: [{ model: category, as: 'category' }]
                }]
            }
        ];

        // Filter by category or product if specified
        if (category_id || product_id) {
            includeClause[2].where = {};
            if (product_id) {
                includeClause[2].where.product_id = product_id;
            }
            if (category_id) {
                includeClause[2].include[0].where = { category_id };
            }
        }

        const sales = await sale.findAll({
            where: whereClause,
            include: includeClause,
            order: [['sale_date', 'DESC']]
        });

        const summary = {
            total_sales: sales.length,
            total_revenue: sales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0),
            total_discounts: sales.reduce((sum, s) => sum + parseFloat(s.discount_amount || 0), 0),
            total_tax: sales.reduce((sum, s) => sum + parseFloat(s.tax_amount || 0), 0),
            payment_methods: {},
            daily_breakdown: {}
        };

        // Group by payment method and daily breakdown
        sales.forEach(s => {
            const method = s.payment_method || 'unknown';
            const date = s.sale_date.toDateString();

            summary.payment_methods[method] =
                (summary.payment_methods[method] || 0) + parseFloat(s.total_amount || 0);

            if (!summary.daily_breakdown[date]) {
                summary.daily_breakdown[date] = { sales: 0, revenue: 0 };
            }
            summary.daily_breakdown[date].sales++;
            summary.daily_breakdown[date].revenue += parseFloat(s.total_amount || 0);
        });

        res.json({
            report_type,
            date_range: { start_date, end_date },
            sales,
            summary
        });

    } catch (error) {
        console.error('Sales report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Product Performance Report
router.get('/products', auth, async (req, res) => {
    try {
        const { start_date, end_date, category_id, limit = 50 } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);

        let includeWhere = {
            '$sale.sale_date$': { [Op.between]: [startDate, endDate] }
        };

        if (category_id) {
            includeWhere['$product.category_id$'] = category_id;
        }

        const productSales = await saleitem.findAll({
            where: includeWhere,
            include: [
                {
                    model: product,
                    as: 'product',
                    include: [{ model: category, as: 'category' }]
                },
                { model: sale, as: 'sale' }
            ],
            attributes: [
                'product_id',
                [sequelize.fn('SUM', sequelize.col('quantity')), 'total_quantity'],
                [sequelize.fn('SUM', sequelize.col('total_price')), 'total_revenue'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'transaction_count']
            ],
            group: ['product_id', 'product.id'],
            order: [[sequelize.fn('SUM', sequelize.col('total_price')), 'DESC']],
            limit: parseInt(limit)
        });

        res.json({
            date_range: { start_date, end_date },
            products: productSales
        });

    } catch (error) {
        console.error('Product performance report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Inventory Report
router.get('/inventory', auth, async (req, res) => {
    try {
        const { low_stock_only, category_id, include_inactive = false } = req.query;

        const store_id = req.user.store_id;

        // Build inventory where clause
        const inventoryWhere = { store_id };

        const productWhere = {};
        if (!include_inactive || include_inactive === 'false') {
            productWhere.is_active = true;
        }
        if (category_id) {
            productWhere.category_id = category_id;
        }
        if (low_stock_only === 'true') {
            inventoryWhere[Op.and] = [
                sequelize.where(sequelize.col('stock_quantity'), Op.lte, sequelize.col('min_stock_level'))
            ];
        }

        const inventories = await productinventory.findAll({
            where: inventoryWhere,
            include: [{ model: product, as: 'product', where: productWhere, include: [{ model: category, as: 'category' }] }],
            order: [['stock_quantity', 'ASC']]
        });

        const summary = {
            total_products: inventories.length,
            total_stock_value: inventories.reduce((sum, inv) =>
                sum + (parseFloat(inv.product?.cost || 0) * parseInt(inv.stock_quantity || 0)), 0),
            low_stock_items: inventories.filter(inv =>
                parseInt(inv.stock_quantity || 0) <= parseInt(inv.min_stock_level || 0)).length,
            out_of_stock_items: inventories.filter(inv =>
                parseInt(inv.stock_quantity || 0) === 0).length
        };

        res.json({
            inventories,
            summary
        });

    } catch (error) {
        console.error('Inventory report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// User Activity Report
router.get('/user-activity', auth, async (req, res) => {
    try {
        const { start_date, end_date, user_id } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);

        let whereClause = {
            sale_date: { [Op.between]: [startDate, endDate] }
        };

        if (user_id) {
            whereClause.user_id = user_id;
        }

        const userSales = await sale.findAll({
            where: whereClause,
            include: [{ model: user, as: 'cashier', attributes: ['id', 'full_name', 'role'] }],
            attributes: [
                'user_id',
                [sequelize.fn('COUNT', sequelize.col('id')), 'total_sales'],
                [sequelize.fn('SUM', sequelize.col('total_amount')), 'total_revenue']
            ],
            group: ['user_id', 'cashier.id'],
            order: [[sequelize.fn('COUNT', sequelize.col('id')), 'DESC']]
        });

        res.json({
            date_range: { start_date, end_date },
            user_activity: userSales
        });

    } catch (error) {
        console.error('User activity report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Category Performance Report
router.get('/categories', auth, async (req, res) => {
    try {
        const { start_date, end_date } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);

        const categorySales = await saleitem.findAll({
            where: {
                '$sale.sale_date$': { [Op.between]: [startDate, endDate] }
            },
            include: [
                {
                    model: product,
                    as: 'product',
                    include: [{ model: category, as: 'category' }]
                },
                { model: sale, as: 'sale' }
            ],
            attributes: [
                [sequelize.col('product.category.id'), 'category_id'],
                [sequelize.col('product.category.name'), 'category_name'],
                [sequelize.fn('SUM', sequelize.col('quantity')), 'total_quantity'],
                [sequelize.fn('SUM', sequelize.col('total_price')), 'total_revenue'],
                [sequelize.fn('COUNT', sequelize.col('saleitem.id')), 'transaction_count']
            ],
            group: ['product.category.id'],
            order: [[sequelize.fn('SUM', sequelize.col('total_price')), 'DESC']]
        });

        res.json({
            date_range: { start_date, end_date },
            categories: categorySales
        });

    } catch (error) {
        console.error('Category performance report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Tax Report
router.get('/tax', auth, async (req, res) => {
    try {
        const { start_date, end_date } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);

        const taxData = await sale.findAll({
            where: {
                sale_date: { [Op.between]: [startDate, endDate] }
            },
            attributes: [
                [sequelize.fn('SUM', sequelize.col('subtotal')), 'total_subtotal'],
                [sequelize.fn('SUM', sequelize.col('tax_amount')), 'total_tax'],
                [sequelize.fn('SUM', sequelize.col('total_amount')), 'total_with_tax'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'total_transactions']
            ]
        });

        const dailyTax = await sale.findAll({
            where: {
                sale_date: { [Op.between]: [startDate, endDate] }
            },
            attributes: [
                [sequelize.fn('DATE', sequelize.col('sale_date')), 'date'],
                [sequelize.fn('SUM', sequelize.col('tax_amount')), 'daily_tax'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'daily_transactions']
            ],
            group: [sequelize.fn('DATE', sequelize.col('sale_date'))],
            order: [[sequelize.fn('DATE', sequelize.col('sale_date')), 'ASC']]
        });

        res.json({
            date_range: { start_date, end_date },
            summary: taxData[0],
            daily_breakdown: dailyTax
        });

    } catch (error) {
        console.error('Tax report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Export Report Route
router.get('/:reportType/export', auth, async (req, res) => {
    try {
        const { reportType } = req.params;
        const { format, start_date, end_date, ...additionalParams } = req.query;

        // This is a placeholder - you'll need to implement actual export logic
        // using libraries like csv-writer, jspdf, or xlsx

        if (!['csv', 'pdf', 'xlsx'].includes(format)) {
            return res.status(400).json({ message: 'Invalid format. Use csv, pdf, or xlsx' });
        }

        // For now, return mock data
        const mockData = Buffer.from(`Report: ${reportType}\nFormat: ${format}\nDate Range: ${start_date} to ${end_date}`);

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename=report_${reportType}_${format}`);
        res.send(mockData);

    } catch (error) {
        console.error('Export report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});
module.exports = router;