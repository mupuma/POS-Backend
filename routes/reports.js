// Add these routes to your backend router
const express = require("express");
const router = express.Router();
const { sale, saleitem, product, user, customer, category, productinventory, sequelize, creditnote, creditnoteitem } = require('../models');
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
            items_count: sales.reduce((sum, s) => sum + (s.items ? s.items.length : 0), 0),
            items_quantity: sales.reduce((sum, s) => sum + (s.items ? s.items.reduce((q, i) => q + Number(i.quantity || 0), 0) : 0), 0),
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

// Transaction List Report - Grouped by Item
router.get('/transaction-list', auth, async (req, res) => {
    try {
        const { start_date, end_date, period = 'day' } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);
        const filterStoreId = req.user.store_id;

        const cashierInclude = [{
            model: user,
            as: 'cashier',
            attributes: ['id', 'full_name', 'store_id'],
            ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {})
        }];

        // Get all sales in the period
        const sales = await sale.findAll({
            where: {
                sale_date: { [Op.between]: [startDate, endDate] }
            },
            include: [
                ...cashierInclude,
                {
                    model: saleitem,
                    as: 'items',
                    include: [{
                        model: product,
                        as: 'product',
                        attributes: ['id', 'name', 'product_class_code', 'price']
                    }]
                }
            ],
            order: [['sale_date', 'DESC']]
        });

        // Group items across all sales
        const itemMap = {};

        sales.forEach(s => {
            (s.items || []).forEach(item => {
                const productId = item.product_id;
                const productName = item.product?.name || 'Unknown Product';

                if (!itemMap[productId]) {
                    itemMap[productId] = {
                        product_id: productId,
                        product_name: productName,
                        product_class_code: item.product?.product_class_code || '',
                        total_quantity: 0,
                        total_amount: 0,
                        transaction_count: 0
                    };
                }

                itemMap[productId].total_quantity += parseInt(item.quantity || 0);
                itemMap[productId].total_amount += parseFloat(item.total_price || 0);
                itemMap[productId].transaction_count += 1;
            });
        });

        const itemsSummary = Object.values(itemMap).sort((a, b) =>
            b.total_amount - a.total_amount
        );

        const summary = {
            period,
            total_transactions: sales.length,
            total_items_sold: itemsSummary.reduce((sum, item) => sum + item.total_quantity, 0),
            total_revenue: itemsSummary.reduce((sum, item) => sum + item.total_amount, 0),
            unique_products: itemsSummary.length
        };

        res.json({
            date_range: { start_date, end_date },
            period,
            summary,
            items: itemsSummary
        });

    } catch (error) {
        console.error('Transaction list report error:', error);
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

// Email Report Route - All reports are sent in Excel format only
const ExcelJS = require('exceljs');
const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');
const pool = require('../config/database'); // Adjust path as needed

// Configure email transporter (use environment variables)
const createEmailTransporter = () => {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: process.env.SMTP_PORT || 587,
        secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });
};

// Report generation functions
const generateSalesReport = async (startDate, endDate, storeId, additionalParams) => {
    const query = `
        SELECT 
            s.sale_id,
            s.invoice_no,
            s.receipt_no,
            s.total_amount,
            s.payment_method,
            s.created_at,
            u.full_name as cashier_name,
            st.store_name,
            COUNT(si.item_id) as items_count
        FROM sales s
        LEFT JOIN users u ON s.user_id = u.user_id
        LEFT JOIN stores st ON s.store_id = st.store_id
        LEFT JOIN sale_items si ON s.sale_id = si.sale_id
        WHERE s.created_at BETWEEN ? AND ?
        ${storeId ? 'AND s.store_id = ?' : ''}
        GROUP BY s.sale_id
        ORDER BY s.created_at DESC
    `;

    const params = storeId ? [startDate, endDate, storeId] : [startDate, endDate];
    const [rows] = await pool.query(query, params);
    return rows;
};

const generateProductsReport = async (startDate, endDate, storeId, additionalParams) => {
    const query = `
        SELECT 
            p.product_id,
            p.product_name,
            p.product_class_code,
            c.category_name,
            p.unit_price,
            p.stock_quantity,
            COALESCE(SUM(si.quantity), 0) as total_sold,
            COALESCE(SUM(si.quantity * si.unit_price), 0) as total_revenue
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.category_id
        LEFT JOIN sale_items si ON p.product_id = si.product_id
        LEFT JOIN sales s ON si.sale_id = s.sale_id AND s.created_at BETWEEN ? AND ?
        WHERE p.store_id = ?
        GROUP BY p.product_id
        ORDER BY total_revenue DESC
    `;

    const [rows] = await pool.query(query, [startDate, endDate, storeId]);
    return rows;
};

const generateInventoryReport = async (startDate, endDate, storeId, additionalParams) => {
    const query = `
        SELECT 
            p.product_id,
            p.product_name,
            p.product_class_code,
            c.category_name,
            p.unit_price,
            p.stock_quantity,
            p.reorder_level,
            CASE 
                WHEN p.stock_quantity <= p.reorder_level THEN 'Low Stock'
                WHEN p.stock_quantity = 0 THEN 'Out of Stock'
                ELSE 'In Stock'
            END as stock_status,
            p.updated_at as last_updated
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.category_id
        WHERE p.store_id = ?
        ORDER BY p.stock_quantity ASC, p.product_name ASC
    `;

    const [rows] = await pool.query(query, [storeId]);
    return rows;
};

const generateUserActivityReport = async (startDate, endDate, storeId, additionalParams) => {
    const query = `
        SELECT 
            u.user_id,
            u.full_name,
            u.email,
            u.role,
            COUNT(DISTINCT s.sale_id) as total_sales,
            COALESCE(SUM(s.total_amount), 0) as total_revenue,
            MIN(s.created_at) as first_sale,
            MAX(s.created_at) as last_sale
        FROM users u
        LEFT JOIN sales s ON u.user_id = s.user_id AND s.created_at BETWEEN ? AND ?
        WHERE u.store_id = ?
        GROUP BY u.user_id
        ORDER BY total_revenue DESC
    `;

    const [rows] = await pool.query(query, [startDate, endDate, storeId]);
    return rows;
};

const generateCategoriesReport = async (startDate, endDate, storeId, additionalParams) => {
    const query = `
        SELECT 
            c.category_id,
            c.category_name,
            COUNT(DISTINCT p.product_id) as products_count,
            COALESCE(SUM(si.quantity), 0) as total_items_sold,
            COALESCE(SUM(si.quantity * si.unit_price), 0) as total_revenue
        FROM categories c
        LEFT JOIN products p ON c.category_id = p.category_id
        LEFT JOIN sale_items si ON p.product_id = si.product_id
        LEFT JOIN sales s ON si.sale_id = s.sale_id AND s.created_at BETWEEN ? AND ?
        WHERE c.store_id = ?
        GROUP BY c.category_id
        ORDER BY total_revenue DESC
    `;

    const [rows] = await pool.query(query, [startDate, endDate, storeId]);
    return rows;
};

const generateTaxReport = async (startDate, endDate, storeId, additionalParams) => {
    const query = `
        SELECT 
            DATE(s.created_at) as sale_date,
            COUNT(s.sale_id) as transactions_count,
            SUM(s.total_amount) as gross_sales,
            SUM(s.total_amount * 0.16) as vat_collected,
            SUM(s.total_amount * 0.84) as net_sales,
            s.payment_method
        FROM sales s
        WHERE s.created_at BETWEEN ? AND ?
        ${storeId ? 'AND s.store_id = ?' : ''}
        GROUP BY DATE(s.created_at), s.payment_method
        ORDER BY sale_date DESC, payment_method
    `;

    const params = storeId ? [startDate, endDate, storeId] : [startDate, endDate];
    const [rows] = await pool.query(query, params);
    return rows;
};

// Create Excel workbook from data
const createExcelReport = async (reportType, data, startDate, endDate) => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(reportType.toUpperCase() + ' Report');

    // Style definitions
    const headerStyle = {
        font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } },
        alignment: { vertical: 'middle', horizontal: 'center' },
        border: {
            top: { style: 'thin' },
            left: { style: 'thin' },
            bottom: { style: 'thin' },
            right: { style: 'thin' }
        }
    };

    // Add title
    worksheet.mergeCells('A1:F1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = `${reportType.toUpperCase()} REPORT`;
    titleCell.font = { bold: true, size: 16 };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };

    // Add date range
    worksheet.mergeCells('A2:F2');
    const dateCell = worksheet.getCell('A2');
    dateCell.value = `Period: ${new Date(startDate).toLocaleDateString()} - ${new Date(endDate).toLocaleDateString()}`;
    dateCell.alignment = { horizontal: 'center' };

    worksheet.addRow([]); // Empty row

    // Define columns based on report type
    let columns = [];

    switch (reportType) {
        case 'sales':
            columns = [
                { header: 'Sale ID', key: 'sale_id', width: 12 },
                { header: 'Invoice No', key: 'invoice_no', width: 20 },
                { header: 'Receipt No', key: 'receipt_no', width: 20 },
                { header: 'Total Amount', key: 'total_amount', width: 15 },
                { header: 'Payment Method', key: 'payment_method', width: 15 },
                { header: 'Cashier', key: 'cashier_name', width: 20 },
                { header: 'Store', key: 'store_name', width: 20 },
                { header: 'Items Count', key: 'items_count', width: 12 },
                { header: 'Date', key: 'created_at', width: 20 }
            ];
            break;
        case 'products':
            columns = [
                { header: 'Product ID', key: 'product_id', width: 12 },
                { header: 'Product Name', key: 'product_name', width: 30 },
                { header: 'Classification code', key: 'product_class_code', width: 20 },
                { header: 'Category', key: 'category_name', width: 20 },
                { header: 'Unit Price', key: 'unit_price', width: 15 },
                { header: 'Stock Qty', key: 'stock_quantity', width: 12 },
                { header: 'Total Sold', key: 'total_sold', width: 12 },
                { header: 'Total Revenue', key: 'total_revenue', width: 15 }
            ];
            break;
        case 'inventory':
            columns = [
                { header: 'Product ID', key: 'product_id', width: 12 },
                { header: 'Product Name', key: 'product_name', width: 30 },
                { header: 'Classification code', key: 'product_class_code', width: 20 },
                { header: 'Category', key: 'category_name', width: 20 },
                { header: 'Unit Price', key: 'unit_price', width: 15 },
                { header: 'Stock Qty', key: 'stock_quantity', width: 12 },
                { header: 'Reorder Level', key: 'reorder_level', width: 15 },
                { header: 'Status', key: 'stock_status', width: 15 },
                { header: 'Last Updated', key: 'last_updated', width: 20 }
            ];
            break;
        case 'user-activity':
            columns = [
                { header: 'User ID', key: 'user_id', width: 12 },
                { header: 'Full Name', key: 'full_name', width: 25 },
                { header: 'Email', key: 'email', width: 30 },
                { header: 'Role', key: 'role', width: 15 },
                { header: 'Total Sales', key: 'total_sales', width: 15 },
                { header: 'Total Revenue', key: 'total_revenue', width: 15 },
                { header: 'First Sale', key: 'first_sale', width: 20 },
                { header: 'Last Sale', key: 'last_sale', width: 20 }
            ];
            break;
        case 'categories':
            columns = [
                { header: 'Category ID', key: 'category_id', width: 15 },
                { header: 'Category Name', key: 'category_name', width: 25 },
                { header: 'Products Count', key: 'products_count', width: 15 },
                { header: 'Items Sold', key: 'total_items_sold', width: 15 },
                { header: 'Total Revenue', key: 'total_revenue', width: 15 }
            ];
            break;
        case 'tax':
            columns = [
                { header: 'Date', key: 'sale_date', width: 15 },
                { header: 'Transactions', key: 'transactions_count', width: 15 },
                { header: 'Gross Sales', key: 'gross_sales', width: 15 },
                { header: 'VAT (16%)', key: 'vat_collected', width: 15 },
                { header: 'Net Sales', key: 'net_sales', width: 15 },
                { header: 'Payment Method', key: 'payment_method', width: 15 }
            ];
            break;
    }

    worksheet.columns = columns;

    // Apply header style
    const headerRow = worksheet.getRow(4);
    headerRow.eachCell((cell) => {
        cell.style = headerStyle;
    });
    headerRow.height = 25;

    // Add data rows
    data.forEach((item) => {
        const row = worksheet.addRow(item);

        // Format currency columns
        row.eachCell((cell, colNumber) => {
            const column = columns[colNumber - 1];
            if (column && (column.key.includes('amount') || column.key.includes('price') || column.key.includes('revenue'))) {
                cell.numFmt = 'K#,##0.00';
                cell.alignment = { horizontal: 'right' };
            }

            // Format date columns
            if (column && (column.key.includes('date') || column.key.includes('created_at') || column.key.includes('updated_at'))) {
                if (cell.value) {
                    cell.value = new Date(cell.value);
                    cell.numFmt = 'yyyy-mm-dd hh:mm:ss';
                }
            }

            // Add borders
            cell.border = {
                top: { style: 'thin', color: { argb: 'FFD3D3D3' } },
                left: { style: 'thin', color: { argb: 'FFD3D3D3' } },
                bottom: { style: 'thin', color: { argb: 'FFD3D3D3' } },
                right: { style: 'thin', color: { argb: 'FFD3D3D3' } }
            };
        });
    });

    // Add summary row for financial reports
    if (['sales', 'products', 'categories', 'tax'].includes(reportType)) {
        worksheet.addRow([]);
        const summaryRow = worksheet.addRow(['TOTAL', '', '', '', '', '', '', '']);
        summaryRow.font = { bold: true };
        summaryRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF2F2F2' }
        };
    }

    return workbook;
};

// Main route handler
router.post('/:reportType/email', auth, async (req, res) => {
    let tempFilePath = null;

    try {
        const { reportType } = req.params;
        const { format, start_date, end_date, email, ...additionalParams } = req.body;

        // Validate required parameters
        if (!start_date || !end_date || !email) {
            return res.status(400).json({
                message: 'start_date, end_date, and email are required',
                success: false
            });
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                message: 'Invalid email format',
                success: false
            });
        }

        // Force format to be xlsx
        const finalFormat = 'xlsx';

        // Validate reportType
        const validReportTypes = ['sales', 'products', 'inventory', 'user-activity', 'categories', 'tax'];
        if (!validReportTypes.includes(reportType)) {
            return res.status(400).json({
                message: `Invalid report type. Must be one of: ${validReportTypes.join(', ')}`,
                success: false
            });
        }

        // Validate date range
        const startDate = new Date(start_date);
        const endDate = new Date(end_date);

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            return res.status(400).json({
                message: 'Invalid date format. Use ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)',
                success: false
            });
        }

        if (startDate > endDate) {
            return res.status(400).json({
                message: 'start_date cannot be after end_date',
                success: false
            });
        }

        // Get store_id from authenticated user
        const storeId = req.user?.store_id;

        console.log(`Generating ${reportType} report from ${start_date} to ${end_date} for store ${storeId}`);

        // Generate report data based on type
        let reportData;
        switch (reportType) {
            case 'sales':
                reportData = await generateSalesReport(startDate, endDate, storeId, additionalParams);
                break;
            case 'products':
                reportData = await generateProductsReport(startDate, endDate, storeId, additionalParams);
                break;
            case 'inventory':
                reportData = await generateInventoryReport(startDate, endDate, storeId, additionalParams);
                break;
            case 'user-activity':
                reportData = await generateUserActivityReport(startDate, endDate, storeId, additionalParams);
                break;
            case 'categories':
                reportData = await generateCategoriesReport(startDate, endDate, storeId, additionalParams);
                break;
            case 'tax':
                reportData = await generateTaxReport(startDate, endDate, storeId, additionalParams);
                break;
        }

        if (!reportData || reportData.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No data found for the specified date range'
            });
        }

        // Create Excel workbook
        const workbook = await createExcelReport(reportType, reportData, startDate, endDate);

        // Save to temporary file
        const tempDir = path.join(__dirname, '../temp');
        await fs.mkdir(tempDir, { recursive: true });

        const fileName = `${reportType}_report_${Date.now()}.xlsx`;
        tempFilePath = path.join(tempDir, fileName);

        await workbook.xlsx.writeFile(tempFilePath);

        // Send email with attachment
        const transporter = createEmailTransporter();

        const mailOptions = {
            from: `"${process.env.COMPANY_NAME || 'SwiftCart POS'}" <${process.env.SMTP_USER}>`,
            to: email,
            subject: `${reportType.toUpperCase()} Report - ${new Date(startDate).toLocaleDateString()} to ${new Date(endDate).toLocaleDateString()}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #4472C4;">Your ${reportType.toUpperCase()} Report is Ready</h2>
                    <p>Hello,</p>
                    <p>Please find attached your requested ${reportType} report for the period:</p>
                    <ul>
                        <li><strong>From:</strong> ${new Date(startDate).toLocaleDateString()}</li>
                        <li><strong>To:</strong> ${new Date(endDate).toLocaleDateString()}</li>
                        <li><strong>Records:</strong> ${reportData.length}</li>
                    </ul>
                    <p>The report is in Excel format (.xlsx) and can be opened with Microsoft Excel, Google Sheets, or any compatible spreadsheet application.</p>
                    <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
                    <p style="color: #666; font-size: 12px;">
                        This is an automated message from ${process.env.COMPANY_NAME || 'DAPP POS'}. 
                        Please do not reply to this email.
                    </p>
                </div>
            `,
            attachments: [
                {
                    filename: fileName,
                    path: tempFilePath
                }
            ]
        };

        await transporter.sendMail(mailOptions);

        // Clean up temporary file
        await fs.unlink(tempFilePath);
        tempFilePath = null;

        // Return success response
        res.status(200).json({
            success: true,
            status: 'ok',
            message: `${reportType} report has been sent to ${email} in Excel format`,
            details: {
                reportType,
                format: finalFormat,
                dateRange: {
                    start_date,
                    end_date
                },
                email,
                recordsCount: reportData.length,
                additionalParams
            }
        });

    } catch (error) {
        console.error('Email report error:', error);

        // Clean up temporary file if it exists


        res.status(500).json({
            message: 'Server error while sending report email',
            success: false,
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});
// Returns Report (credit notes)
router.get('/returns', auth, async (req, res) => {
    try {
        const { start_date, end_date, report_type = 'summary', category_id, product_id } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);

        const filterStoreId = req.user.store_id;

        const includeClause = [
            { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
            { model: customer, as: 'customer' },
            {
                model: creditnoteitem,
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

        const returnsList = await creditnote.findAll({
            where: { credit_note_date: { [Op.between]: [startDate, endDate] } },
            include: includeClause,
            order: [['credit_note_date', 'DESC']]
        });

        const summary = {
            total_returns: returnsList.length,
            total_amount: returnsList.reduce((sum, r) => sum + parseFloat(r.total_amount || 0), 0),
            total_discounts: returnsList.reduce((sum, r) => sum + parseFloat(r.discount_amount || 0), 0),
            total_tax: returnsList.reduce((sum, r) => sum + parseFloat(r.tax_amount || 0), 0),
            items_count: returnsList.reduce((sum, r) => sum + (r.items ? r.items.length : 0), 0),
            items_quantity: returnsList.reduce((sum, r) => sum + (r.items ? r.items.reduce((q, i) => q + Number(i.quantity || 0), 0) : 0), 0),
            payment_methods: {},
            daily_breakdown: {}
        };

        returnsList.forEach(r => {
            const method = r.payment_method || 'unknown';
            const date = new Date(r.credit_note_date).toDateString();

            summary.payment_methods[method] = (summary.payment_methods[method] || 0) + parseFloat(r.total_amount || 0);

            if (!summary.daily_breakdown[date]) {
                summary.daily_breakdown[date] = { returns: 0, amount: 0 };
            }
            summary.daily_breakdown[date].returns++;
            summary.daily_breakdown[date].amount += parseFloat(r.total_amount || 0);
        });

        res.json({
            report_type,
            date_range: { start_date, end_date },
            returns: returnsList,
            summary
        });

    } catch (error) {
        console.error('Returns report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Combined Transactions Report (sales + returns)
router.get('/transactions', auth, async (req, res) => {
    try {
        const { start_date, end_date, report_type = 'summary', category_id, product_id } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);
        const filterStoreId = req.user.store_id;

        // SALES
        const salesInclude = [
            { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
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
        if (category_id || product_id) {
            salesInclude[1].where = {};
            if (product_id) salesInclude[1].where.product_id = product_id;
            if (category_id) salesInclude[1].include[0].where = { category_id };
        }
        const salesList = await sale.findAll({
            where: { sale_date: { [Op.between]: [startDate, endDate] } },
            include: salesInclude
        });

        // RETURNS
        const returnsInclude = [
            { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
            {
                model: creditnoteitem,
                as: 'items',
                include: [{
                    model: product,
                    as: 'product',
                    include: [{ model: category, as: 'category' }]
                }]
            }
        ];
        if (category_id || product_id) {
            returnsInclude[1].where = {};
            if (product_id) returnsInclude[1].where.product_id = product_id;
            if (category_id) returnsInclude[1].include[0].where = { category_id };
        }
        const returnsList = await creditnote.findAll({
            where: { credit_note_date: { [Op.between]: [startDate, endDate] } },
            include: returnsInclude
        });

        const overall = {
            total_sales: salesList.length,
            total_returns: returnsList.length,
            items_count: (salesList.reduce((s, x) => s + (x.items ? x.items.length : 0), 0)) + (returnsList.reduce((s, x) => s + (x.items ? x.items.length : 0), 0)),
            items_quantity: (salesList.reduce((s, x) => s + (x.items ? x.items.reduce((q, i) => q + Number(i.quantity || 0), 0) : 0), 0)) + (returnsList.reduce((s, x) => s + (x.items ? x.items.reduce((q, i) => q + Number(i.quantity || 0), 0) : 0), 0)),
            revenue: salesList.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0) - returnsList.reduce((sum, r) => sum + parseFloat(r.total_amount || 0), 0),
        };

        // Per-category breakdown
        const categoryMap = {};
        const addToCategory = (catId, catName, qty, amount) => {
            if (!categoryMap[catId || 'uncategorized']) {
                categoryMap[catId || 'uncategorized'] = { category_id: catId || null, category_name: catName || 'Uncategorized', items_quantity: 0, revenue: 0 };
            }
            categoryMap[catId || 'uncategorized'].items_quantity += qty;
            categoryMap[catId || 'uncategorized'].revenue += amount;
        };

        // Sales items positive
        salesList.forEach(s => {
            (s.items || []).forEach(i => {
                const cat = i.product && i.product.category;
                addToCategory(cat ? cat.id : null, cat ? cat.name : null, Number(i.quantity || 0), Number(i.total_price || 0));
            });
        });
        // Returns items negative revenue and quantities
        returnsList.forEach(r => {
            (r.items || []).forEach(i => {
                const cat = i.product && i.product.category;
                addToCategory(cat ? cat.id : null, cat ? cat.name : null, Number(i.quantity || 0), -Number(i.total_price || 0));
            });
        });

        const categories = Object.values(categoryMap);

        const payload = {
            report_type,
            date_range: { start_date, end_date },
            summary: overall,
            categories
        };

        if (report_type === 'detailed') {
            payload.sales = salesList;
            payload.returns = returnsList;
        }

        res.json(payload);

    } catch (error) {
        console.error('Transactions report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;