// Add these routes to your backend router
const express = require("express");

const router = express.Router();
const { sale, saleitem, product, user, customer, category, productinventory, sequelize, creditnote, creditnoteitem } = require('../models');
const auth = require('../middleware/auth');
const { Op, QueryTypes } = require('sequelize');
const { annotateSalesWithReturnState, getReturnStateMap } = require('../services/sales/returnState');
const { buildActorFromUser, logRequestAudit } = require('../services/auditLogService');

function getModels(req) {
    return req.app.locals.models || require('../models');
}

function getReportAuditContext(req) {
    const exportMatch = req.path.match(/^\/([^/]+)\/export$/);
    if (req.method === 'GET' && exportMatch) {
        return { action: 'report.export', operation: 'export', reportType: exportMatch[1] };
    }

    const emailMatch = req.path.match(/^\/([^/]+)\/email$/);
    if (req.method === 'POST' && emailMatch) {
        return { action: 'report.email', operation: 'email', reportType: emailMatch[1] };
    }

    const reportTypeByPath = {
        '/sales': 'sales',
        '/transaction-list': 'transaction-list',
        '/products': 'products',
        '/inventory': 'inventory',
        '/user-activity': 'user-activity',
        '/categories': 'categories',
        '/tax': 'tax',
        '/returns': 'returns',
        '/transactions': 'transactions',
    };

    const reportType = reportTypeByPath[req.path];
    if (!reportType) {
        return null;
    }

    return { action: 'report.generate', operation: 'generate', reportType };
}

router.use((req, res, next) => {
    const auditContext = getReportAuditContext(req);

    if (!auditContext) {
        next();
        return;
    }

    res.on('finish', () => {
        if (!req.user) {
            return;
        }

        const params = req.method === 'POST' ? req.body || {} : req.query || {};

        void logRequestAudit(getModels(req), req, {
            action: auditContext.action,
            outcome: res.statusCode < 400 ? 'success' : 'failure',
            entityType: 'report',
            ...buildActorFromUser(req.user),
            target_identifier: auditContext.reportType,
            target_name: auditContext.reportType,
            details: {
                operation: auditContext.operation,
                route: req.originalUrl,
                statusCode: res.statusCode,
                start_date: params.start_date || null,
                end_date: params.end_date || null,
                report_type: params.report_type || null,
                format: params.format || null,
                email: auditContext.operation === 'email' ? params.email || null : null,
            },
        });
    });

    next();
});

async function getActiveSalesRows(rows) {
    const annotated = await annotateSalesWithReturnState(rows);
    return {
        annotated,
        active: annotated.filter(row => !row.is_fully_returned)
    };
}

async function getActiveSaleItemRows(rows) {
    const saleRows = rows
        .map(row => row.sale)
        .filter(Boolean);
    const returnStateMap = await getReturnStateMap(saleRows);
    const activeSaleIds = new Set(
        [...returnStateMap.entries()]
            .filter(([, state]) => !state.is_fully_returned)
            .map(([saleId]) => saleId)
    );
    return rows.filter(row => activeSaleIds.has(row.sale?.id));
}

function normalizePaymentMethod(method) {
    const value = String(method || '').trim().toLowerCase();
    if (value === 'cash') return 'CASH';
    if (['card', 'visa', 'mastercard', 'debit', 'credit', 'pos'].includes(value)) return 'CARD';
    if (['mobile', 'mobile money', 'mobile_money', 'mpesa', 'm-pesa', 'm pesa', 'momo', 'airtel money', 'tigo pesa'].includes(value)) return 'MOBILE_MONEY';
    return 'OTHER';
}

async function generateTraditionalReport({ startDate, endDate, storeId, userId }) {
    const replacements = { startDate, endDate, storeId, userId: userId || null };
    const userFilter = userId ? ' AND s.user_id = :userId' : '';
    const saleScope = `s.sale_date BETWEEN :startDate AND :endDate
        AND u.store_id = :storeId${userFilter}`;
    const returnScope = `cn.credit_note_date BETWEEN :startDate AND :endDate
        AND u.store_id = :storeId`;

    const select = (sql) => sequelize.query(sql, {
        replacements,
        type: QueryTypes.SELECT,
    });

    const [salesTotalsRows, salePayments, saleCategories, returnTotalsRows, returnPayments, returnCategories] = await Promise.all([
        select(`
            SELECT COUNT(*) AS transactions,
                   COALESCE(SUM(s.subtotal), 0) AS gross_sales,
                   COALESCE(SUM(s.discount_amount), 0) AS discounts,
                   COALESCE(SUM(s.tax_amount), 0) AS tax_collected,
                   COALESCE(SUM(s.total_amount), 0) AS total_amount,
                   COALESCE(SUM(items.quantity), 0) AS items_sold
            FROM sales s
            JOIN users u ON s.user_id = u.id
            LEFT JOIN (
                SELECT sale_id, SUM(quantity) AS quantity
                FROM saleitems
                GROUP BY sale_id
            ) items ON items.sale_id = s.id
            WHERE ${saleScope}
        `),
        select(`
            SELECT s.payment_method, COALESCE(SUM(s.total_amount), 0) AS amount
            FROM sales s
            JOIN users u ON s.user_id = u.id
            WHERE ${saleScope}
            GROUP BY s.payment_method
        `),
        select(`
            SELECT c.id AS category_id, COALESCE(c.name, 'Uncategorized') AS category_name,
                   COALESCE(SUM(si.quantity), 0) AS items_quantity,
                   COALESCE(SUM(si.total_price), 0) AS revenue
            FROM sales s
            JOIN users u ON s.user_id = u.id
            JOIN saleitems si ON si.sale_id = s.id
            JOIN products p ON p.id = si.product_id
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE ${saleScope}
            GROUP BY c.id, c.name
        `),
        select(`
            SELECT COUNT(*) AS returns_count,
                   COALESCE(SUM(cn.total_amount), 0) AS returns_amount,
                   COALESCE(SUM(cn.tax_amount), 0) AS returns_tax,
                   COALESCE(SUM(cn.discount_amount), 0) AS returns_discount,
                   COALESCE(SUM(items.quantity), 0) AS items_returned
            FROM credit_notes cn
            JOIN users u ON cn.user_id = u.id
            LEFT JOIN (
                SELECT credit_note_id, SUM(quantity) AS quantity
                FROM credit_note_items
                GROUP BY credit_note_id
            ) items ON items.credit_note_id = cn.id
            WHERE ${returnScope}
        `),
        select(`
            SELECT cn.payment_method, COALESCE(SUM(cn.total_amount), 0) AS amount
            FROM credit_notes cn
            JOIN users u ON cn.user_id = u.id
            WHERE ${returnScope}
            GROUP BY cn.payment_method
        `),
        select(`
            SELECT c.id AS category_id, COALESCE(c.name, 'Uncategorized') AS category_name,
                   COALESCE(SUM(cni.quantity), 0) AS items_quantity,
                   COALESCE(SUM(cni.total_price), 0) AS revenue
            FROM credit_notes cn
            JOIN users u ON cn.user_id = u.id
            JOIN credit_note_items cni ON cni.credit_note_id = cn.id
            JOIN products p ON p.id = cni.product_id
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE ${returnScope}
            GROUP BY c.id, c.name
        `),
    ]);

    const salesTotals = salesTotalsRows[0] || {};
    const returnTotals = returnTotalsRows[0] || {};
    const payments = { CASH: 0, CARD: 0, MOBILE_MONEY: 0, OTHER: 0 };
    for (const row of salePayments) {
        const key = normalizePaymentMethod(row.payment_method);
        payments[key] += Number(row.amount || 0);
    }
    for (const row of returnPayments) {
        const key = normalizePaymentMethod(row.payment_method);
        payments[key] -= Number(row.amount || 0);
    }

    const categories = new Map();
    for (const row of saleCategories) {
        const key = row.category_id == null ? 'uncategorized' : String(row.category_id);
        categories.set(key, {
            category_id: row.category_id || null,
            category_name: row.category_name,
            items_quantity: Number(row.items_quantity || 0),
            revenue: Number(row.revenue || 0),
        });
    }
    for (const row of returnCategories) {
        const key = row.category_id == null ? 'uncategorized' : String(row.category_id);
        const current = categories.get(key) || {
            category_id: row.category_id || null,
            category_name: row.category_name,
            items_quantity: 0,
            revenue: 0,
        };
        current.items_quantity -= Number(row.items_quantity || 0);
        current.revenue -= Number(row.revenue || 0);
        categories.set(key, current);
    }

    const grossSales = Number(salesTotals.gross_sales || 0);
    const discounts = Number(salesTotals.discounts || 0);
    const salesTotalAmount = Number(salesTotals.total_amount || 0);
    const returnsAmount = Number(returnTotals.returns_amount || 0);

    return {
        counts: {
            transactions: Number(salesTotals.transactions || 0),
            returns: Number(returnTotals.returns_count || 0),
            items_sold: Number(salesTotals.items_sold || 0),
            items_returned: Number(returnTotals.items_returned || 0),
        },
        totals: {
            gross_sales: grossSales,
            discounts,
            net_sales_before_tax: Math.max(grossSales - discounts, 0),
            tax_collected: Number(salesTotals.tax_collected || 0),
            returns_amount: returnsAmount,
            returns_tax: Number(returnTotals.returns_tax || 0),
            returns_discount: Number(returnTotals.returns_discount || 0),
            net_revenue: salesTotalAmount - returnsAmount,
        },
        payments,
        categories: [...categories.values()],
    };
}

// Dashboard Statistics (unified)
router.get('/dashboard', auth, async (req, res) => {
    try {
        const { computeDashboardStats } = require('../services/reports/dashboardStats');
        const data = await computeDashboardStats(req);
        res.json({ success: true, data, timestamp: new Date().toISOString() });
    } catch (error) {
        console.error('Dashboard stats error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Sales Report (comprehensive)
router.get('/sales', auth, async (req, res) => {
    try {
        const { start_date, end_date, report_type = 'summary', category_id, product_id, user_id } = req.query;

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

        const filterStoreId = req.user.store_id;
        const isTraditionalReport = ['x', 'z'].includes(String(report_type).toLowerCase());

        if (isTraditionalReport) {
            const isZ = String(report_type).toLowerCase() === 'z';
            const traditional = await generateTraditionalReport({
                startDate,
                endDate,
                storeId: filterStoreId,
                userId: user_id,
            });

            traditional.report_name = isZ ? 'Z Report' : 'X Report';
            traditional.period = { start: start_date, end: end_date };
            traditional.store_id = filterStoreId || null;
            traditional.cashier = req.user?.full_name
                ? { id: req.user.id, name: req.user.full_name }
                : undefined;

            return res.json({
                report_type: isZ ? 'Z' : 'X',
                date_range: { start_date, end_date },
                traditional,
            });
        }

        const itemInclude = {
            model: saleitem,
            as: 'items',
            ...(isTraditionalReport ? { attributes: ['id', 'product_id', 'quantity', 'total_price'] } : {}),
            include: [{
                model: product,
                as: 'product',
                ...(isTraditionalReport ? { attributes: ['id', 'category_id'] } : {}),
                include: [{
                    model: category,
                    as: 'category',
                    ...(isTraditionalReport ? { attributes: ['id', 'name'] } : {})
                }]
            }]
        };

        const includeClause = [
            { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
            ...(!isTraditionalReport ? [{ model: customer, as: 'customer' }] : []),
            itemInclude
        ];

        // Filter by category or product if specified
        if (category_id || product_id) {
            itemInclude.where = {};
            if (product_id) {
                itemInclude.where.product_id = product_id;
            }
            if (category_id) {
                itemInclude.include[0].where = { category_id };
            }
        }

        const sales = await sale.findAll({
            ...(isTraditionalReport ? {
                attributes: [
                    'id', 'user_id', 'subtotal', 'discount_amount', 'tax_amount',
                    'total_amount', 'payment_method', 'payments_breakdown', 'sale_date'
                ]
            } : {}),
            where: whereClause,
            include: includeClause,
            order: [['sale_date', 'DESC']]
        });

        const activeSales = (await getActiveSalesRows(sales)).active;

        const summary = {
            total_sales: activeSales.length,
            total_revenue: activeSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0),
            total_discounts: activeSales.reduce((sum, s) => sum + parseFloat(s.discount_amount || 0), 0),
            total_tax: activeSales.reduce((sum, s) => sum + parseFloat(s.tax_amount || 0), 0),
            items_count: activeSales.reduce((sum, s) => sum + (s.items ? s.items.length : 0), 0),
            items_quantity: activeSales.reduce((sum, s) => sum + (s.items ? s.items.reduce((q, i) => q + Number(i.quantity || 0), 0) : 0), 0),
            payment_methods: {},
            daily_breakdown: {}
        };

        // Group by payment method (allocating mixed payments) and daily breakdown
        activeSales.forEach(s => {
            const date = s.sale_date.toDateString();

            // Allocate by payment breakdown if present
            const bd = s.payments_breakdown;
            if (bd && typeof bd === 'object') {
                const total = Object.values(bd).reduce((a, v) => a + Number(v || 0), 0) || 0;
                if (total > 0) {
                    Object.entries(bd).forEach(([method, amt]) => {
                        const key = method || 'unknown';
                        summary.payment_methods[key] = (summary.payment_methods[key] || 0) + Number(amt || 0);
                    });
                } else {
                    const method = s.payment_method || 'unknown';
                    summary.payment_methods[method] = (summary.payment_methods[method] || 0) + parseFloat(s.total_amount || 0);
                }
            } else {
                const method = s.payment_method || 'unknown';
                summary.payment_methods[method] = (summary.payment_methods[method] || 0) + parseFloat(s.total_amount || 0);
            }

            if (!summary.daily_breakdown[date]) {
                summary.daily_breakdown[date] = { sales: 0, revenue: 0 };
            }
            summary.daily_breakdown[date].sales++;
            summary.daily_breakdown[date].revenue += parseFloat(s.total_amount || 0);
        });

        // Traditional X/Z format support on /reports/sales using the same endpoint
        if (isTraditionalReport) {
            const isZ = report_type.toLowerCase() === 'z';

            // Fetch returns within the same date range to net against sales
            const returnsInclude = [
                { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
                {
                    model: creditnoteitem,
                    as: 'items',
                    attributes: ['id', 'product_id', 'quantity', 'total_price'],
                    include: [{
                        model: product,
                        as: 'product',
                        attributes: ['id', 'category_id'],
                        include: [{ model: category, as: 'category', attributes: ['id', 'name'] }]
                    }]
                }
            ];

            const returnsList = await creditnote.findAll({
                attributes: [
                    'id', 'user_id', 'subtotal', 'discount_amount', 'tax_amount',
                    'total_amount', 'payment_method', 'credit_note_date'
                ],
                where: { credit_note_date: { [Op.between]: [startDate, endDate] } },
                include: returnsInclude
            });

            const grossSales = activeSales.reduce((sum, s) => sum + Number(s.subtotal || 0), 0);
            const discounts = activeSales.reduce((sum, s) => sum + Number(s.discount_amount || 0), 0);
            const tax = activeSales.reduce((sum, s) => sum + Number(s.tax_amount || 0), 0);
            const salesTotalAmount = activeSales.reduce((sum, s) => sum + Number(s.total_amount || 0), 0);
            const returnsTotalAmount = returnsList.reduce((sum, r) => sum + Number(r.total_amount || 0), 0);
            const returnsTax = returnsList.reduce((sum, r) => sum + Number(r.tax_amount || 0), 0);
            const returnsDiscount = returnsList.reduce((sum, r) => sum + Number(r.discount_amount || 0), 0);

            // Normalize to CASH, CARD, MOBILE_MONEY, OTHER
            const normalizeMethod = (m) => {
                const x = (m || '').toString().trim().toLowerCase();
                if (x === 'cash') return 'CASH';
                if (['card', 'visa', 'mastercard', 'debit', 'credit', 'pos'].includes(x)) return 'CARD';
                if (['mobile', 'mobile money', 'mobile_money', 'mpesa', 'm-pesa', 'm pesa', 'momo', 'airtel money', 'tigo pesa'].includes(x)) return 'MOBILE_MONEY';
                return 'OTHER';
            };

            const paymentBreakdown = { CASH: 0, CARD: 0, MOBILE_MONEY: 0, OTHER: 0 };
            activeSales.forEach(s => {
                const bd = s.payments_breakdown;
                if (bd && typeof bd === 'object') {
                    Object.entries(bd).forEach(([method, amt]) => {
                        const key = normalizeMethod(method);
                        paymentBreakdown[key] = (paymentBreakdown[key] || 0) + Number(amt || 0);
                    });
                } else {
                    const key = normalizeMethod(s.payment_method);
                    paymentBreakdown[key] = (paymentBreakdown[key] || 0) + Number(s.total_amount || 0);
                }
            });
            returnsList.forEach(r => {
                const key = normalizeMethod(r.payment_method);
                paymentBreakdown[key] = (paymentBreakdown[key] || 0) - Number(r.total_amount || 0);
            });

            const itemsSold = activeSales.reduce((s, x) => s + ((x.items || []).reduce((q, i) => q + Number(i.quantity || 0), 0)), 0);
            const itemsReturned = returnsList.reduce((s, x) => s + ((x.items || []).reduce((q, i) => q + Number(i.quantity || 0), 0)), 0);

            // Category summary (net of returns)
            const categoryMap = {};
            const addToCategory = (catId, catName, qty, amount) => {
                const key = catId || 'uncategorized';
                if (!categoryMap[key]) {
                    categoryMap[key] = { category_id: catId || null, category_name: catName || 'Uncategorized', items_quantity: 0, revenue: 0 };
                }
                categoryMap[key].items_quantity += qty;
                categoryMap[key].revenue += amount;
            };
            activeSales.forEach(saleRow => {
                (saleRow.items || []).forEach(i => {
                    const cat = i.product && i.product.category;
                    addToCategory(cat ? cat.id : null, cat ? cat.name : null, Number(i.quantity || 0), Number(i.total_price || 0));
                });
            });
            returnsList.forEach(ret => {
                (ret.items || []).forEach(i => {
                    const cat = i.product && i.product.category;
                    addToCategory(cat ? cat.id : null, cat ? cat.name : null, Number(i.quantity || 0), -Number(i.total_price || 0));
                });
            });

            const traditional = {
                report_name: isZ ? 'Z Report' : 'X Report',
                period: { start: start_date, end: end_date },
                store_id: req.user && req.user.store_id ? req.user.store_id : null,
                cashier: req.user && req.user.full_name ? { id: req.user.id, name: req.user.full_name } : undefined,
                counts: {
                    transactions: activeSales.length,
                    returns: returnsList.length,
                    items_sold: itemsSold,
                    items_returned: itemsReturned
                },
                totals: {
                    gross_sales: grossSales,
                    discounts: discounts,
                    net_sales_before_tax: Math.max(grossSales - discounts, 0),
                    tax_collected: tax,
                    returns_amount: returnsTotalAmount,
                    returns_tax: returnsTax,
                    returns_discount: returnsDiscount,
                    net_revenue: salesTotalAmount - returnsTotalAmount
                },
                payments: paymentBreakdown,
                categories: Object.values(categoryMap)
            };

            return res.json({ report_type: isZ ? 'Z' : 'X', date_range: { start_date, end_date }, traditional });
        }

        res.json({
            report_type,
            date_range: { start_date, end_date },
            sales: activeSales,
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

        const activeSales = (await getActiveSalesRows(sales)).active;

        // Group items across all sales
        const itemMap = {};

        activeSales.forEach(s => {
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
            total_transactions: activeSales.length,
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
        const filterStoreId = req.user.store_id;

        let includeWhere = {
            '$sale.sale_date$': { [Op.between]: [startDate, endDate] }
        };

        if (category_id) {
            includeWhere['$product.category_id$'] = category_id;
        }

        const productSalesRows = await saleitem.findAll({
            where: includeWhere,
            include: [
                {
                    model: product,
                    as: 'product',
                    include: [{ model: category, as: 'category' }]
                },
                {
                    model: sale,
                    as: 'sale',
                    required: true,
                    include: [{
                        model: user,
                        as: 'cashier',
                        attributes: [],
                        ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {})
                    }]
                }
            ]
        });

        const activeProductSalesRows = await getActiveSaleItemRows(productSalesRows);
        const productMap = new Map();

        activeProductSalesRows.forEach(row => {
            const current = productMap.get(row.product_id) || {
                product_id: row.product_id,
                product_name: row.product?.name || 'Unknown Product',
                product_class_code: row.product?.product_class_code || '',
                total_quantity: 0,
                total_revenue: 0,
                transaction_count: 0,
            };
            current.total_quantity += Number(row.quantity || 0);
            current.total_revenue += Number(row.total_price || 0);
            current.transaction_count += 1;
            productMap.set(row.product_id, current);
        });

        const productSales = [...productMap.values()].sort((a, b) => b.total_revenue - a.total_revenue).slice(0, parseInt(limit));

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
        const filterStoreId = req.user.store_id;

        let whereClause = {
            sale_date: { [Op.between]: [startDate, endDate] }
        };

        if (user_id) {
            whereClause.user_id = user_id;
        }

        const userSales = await sale.findAll({
            where: whereClause,
            include: [{
                model: user,
                as: 'cashier',
                attributes: ['id', 'full_name', 'role', 'store_id'],
                ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {})
            }]
        });

        const activeUserSales = (await getActiveSalesRows(userSales)).active;
        const userActivityMap = new Map();

        activeUserSales.forEach(s => {
            const key = s.user_id;
            const current = userActivityMap.get(key) || {
                user_id: key,
                cashier: s.cashier || null,
                total_sales: 0,
                total_revenue: 0,
            };
            current.total_sales += 1;
            current.total_revenue += Number(s.total_amount || 0);
            userActivityMap.set(key, current);
        });

        res.json({
            date_range: { start_date, end_date },
            user_activity: [...userActivityMap.values()].sort((a, b) => b.total_sales - a.total_sales)
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
        const filterStoreId = req.user.store_id;

        const categorySalesRows = await saleitem.findAll({
            where: {
                '$sale.sale_date$': { [Op.between]: [startDate, endDate] }
            },
            include: [
                {
                    model: product,
                    as: 'product',
                    include: [{ model: category, as: 'category' }]
                },
                {
                    model: sale,
                    as: 'sale',
                    required: true,
                    include: [{
                        model: user,
                        as: 'cashier',
                        attributes: [],
                        ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {})
                    }]
                }
            ]
        });

        const activeCategorySalesRows = await getActiveSaleItemRows(categorySalesRows);
        const categoryMap = new Map();

        activeCategorySalesRows.forEach(row => {
            const cat = row.product && row.product.category;
            const key = cat ? cat.id : 'uncategorized';
            const current = categoryMap.get(key) || {
                category_id: cat ? cat.id : null,
                category_name: cat ? cat.name : 'Uncategorized',
                total_quantity: 0,
                total_revenue: 0,
                transaction_count: 0,
            };
            current.total_quantity += Number(row.quantity || 0);
            current.total_revenue += Number(row.total_price || 0);
            current.transaction_count += 1;
            categoryMap.set(key, current);
        });

        const categorySales = [...categoryMap.values()].sort((a, b) => b.total_revenue - a.total_revenue);

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
        const filterStoreId = req.user.store_id;

        const taxSales = await sale.findAll({
            where: {
                sale_date: { [Op.between]: [startDate, endDate] }
            },
            include: [{
                model: user,
                as: 'cashier',
                attributes: [],
                ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {})
            }]
        });
        const activeTaxSales = (await getActiveSalesRows(taxSales)).active;

        const taxSummary = activeTaxSales.reduce((acc, saleRow) => {
            acc.total_subtotal += Number(saleRow.subtotal || 0);
            acc.total_tax += Number(saleRow.tax_amount || 0);
            acc.total_with_tax += Number(saleRow.total_amount || 0);
            acc.total_transactions += 1;
            return acc;
        }, {
            total_subtotal: 0,
            total_tax: 0,
            total_with_tax: 0,
            total_transactions: 0,
        });

        const dailyMap = new Map();
        activeTaxSales.forEach(saleRow => {
            const key = saleRow.sale_date ? new Date(saleRow.sale_date).toISOString().slice(0, 10) : 'unknown';
            const current = dailyMap.get(key) || {
                date: key,
                daily_tax: 0,
                daily_transactions: 0,
            };
            current.daily_tax += Number(saleRow.tax_amount || 0);
            current.daily_transactions += 1;
            dailyMap.set(key, current);
        });

        res.json({
            date_range: { start_date, end_date },
            summary: taxSummary,
            daily_breakdown: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date))
        });

    } catch (error) {
        console.error('Tax report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// // Export Report Route
// router.get('/:reportType/export', auth, async (req, res) => {
//     try {
//         const { reportType } = req.params;
//         const { format, start_date, end_date, ...additionalParams } = req.query;

//         // Only XLSX export is supported currently (frontend requests XLSX)
//         if (!format || format.toLowerCase() !== 'xlsx') {
//             return res.status(400).json({ message: 'Invalid or unsupported format. Use xlsx' });
//         }

//         if (!start_date || !end_date) {
//             return res.status(400).json({ message: 'start_date and end_date are required' });
//         }

//         const startDate = new Date(start_date);
//         const endDate = new Date(end_date);
//         if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
//             return res.status(400).json({ message: 'Invalid date format. Use ISO 8601' });
//         }

//         const storeId = req.user?.store_id;

//         // Generate report data using the corresponding generator
//         let reportData = [];
//         switch (reportType) {
//             case 'sales':
//                 reportData = await generateSalesReport(startDate, endDate, storeId, additionalParams);
//                 break;
//             case 'products':
//                 reportData = await generateProductsReport(startDate, endDate, storeId, additionalParams);
//                 break;
//             case 'inventory':
//                 reportData = await generateInventoryReport(startDate, endDate, storeId, additionalParams);
//                 break;
//             case 'user-activity':
//                 reportData = await generateUserActivityReport(startDate, endDate, storeId, additionalParams);
//                 break;
//             case 'categories':
//                 reportData = await generateCategoriesReport(startDate, endDate, storeId, additionalParams);
//                 break;
//             case 'tax':
//                 reportData = await generateTaxReport(startDate, endDate, storeId, additionalParams);
//                 break;
//             default:
//                 return res.status(400).json({ message: 'Invalid report type' });
//         }

//         if (!reportData || reportData.length === 0) {
//             return res.status(404).json({ message: 'No data found for the specified date range' });
//         }

//         const workbook = await createExcelReport(reportType, reportData, startDate, endDate);
//         const buffer = await workbook.xlsx.writeBuffer();

//         const fileName = `${reportType}_report_${startDate.toISOString().slice(0,10)}_${endDate.toISOString().slice(0,10)}.xlsx`;
//         res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
//         res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
//         res.send(Buffer.from(buffer));

//     } catch (error) {
//         console.error('Export report error:', error);
//         res.status(500).json({ message: 'Server error' });
//     }
// });


// Export Report Route
router.get('/:reportType/export', auth, async (req, res) => {
    const startTime = Date.now();
    console.log('========================================');
    console.log(`📊 EXPORT REPORT REQUEST STARTED at ${new Date().toISOString()}`);
    console.log('========================================');
    
    try {
        const { reportType } = req.params;
        const { format, start_date, end_date, ...additionalParams } = req.query;
        
        console.log(`🔍 Request Parameters:`);
        console.log(`  - reportType: ${reportType}`);
        console.log(`  - format: ${format}`);
        console.log(`  - start_date: ${start_date}`);
        console.log(`  - end_date: ${end_date}`);
        console.log(`  - additionalParams:`, JSON.stringify(additionalParams, null, 2));
        console.log(`  - user: ${req.user?.id || 'unknown'} (store: ${req.user?.store_id || 'none'})`);

        // Step 1: Validate format
        console.log(`\n📌 Step 1: Validating export format...`);
        if (!format || format.toLowerCase() !== 'xlsx') {
            console.log(`❌ FORMAT VALIDATION FAILED: Invalid or unsupported format '${format}'`);
            console.log(`   Expected: 'xlsx'`);
            return res.status(400).json({ 
                message: 'Invalid or unsupported format. Use xlsx',
                received: format,
                expected: 'xlsx'
            });
        }
        console.log(`✅ Format validation passed: ${format}`);

        // Step 2: Validate dates
        console.log(`\n📌 Step 2: Validating date parameters...`);
        if (!start_date || !end_date) {
            console.log(`❌ DATE VALIDATION FAILED: Missing required dates`);
            console.log(`   start_date: ${start_date || 'undefined'}`);
            console.log(`   end_date: ${end_date || 'undefined'}`);
            return res.status(400).json({ 
                message: 'start_date and end_date are required',
                start_date: start_date || 'missing',
                end_date: end_date || 'missing'
            });
        }
        console.log(`   start_date string: ${start_date}`);
        console.log(`   end_date string: ${end_date}`);

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            console.log(`❌ DATE VALIDATION FAILED: Invalid date format`);
            console.log(`   startDate invalid: ${isNaN(startDate.getTime())}`);
            console.log(`   endDate invalid: ${isNaN(endDate.getTime())}`);
            return res.status(400).json({ 
                message: 'Invalid date format. Use ISO 8601',
                start_date: start_date,
                end_date: end_date
            });
        }

        if (startDate > endDate) {
            return res.status(400).json({ message: 'start_date cannot be after end_date' });
        }

        console.log(`   Parsed start_date: ${startDate.toISOString()}`);
        console.log(`   Parsed end_date: ${endDate.toISOString()}`);
        console.log(`✅ Date validation passed`);

        // Step 3: Get store ID
        const storeId = req.user?.store_id;
        console.log(`\n📌 Step 3: Store context`);
        console.log(`   Store ID: ${storeId || 'N/A'}`);

        // Step 4: Generate report data
        console.log(`\n📌 Step 4: Generating report data for type: ${reportType}`);
        console.log(`   Date range: ${startDate.toISOString()} to ${endDate.toISOString()}`);
        
        let reportData = [];
        const generateStartTime = Date.now();
        
        try {
            switch (reportType) {
                case 'sales':
                    console.log(`   🔄 Calling generateSalesReport...`);
                    reportData = await generateSalesReport(startDate, endDate, storeId, additionalParams);
                    break;
                case 'products':
                    console.log(`   🔄 Calling generateProductsReport...`);
                    reportData = await generateProductsReport(startDate, endDate, storeId, additionalParams);
                    break;
                case 'inventory':
                    console.log(`   🔄 Calling generateInventoryReport...`);
                    reportData = await generateInventoryReport(startDate, endDate, storeId, additionalParams);
                    break;
                case 'user-activity':
                    console.log(`   🔄 Calling generateUserActivityReport...`);
                    reportData = await generateUserActivityReport(startDate, endDate, storeId, additionalParams);
                    break;
                case 'categories':
                    console.log(`   🔄 Calling generateCategoriesReport...`);
                    reportData = await generateCategoriesReport(startDate, endDate, storeId, additionalParams);
                    break;
                case 'tax':
                    console.log(`   🔄 Calling generateTaxReport...`);
                    reportData = await generateTaxReport(startDate, endDate, storeId, additionalParams);
                    break;
                default:
                    console.log(`❌ INVALID REPORT TYPE: ${reportType}`);
                    console.log(`   Available types: sales, products, inventory, user-activity, categories, tax`);
                    return res.status(400).json({ 
                        message: 'Invalid report type',
                        received: reportType,
                        available: ['sales', 'products', 'inventory', 'user-activity', 'categories', 'tax']
                    });
            }
            
            const generateDuration = ((Date.now() - generateStartTime) / 1000).toFixed(2);
            console.log(`   ✅ Report data generated in ${generateDuration}s`);
            console.log(`   📊 Data rows returned: ${reportData?.length || 0}`);
            
            // Log sample of data if available
            if (reportData && reportData.length > 0) {
                console.log(`   📋 First row sample:`, JSON.stringify(reportData[0], null, 2));
            } else {
                console.log(`   ⚠️ No data rows returned`);
            }
            
        } catch (generateError) {
            console.error(`❌ ERROR in report generator (${reportType}):`);
            console.error(`   Message: ${generateError.message}`);
            console.error(`   Stack:`, generateError.stack);
            
            // Log additional context based on error type
            if (generateError.sql) {
                console.error(`   SQL Query: ${generateError.sql}`);
            }
            if (generateError.parameters) {
                console.error(`   Parameters:`, generateError.parameters);
            }
            
            return res.status(500).json({ 
                message: `Failed to generate ${reportType} report data`,
                error: generateError.message,
                type: reportType
            });
        }

        // Step 5: Validate data
        console.log(`\n📌 Step 5: Validating report data...`);
        if (!reportData || reportData.length === 0) {
            console.log(`⚠️ No data found for the specified date range`);
            console.log(`   Date range: ${start_date} to ${end_date}`);
            console.log(`   Report type: ${reportType}`);
            console.log(`   Store ID: ${storeId || 'N/A'}`);
            return res.status(404).json({ 
                message: 'No data found for the specified date range',
                date_range: { start_date, end_date },
                report_type: reportType
            });
        }
        console.log(`✅ Data validation passed: ${reportData.length} rows found`);

        // Step 6: Create Excel workbook
        console.log(`\n📌 Step 6: Creating Excel workbook...`);
        let workbook;
        const excelStartTime = Date.now();
        
        try {
            workbook = await createExcelReport(reportType, reportData, startDate, endDate);
            console.log(`   ✅ Excel workbook created successfully`);
        } catch (excelError) {
            console.error(`❌ ERROR creating Excel workbook:`);
            console.error(`   Message: ${excelError.message}`);
            console.error(`   Stack:`, excelError.stack);
            return res.status(500).json({ 
                message: 'Failed to create Excel report',
                error: excelError.message
            });
        }

        // Step 7: Write buffer
        console.log(`\n📌 Step 7: Writing Excel buffer...`);
        let buffer;
        const bufferStartTime = Date.now();
        
        try {
            buffer = await workbook.xlsx.writeBuffer();
            const bufferSize = (buffer.length / 1024).toFixed(2);
            console.log(`   ✅ Buffer written successfully (${bufferSize} KB)`);
        } catch (bufferError) {
            console.error(`❌ ERROR writing Excel buffer:`);
            console.error(`   Message: ${bufferError.message}`);
            console.error(`   Stack:`, bufferError.stack);
            return res.status(500).json({ 
                message: 'Failed to write Excel file',
                error: bufferError.message
            });
        }

        // Step 8: Prepare response
        console.log(`\n📌 Step 8: Preparing response...`);
        const fileName = `${reportType}_report_${startDate.toISOString().slice(0,10)}_${endDate.toISOString().slice(0,10)}.xlsx`;
        console.log(`   File name: ${fileName}`);
        console.log(`   Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`);
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
        
        console.log(`✅ Sending response...`);
        const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`\n========================================`);
        console.log(`✅ EXPORT COMPLETED SUCCESSFULLY in ${totalDuration}s`);
        console.log(`   Report: ${reportType}`);
        console.log(`   Rows: ${reportData.length}`);
        console.log(`   Date range: ${start_date} to ${end_date}`);
        console.log(`   File: ${fileName}`);
        console.log(`   Size: ${(buffer.length / 1024).toFixed(2)} KB`);
        console.log('========================================\n');
        
        res.send(Buffer.from(buffer));

    } catch (error) {
        const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error(`\n❌❌❌ EXPORT REPORT ERROR after ${totalDuration}s ❌❌❌`);
        console.error(`   Message: ${error.message}`);
        console.error(`   Stack:`, error.stack);
        
        // Log request context on error
        console.error(`\n📋 Request Context:`);
        console.error(`   URL: ${req.originalUrl}`);
        console.error(`   Method: ${req.method}`);
        console.error(`   Params:`, req.params);
        console.error(`   Query:`, req.query);
        console.error(`   User: ${req.user?.id || 'unknown'}`);
        console.error(`   Store: ${req.user?.store_id || 'none'}`);
        
        // Check for specific error types
        if (error.name === 'SequelizeError') {
            console.error(`\n💾 Database Error Details:`);
            console.error(`   SQL: ${error.sql || 'No SQL available'}`);
            console.error(`   Parameters:`, error.parameters || 'No parameters');
        }
        
        if (error.code === 'ECONNREFUSED') {
            console.error(`\n🔌 Connection Error: Database connection refused`);
        }
        
        if (error.code === 'ETIMEDOUT') {
            console.error(`\n⏰ Timeout Error: Database query timed out`);
        }
        
        console.error('\n========================================\n');
        
        res.status(500).json({ 
            message: 'Server error',
            error: error.message,
            type: error.name,
            code: error.code,
            timestamp: new Date().toISOString()
        });
    }
});

// Email Report Route - All reports are sent in Excel format only
const ExcelJS = require('exceljs');
const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');
const { pool } = require('../config/database'); // Adjust path as needed

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
            s.id as sale_id,
            s.invoice_no,
            s.receipt_no,
            s.total_amount,
            s.payment_method,
            s.sale_date as created_at,
            u.full_name as cashier_name,
            COALESCE(st.store_number, st.store_location, CAST(st.id AS CHAR)) as store_name,
            COUNT(si.id) as items_count
        FROM sales s
        LEFT JOIN users u ON s.user_id = u.id
        LEFT JOIN stores st ON u.store_id = st.id
        LEFT JOIN saleitems si ON s.id = si.sale_id
        WHERE s.sale_date BETWEEN ? AND ?
        ${storeId ? 'AND u.store_id = ?' : ''}
        GROUP BY s.id
        ORDER BY s.sale_date DESC
    `;

    const params = storeId ? [startDate, endDate, storeId] : [startDate, endDate];
    const [rows] = await pool.query(query, params);
    return rows;
};

const generateProductsReport = async (startDate, endDate, storeId, additionalParams) => {
    const query = `
        SELECT 
            p.id as product_id,
            p.name as product_name,
            p.product_class_code,
            c.name as category_name,
            p.price as unit_price,
            COALESCE(pi.stock_quantity, 0) as stock_quantity,
            COALESCE(SUM(CASE WHEN u.id IS NOT NULL THEN si.quantity ELSE 0 END), 0) as total_sold,
            COALESCE(SUM(CASE WHEN u.id IS NOT NULL THEN si.quantity * si.unit_price ELSE 0 END), 0) as total_revenue
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN productinventories pi ON p.id = pi.product_id AND pi.store_id = ?
        LEFT JOIN saleitems si ON p.id = si.product_id
        LEFT JOIN sales s ON si.sale_id = s.id AND s.sale_date BETWEEN ? AND ?
        LEFT JOIN users u ON s.user_id = u.id AND u.store_id = ?
        GROUP BY p.id, p.name, p.product_class_code, c.name, p.price, pi.stock_quantity
        ORDER BY total_revenue DESC
    `;

    const [rows] = await pool.query(query, [storeId, startDate, endDate, storeId]);
    return rows;
};

const generateInventoryReport = async (startDate, endDate, storeId, additionalParams) => {
    const query = `
        SELECT 
            p.id as product_id,
            p.name as product_name,
            p.product_class_code,
            c.name as category_name,
            p.price as unit_price,
            pi.stock_quantity,
            pi.min_stock_level as reorder_level,
            CASE 
                WHEN pi.stock_quantity = 0 THEN 'Out of Stock'
                WHEN pi.stock_quantity <= pi.min_stock_level THEN 'Low Stock'
                ELSE 'In Stock'
            END as stock_status,
            pi.updated_at as last_updated
        FROM productinventories pi
        JOIN products p ON pi.product_id = p.id
        LEFT JOIN categories c ON p.category_id = c.id
        WHERE pi.store_id = ?
        ORDER BY pi.stock_quantity ASC, p.name ASC
    `;

    const [rows] = await pool.query(query, [storeId]);
    return rows;
};

const generateUserActivityReport = async (startDate, endDate, storeId, additionalParams) => {
    const query = `
        SELECT 
            u.id as user_id,
            u.full_name,
            u.username,
            u.role,
            COUNT(DISTINCT s.id) as total_sales,
            COALESCE(SUM(s.total_amount), 0) as total_revenue,
            MIN(s.sale_date) as first_sale,
            MAX(s.sale_date) as last_sale
        FROM users u
        LEFT JOIN sales s ON u.id = s.user_id AND s.sale_date BETWEEN ? AND ?
        WHERE u.store_id = ?
        GROUP BY u.id, u.full_name, u.username, u.role
        ORDER BY total_revenue DESC
    `;

    const [rows] = await pool.query(query, [startDate, endDate, storeId]);
    return rows;
};

const generateCategoriesReport = async (startDate, endDate, storeId, additionalParams) => {
    const query = `
        SELECT 
            c.id as category_id,
            c.name as category_name,
            COUNT(DISTINCT p.id) as products_count,
            COALESCE(SUM(si.quantity), 0) as total_items_sold,
            COALESCE(SUM(si.quantity * si.unit_price), 0) as total_revenue
        FROM categories c
        JOIN products p ON c.id = p.category_id
        JOIN saleitems si ON p.id = si.product_id
        JOIN sales s ON si.sale_id = s.id AND s.sale_date BETWEEN ? AND ?
        JOIN users u ON s.user_id = u.id
        WHERE u.store_id = ?
        GROUP BY c.id, c.name
        ORDER BY total_revenue DESC
    `;

    const [rows] = await pool.query(query, [startDate, endDate, storeId]);
    return rows;
};

const generateTaxReport = async (startDate, endDate, storeId, additionalParams) => {
    const query = `
        SELECT 
            DATE(s.sale_date) as sale_date,
            COUNT(s.id) as transactions_count,
            SUM(s.total_amount) as gross_sales,
            SUM(s.total_amount * 0.16) as vat_collected,
            SUM(s.total_amount * 0.84) as net_sales,
            s.payment_method
        FROM sales s
        JOIN users u ON s.user_id = u.id
        WHERE s.sale_date BETWEEN ? AND ?
        ${storeId ? 'AND u.store_id = ?' : ''}
        GROUP BY DATE(s.sale_date), s.payment_method
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
                { header: 'Username', key: 'username', width: 30 },
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
        if (tempFilePath) {
            await fs.unlink(tempFilePath).catch(() => {});
        }

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

        // Traditional X/Z format support using the same endpoint
        if (['x', 'z', 'X', 'Z'].includes(report_type)) {
            const isZ = report_type.toLowerCase() === 'z';
            const grossSales = salesList.reduce((sum, s) => sum + Number(s.subtotal || 0), 0);
            const discounts = salesList.reduce((sum, s) => sum + Number(s.discount_amount || 0), 0);
            const tax = salesList.reduce((sum, s) => sum + Number(s.tax_amount || 0), 0);
            const salesTotalAmount = salesList.reduce((sum, s) => sum + Number(s.total_amount || 0), 0);
            const returnsTotalAmount = returnsList.reduce((sum, r) => sum + Number(r.total_amount || 0), 0);
            const returnsTax = returnsList.reduce((sum, r) => sum + Number(r.tax_amount || 0), 0);
            const returnsDiscount = returnsList.reduce((sum, r) => sum + Number(r.discount_amount || 0), 0);

            // Payment methods breakdown (net of returns if method matches)
            const paymentBreakdown = {};
            salesList.forEach(s => {
                const bd = s.payments_breakdown;
                if (bd && typeof bd === 'object') {
                    Object.entries(bd).forEach(([method, amt]) => {
                        const key = (method || 'unknown').toString();
                        paymentBreakdown[key] = (paymentBreakdown[key] || 0) + Number(amt || 0);
                    });
                } else {
                    const method = s.payment_method || 'unknown';
                    paymentBreakdown[method] = (paymentBreakdown[method] || 0) + Number(s.total_amount || 0);
                }
            });
            returnsList.forEach(r => {
                const method = r.payment_method || 'unknown';
                paymentBreakdown[method] = (paymentBreakdown[method] || 0) - Number(r.total_amount || 0);
            });

            const traditional = {
                report_name: isZ ? 'Z Report' : 'X Report',
                period: { start: start_date, end: end_date },
                store_id: req.user && req.user.store_id ? req.user.store_id : null,
                cashier: req.user && req.user.full_name ? { id: req.user.id, name: req.user.full_name } : undefined,
                counts: {
                    transactions: salesList.length,
                    returns: returnsList.length,
                    items_sold: salesList.reduce((s, x) => s + ((x.items || []).reduce((q, i) => q + Number(i.quantity || 0), 0)), 0),
                    items_returned: returnsList.reduce((s, x) => s + ((x.items || []).reduce((q, i) => q + Number(i.quantity || 0), 0)), 0)
                },
                totals: {
                    gross_sales: grossSales,
                    discounts: discounts,
                    net_sales_before_tax: Math.max(grossSales - discounts, 0),
                    tax_collected: tax,
                    returns_amount: returnsTotalAmount,
                    returns_tax: returnsTax,
                    returns_discount: returnsDiscount,
                    net_revenue: salesTotalAmount - returnsTotalAmount
                },
                payments: paymentBreakdown,
                categories
            };

            return res.json({ report_type: isZ ? 'Z' : 'X', date_range: { start_date, end_date }, traditional });
        }

        res.json(payload);

    } catch (error) {
        console.error('Transactions report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;


// const express = require('express');
// const router = express.Router();
// const auth = require('../middleware/auth');
// const { pool } = require('../config/database');
// const largeDatasetService = require('../services/reports/largeDataSetReportService');

// // Cache middleware
// const cacheReport = (duration = 180) => {
//     return async (req, res, next) => {
//         // Skip cache for large exports or streaming
//         if (req.query.export === 'true' || req.query.stream === 'true') {
//             return next();
//         }

//         const cacheKey = `report_${req.user.id}_${req.originalUrl}`;
//         try {
//             const cached = await largeDatasetService.getCachedOrGenerate(cacheKey, () => {
//                 return new Promise((resolve) => {
//                     // Store the original json method
//                     const originalJson = res.json.bind(res);
//                     res.json = (data) => {
//                         if (res.statusCode === 200) {
//                             // Cache will be set by the service
//                         }
//                         originalJson(data);
//                     };
//                     resolve(null);
//                 });
//             });

//             if (cached) {
//                 return res.json(cached);
//             }
//         } catch (error) {
//             console.error('Cache error:', error);
//         }
//         next();
//     };
// };

// /**
//  * GET /api/reports/sales
//  * Get sales report with streaming support for large datasets
//  */
// router.get('/sales', auth, async (req, res) => {
//     const startTime = Date.now();
    
//     try {
//         const { 
//             start_date, 
//             end_date, 
//             report_type = 'summary',
//             category_id, 
//             product_id,
//             page = 0,
//             limit = 1000,
//             stream = 'false'
//         } = req.query;

//         if (!start_date || !end_date) {
//             return res.status(400).json({ 
//                 success: false, 
//                 message: 'Start date and end date are required' 
//             });
//         }

//         const startDate = new Date(start_date);
//         const endDate = new Date(end_date);
//         const storeId = req.user.store_id;

//         // For streaming large datasets
//         if (stream === 'true') {
//             res.setHeader('Content-Type', 'application/json');
//             res.setHeader('Transfer-Encoding', 'chunked');
//             res.setHeader('X-Content-Type-Options', 'nosniff');

//             try {
//                 const streamData = await largeDatasetService.streamSalesData(
//                     startDate,
//                     endDate,
//                     storeId,
//                     {
//                         category_id,
//                         product_id,
//                         page: parseInt(page),
//                         limit: parseInt(limit)
//                     }
//                 );

//                 // Send initial response
//                 res.write(JSON.stringify({
//                     status: 'streaming',
//                     pagination: streamData.data.pagination,
//                     progress: streamData.progress,
//                     timestamp: new Date().toISOString()
//                 }) + '\n');

//                 // Send sales in chunks
//                 const salesChunks = largeDatasetService.chunkArray(streamData.data.sales, 100);
//                 for (const chunk of salesChunks) {
//                     res.write(JSON.stringify({
//                         type: 'sales_chunk',
//                         data: chunk,
//                         count: chunk.length,
//                         timestamp: new Date().toISOString()
//                     }) + '\n');

//                     // Yield to event loop
//                     await new Promise(resolve => setImmediate(resolve));
//                 }

//                 // Send returns in chunks
//                 const returnsChunks = largeDatasetService.chunkArray(streamData.data.returns, 100);
//                 for (const chunk of returnsChunks) {
//                     res.write(JSON.stringify({
//                         type: 'returns_chunk',
//                         data: chunk,
//                         count: chunk.length,
//                         timestamp: new Date().toISOString()
//                     }) + '\n');

//                     await new Promise(resolve => setImmediate(resolve));
//                 }

//                 // Send summary
//                 res.write(JSON.stringify({
//                     type: 'summary',
//                     data: streamData.data.summary,
//                     timestamp: new Date().toISOString()
//                 }) + '\n');

//                 // Send completion
//                 res.write(JSON.stringify({
//                     status: 'complete',
//                     totalRecords: streamData.data.pagination.totalRecords,
//                     totalPages: streamData.data.pagination.totalPages,
//                     executionTime: Date.now() - startTime,
//                     timestamp: new Date().toISOString()
//                 }) + '\n');

//                 res.end();

//             } catch (error) {
//                 console.error('Streaming error:', error);
//                 res.write(JSON.stringify({
//                     status: 'error',
//                     message: error.message,
//                     timestamp: new Date().toISOString()
//                 }) + '\n');
//                 res.end();
//             }
//             return;
//         }

//         // For non-streaming, use paginated data
//         const result = await largeDatasetService.streamSalesData(
//             startDate,
//             endDate,
//             storeId,
//             {
//                 category_id,
//                 product_id,
//                 page: parseInt(page),
//                 limit: parseInt(limit),
//                 includeReturns: report_type !== 'sales_only'
//             }
//         );

//         // Return simplified response for non-streaming
//         const response = {
//             success: true,
//             data: {
//                 sales: result.data.sales,
//                 summary: result.data.summary,
//                 pagination: result.data.pagination,
//                 progress: result.progress
//             },
//             timestamp: new Date().toISOString()
//         };

//         if (report_type !== 'summary') {
//             response.data.returns = result.data.returns;
//         }

//         res.json(response);

//     } catch (error) {
//         console.error('Sales report error:', error);
//         res.status(500).json({ 
//             success: false, 
//             message: 'Server error',
//             error: process.env.NODE_ENV === 'development' ? error.message : undefined
//         });
//     }
// });

// /**
//  * GET /api/reports/sales/export
//  * Export sales report as Excel
//  */
// router.get('/sales/export', auth, async (req, res) => {
//     try {
//         const { start_date, end_date, category_id, product_id } = req.query;

//         if (!start_date || !end_date) {
//             return res.status(400).json({ 
//                 success: false, 
//                 message: 'Start date and end date are required' 
//             });
//         }

//         const startDate = new Date(start_date);
//         const endDate = new Date(end_date);
//         const storeId = req.user.store_id;

//         // Get all data (no pagination limit for export)
//         const result = await largeDatasetService.streamSalesData(
//             startDate,
//             endDate,
//             storeId,
//             {
//                 category_id,
//                 product_id,
//                 limit: 1000000, // Large limit for export
//                 page: 0
//             }
//         );

//         // Generate Excel
//         const workbook = await largeDatasetService.generateExcelReport(
//             'sales',
//             result.data,
//             startDate,
//             endDate
//         );

//         // Set response headers
//         const fileName = `sales_report_${startDate.toISOString().split('T')[0]}_${endDate.toISOString().split('T')[0]}.xlsx`;
//         res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
//         res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);

//         // Write to response
//         await workbook.xlsx.write(res);
//         res.end();

//     } catch (error) {
//         console.error('Export error:', error);
//         res.status(500).json({ 
//             success: false, 
//             message: 'Server error',
//             error: process.env.NODE_ENV === 'development' ? error.message : undefined
//         });
//     }
// });

// /**
//  * GET /api/reports/products
//  * Product performance report
//  */
// router.get('/products', auth, async (req, res) => {
//     try {
//         const { start_date, end_date, category_id, limit = 100 } = req.query;

//         if (!start_date || !end_date) {
//             return res.status(400).json({ 
//                 success: false, 
//                 message: 'Start date and end date are required' 
//             });
//         }

//         const startDate = new Date(start_date);
//         const endDate = new Date(end_date);
//         const storeId = req.user.store_id;

//         let sql = `
//             SELECT 
//                 p.id as product_id,
//                 p.name as product_name,
//                 p.product_class_code,
//                 c.name as category_name,
//                 p.price as unit_price,
//                 COALESCE(SUM(si.quantity), 0) as total_sold,
//                 COALESCE(SUM(si.total_price), 0) as total_revenue
//             FROM products p
//             LEFT JOIN categories c ON p.category_id = c.id
//             LEFT JOIN sale_items si ON p.id = si.product_id
//             LEFT JOIN sales s ON si.sale_id = s.id AND s.sale_date BETWEEN ? AND ?
//             WHERE p.store_id = ?
//         `;

//         const params = [startDate, endDate, storeId];

//         if (category_id) {
//             sql += ' AND p.category_id = ?';
//             params.push(category_id);
//         }

//         sql += ` GROUP BY p.id ORDER BY total_revenue DESC LIMIT ?`;
//         params.push(parseInt(limit));

//         const results = await pool.query(sql, params);

//         res.json({
//             success: true,
//             data: results[0] || [],
//             date_range: { start_date, end_date },
//             timestamp: new Date().toISOString()
//         });

//     } catch (error) {
//         console.error('Products report error:', error);
//         res.status(500).json({ 
//             success: false, 
//             message: 'Server error' 
//         });
//     }
// });

// /**
//  * GET /api/reports/inventory
//  * Inventory report
//  */
// router.get('/inventory', auth, async (req, res) => {
//     try {
//         const { low_stock_only, category_id, include_inactive = false } = req.query;
//         const storeId = req.user.store_id;

//         let sql = `
//             SELECT 
//                 p.id as product_id,
//                 p.name as product_name,
//                 p.product_class_code,
//                 c.name as category_name,
//                 p.price as unit_price,
//                 pi.stock_quantity,
//                 pi.min_stock_level,
//                 pi.updated_at as last_updated,
//                 CASE 
//                     WHEN pi.stock_quantity <= pi.min_stock_level THEN 'Low Stock'
//                     WHEN pi.stock_quantity = 0 THEN 'Out of Stock'
//                     ELSE 'In Stock'
//                 END as stock_status
//             FROM product_inventories pi
//             JOIN products p ON pi.product_id = p.id
//             LEFT JOIN categories c ON p.category_id = c.id
//             WHERE pi.store_id = ?
//         `;

//         const params = [storeId];

//         if (!include_inactive || include_inactive === 'false') {
//             sql += ' AND p.is_active = 1';
//         }

//         if (category_id) {
//             sql += ' AND p.category_id = ?';
//             params.push(category_id);
//         }

//         if (low_stock_only === 'true') {
//             sql += ' AND pi.stock_quantity <= pi.min_stock_level';
//         }

//         sql += ' ORDER BY pi.stock_quantity ASC, p.name ASC';

//         const results = await pool.query(sql, params);

//         // Calculate summary
//         const inventories = results[0] || [];
//         const summary = {
//             total_products: inventories.length,
//             total_stock_value: inventories.reduce((sum, inv) => 
//                 sum + (parseFloat(inv.unit_price || 0) * parseInt(inv.stock_quantity || 0)), 0),
//             low_stock_items: inventories.filter(inv => inv.stock_status === 'Low Stock').length,
//             out_of_stock_items: inventories.filter(inv => inv.stock_status === 'Out of Stock').length
//         };

//         res.json({
//             success: true,
//             data: inventories,
//             summary,
//             timestamp: new Date().toISOString()
//         });

//     } catch (error) {
//         console.error('Inventory report error:', error);
//         res.status(500).json({ 
//             success: false, 
//             message: 'Server error' 
//         });
//     }
// });

// /**
//  * GET /api/reports/returns
//  * Returns report
//  */
// router.get('/returns', auth, async (req, res) => {
//     try {
//         const { start_date, end_date, category_id, product_id, page = 0, limit = 1000 } = req.query;

//         if (!start_date || !end_date) {
//             return res.status(400).json({ 
//                 success: false, 
//                 message: 'Start date and end date are required' 
//             });
//         }

//         const startDate = new Date(start_date);
//         const endDate = new Date(end_date);
//         const storeId = req.user.store_id;

//         let sql = `
//             SELECT 
//                 cn.id,
//                 cn.credit_note_number,
//                 cn.total_amount,
//                 cn.subtotal,
//                 cn.tax_amount,
//                 cn.discount_amount,
//                 cn.payment_method,
//                 cn.credit_note_date,
//                 cn.created_at,
//                 u.full_name as cashier_name,
//                 c.name as customer_name,
//                 COUNT(cni.id) as items_count
//             FROM credit_notes cn
//             LEFT JOIN users u ON cn.user_id = u.id
//             LEFT JOIN customers c ON cn.customer_id = c.id
//             LEFT JOIN credit_note_items cni ON cn.id = cni.credit_note_id
//             LEFT JOIN products p ON cni.product_id = p.id
//             WHERE cn.credit_note_date BETWEEN ? AND ?
//             AND cn.store_id = ?
//         `;

//         const params = [startDate, endDate, storeId];

//         if (category_id) {
//             sql += ' AND p.category_id = ?';
//             params.push(category_id);
//         }

//         if (product_id) {
//             sql += ' AND cni.product_id = ?';
//             params.push(product_id);
//         }

//         sql += ` GROUP BY cn.id ORDER BY cn.credit_note_date DESC LIMIT ? OFFSET ?`;
//         params.push(parseInt(limit), parseInt(page) * parseInt(limit));

//         const results = await pool.query(sql, params);
//         const returns = results[0] || [];

//         // Get total count
//         let countSql = `
//             SELECT COUNT(DISTINCT cn.id) as total
//             FROM credit_notes cn
//             LEFT JOIN credit_note_items cni ON cn.id = cni.credit_note_id
//             LEFT JOIN products p ON cni.product_id = p.id
//             WHERE cn.credit_note_date BETWEEN ? AND ?
//             AND cn.store_id = ?
//         `;
//         const countParams = [startDate, endDate, storeId];
//         if (category_id) countParams.push(category_id);
//         if (product_id) countParams.push(product_id);

//         const countResult = await pool.query(countSql, countParams);
//         const total = countResult[0]?.[0]?.total || 0;

//         res.json({
//             success: true,
//             data: returns,
//             pagination: {
//                 currentPage: parseInt(page),
//                 totalPages: Math.ceil(total / parseInt(limit)),
//                 totalRecords: total,
//                 hasMore: (parseInt(page) + 1) * parseInt(limit) < total
//             },
//             timestamp: new Date().toISOString()
//         });

//     } catch (error) {
//         console.error('Returns report error:', error);
//         res.status(500).json({ 
//             success: false, 
//             message: 'Server error' 
//         });
//     }
// });

// /**
//  * GET /api/reports/clear-cache
//  * Clear report cache (admin only)
//  */
// router.delete('/clear-cache', auth, async (req, res) => {
//     try {
//         // Check if user is admin
//         if (req.user.role !== 'admin') {
//             return res.status(403).json({ 
//                 success: false, 
//                 message: 'Admin access required' 
//             });
//         }

//         largeDatasetService.clearAllCache();
//         res.json({ 
//             success: true, 
//             message: 'Cache cleared successfully' 
//         });

//     } catch (error) {
//         console.error('Clear cache error:', error);
//         res.status(500).json({ 
//             success: false, 
//             message: 'Server error' 
//         });
//     }
// });

// module.exports = router;
