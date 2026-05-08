// Add these routes to your backend router
const express = require("express");

const router = express.Router();
const { sale, saleitem, product, user, customer, category, productinventory, sequelize, creditnote, creditnoteitem } = require('../models');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const siteId = process.env.SITE_ID || 'unknown-site';
const { store } = require('../models');
// Dashboard Statistics (unified)
router.get('/dashboard', auth, async (req, res) => {
    const startedAt = new Date();
    try {
        logger.info('reports_dashboard_started', {
            siteId,
            userId: req.user?.id,
            storeId: req.user?.store_id,
            startedAt
        });
        const { computeDashboardStats } = require('../services/reports/dashboardStats');
        const data = await computeDashboardStats(req);
        const durationMs = Date.now() - startedAt.getTime();
        logger.info('reports_dashboard_completed', {
            siteId,
            userId: req.user?.id,
            storeId: req.user?.store_id,
            keys: Object.keys(data || {}),
            durationMs
        });
        res.json({ success: true, data, summary: data, timestamp: new Date().toISOString() });
    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('reports_dashboard_error', {
            siteId,
            userId: req.user?.id,
            storeId: req.user?.store_id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Sales Report (comprehensive)
router.get('/sales', auth, async (req, res) => {
    const startedAt = new Date();
    try {
        logger.info('reports_sales_started', {
            siteId,
            userId: req.user?.id,
            storeId: req.user?.store_id,
            query: req.query,
            startedAt
        });
        const { start_date, end_date, report_type = 'summary', category_id, product_id } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);

        const whereClause = {
            sale_date: { [Op.between]: [startDate, endDate] }
        };

        const filterStoreId = req.user.store_id;

        const includeClause = [
            {
                model: user,
                as: 'cashier',
                attributes: ['id', 'full_name', 'store_id'],
                ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {})
            },
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
            items_count: sales.reduce(
                (sum, s) =>
                    sum +
                    (s.items
                        ? s.items.reduce((q, i) => q + Number(i.quantity || 0), 0)
                        : 0),
                0
            ),
            payment_methods: {},
            daily_breakdown: {}
        };

        // Group by payment method (allocating mixed payments) and daily breakdown
        sales.forEach(s => {
            const date = s.sale_date.toDateString();

            // Allocate by payment breakdown if present
            const bd = s.payments_breakdown;
            const changeAmount = Number(s.change_amount || 0);
            if (bd && typeof bd === 'object') {
                const total = Object.values(bd).reduce((a, v) => a + Number(v || 0), 0) || 0;
                if (total > 0) {
                    Object.entries(bd).forEach(([method, amt]) => {
                        const key = method || 'unknown';
                        let finalAmt = Number(amt || 0);
                        if (s.payment_method === 'mixed' && key === 'cash' && changeAmount > 0) {
                            finalAmt = Math.max(0, finalAmt - changeAmount);
                        }
                        summary.payment_methods[key] =
                            (summary.payment_methods[key] || 0) + finalAmt;
                    });
                } else {
                    const method = s.payment_method || 'unknown';
                    summary.payment_methods[method] =
                        (summary.payment_methods[method] || 0) +
                        parseFloat(s.total_amount || 0);
                }
            } else {
                const method = s.payment_method || 'unknown';
                summary.payment_methods[method] =
                    (summary.payment_methods[method] || 0) +
                    parseFloat(s.total_amount || 0);
            }

            if (!summary.daily_breakdown[date]) {
                summary.daily_breakdown[date] = { sales: 0, revenue: 0, items_quantity: 0 };
            }
            summary.daily_breakdown[date].sales++;
            summary.daily_breakdown[date].revenue += parseFloat(s.total_amount || 0);
            summary.daily_breakdown[date].items_quantity += (s.items || []).reduce((q, i) => q + Number(i.quantity || 0), 0);
        });

        // Traditional X/Z format support on /reports/sales using the same endpoint
        if (['x', 'z', 'X', 'Z'].includes(report_type)) {
            const isZ = report_type.toLowerCase() === 'z';

            // Fetch returns within the same date range to net against sales
            const returnsInclude = [
                {
                    model: user,
                    as: 'cashier',
                    attributes: ['id', 'full_name', 'store_id'],
                    ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {})
                },
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

            const returnsList = await creditnote.findAll({
                    where: { credit_note_date: { [Op.between]: [startDate, endDate] } },

                include: returnsInclude
            });

            const grossSales = sales.reduce((sum, s) => sum + Number(s.subtotal || 0), 0);
            const discounts = sales.reduce((sum, s) => sum + Number(s.discount_amount || 0), 0);
            const tax = sales.reduce((sum, s) => sum + Number(s.tax_amount || 0), 0);
            const salesTotalAmount = sales.reduce((sum, s) => sum + Number(s.total_amount || 0), 0);
            const returnsTotalAmount = returnsList.reduce(
              (sum, r) => sum + Number(r.total_amount || 0),
              0
            );

            const returnsTax = returnsList.reduce(
                (sum, r) => sum + Number(r.tax_amount || 0),
                0
            );
            const returnsDiscount = returnsList.reduce(
                (sum, r) => sum + Number(r.discount_amount || 0),
                0
            );

            // Normalize to CASH, CARD, MOBILE_MONEY, OTHER
            const normalizeMethod = (m) => {
                const x = (m || '').toString().trim().toLowerCase();
                if (x === 'cash') return 'CASH';
                if (['card', 'visa', 'mastercard', 'debit', 'credit', 'pos'].includes(x)) {
                    return 'CARD';
                }
                if (
                    [
                        'mobile',
                        'mobile money',
                        'mobile_money',
                        'mpesa',
                        'm-pesa',
                        'm pesa',
                        'momo',
                        'airtel money',
                        'tigo pesa'
                    ].includes(x)
                ) {
                    return 'MOBILE_MONEY';
                }
                return 'OTHER';
            };

            const paymentBreakdown = { CASH: 0, CARD: 0, MOBILE_MONEY: 0, OTHER: 0 };

            sales.forEach(s => {
                const bd = s.payments_breakdown;
                const changeAmount = Number(s.change_amount || 0);
                if (bd && typeof bd === 'object') {
                    Object.entries(bd).forEach(([method, amt]) => {
                        const key = normalizeMethod(method);
                        let finalAmt = Number(amt || 0);
                        if (s.payment_method === 'mixed' && normalizeMethod(method) === 'CASH' && changeAmount > 0) {
                            finalAmt = Math.max(0, finalAmt - changeAmount);
                        }
                        paymentBreakdown[key] =
                            (paymentBreakdown[key] || 0) + finalAmt;
                    });
                } else {
                    const key = normalizeMethod(s.payment_method);
                    paymentBreakdown[key] =
                        (paymentBreakdown[key] || 0) + Number(s.total_amount || 0);
                }
            });

            returnsList.forEach(r => {
                const key = normalizeMethod(r.payment_method);
                paymentBreakdown[key] =
                    (paymentBreakdown[key] || 0) - Number(r.total_amount || 0);
            });

            const itemsSold = sales.reduce(
                (s, x) =>
                    s +
                    (x.items || []).reduce(
                        (q, i) => q + Number(i.quantity || 0),
                        0
                    ),
                0
            );
            const itemsReturned = returnsList.reduce(
                (s, x) =>
                    s +
                    (x.items || []).reduce(
                        (q, i) => q + Number(i.quantity || 0),
                        0
                    ),
                0
            );

            // Category summary (net of returns)
            const categoryMap = {};
            const addToCategory = (catId, catName, qty, amount) => {
                const key = catId || 'uncategorized';
                if (!categoryMap[key]) {
                    categoryMap[key] = {
                        category_id: catId || null,
                        category_name: catName || 'Uncategorized',
                        items_quantity: 0,
                        revenue: 0
                    };
                }
                categoryMap[key].items_quantity += qty;
                categoryMap[key].revenue += amount;
            };

            sales.forEach(saleRow => {
                (saleRow.items || []).forEach(i => {
                    const cat = i.product && i.product.category;
                    addToCategory(
                        cat ? cat.id : null,
                        cat ? cat.name : null,
                        Number(i.quantity || 0),
                        Number(i.total_price || 0)
                    );
                });
            });

            returnsList.forEach(ret => {
                (ret.items || []).forEach(i => {
                    const cat = i.product && i.product.category;
                    addToCategory(
                        cat ? cat.id : null,
                        cat ? cat.name : null,
                        -Number(i.quantity || 0),
                        -Number(i.total_price || 0)
                    );
                });
            });

            // Cashier summary (amounts sold per cashier, net of returns)
            const cashierMap = {};

            const ensureCashier = (cashier) => {
                const id = cashier?.id || 'unknown';
                if (!cashierMap[id]) {
                    cashierMap[id] = {
                        cashier_id: cashier?.id || null,
                        cashier_name: cashier?.full_name || 'Unknown',
                        gross_sales: 0,
                        returns_amount: 0,
                        net_revenue: 0,
                        transactions: 0,
                        returns: 0,
                        items_sold: 0,
                        items_returned: 0
                    };
                }
                return cashierMap[id];
            };

            // Sales per cashier
            sales.forEach(saleRow => {
                const cashier = saleRow.cashier;
                const c = ensureCashier(cashier);

                c.gross_sales += Number(saleRow.total_amount || 0);
                c.transactions += 1;
                c.items_sold += (saleRow.items || []).reduce(
                    (q, i) => q + Number(i.quantity || 0),
                    0
                );
            });

            // Returns per cashier
            returnsList.forEach(ret => {
                const cashier = ret.cashier;
                const c = ensureCashier(cashier);

                c.returns_amount += Number(ret.total_amount || 0);
                c.returns += 1;
                c.items_returned += (ret.items || []).reduce(
                    (q, i) => q + Number(i.quantity || 0),
                    0
                );
                // Adjust gross_sales and items_sold for net cashier reporting
                c.gross_sales -= Number(ret.total_amount || 0);
                c.items_sold -= (ret.items || []).reduce(
                    (q, i) => q + Number(i.quantity || 0),
                    0
                );
            });

            // Adjust cashier totals to be net
            Object.values(cashierMap).forEach(c => {
                c.net_revenue = c.gross_sales;
            });
            let storeInfo = null;
            if (req.user && req.user.store_id) {
              storeInfo = await store.findByPk(req.user.store_id, {
                attributes: ['id', 'store_location', 'store_number'] // whatever fields you need
              });
            }

            const traditional = {
                report_name: isZ ? 'Z Report' : 'X Report',
                period: { start: start_date, end: end_date },
                store: storeInfo ? { store_id: storeInfo.id, name: storeInfo.store_location }
                : null,
                cashier:
                    req.user && req.user.full_name
                        ? { id: req.user.id, name: req.user.full_name }
                        : undefined,
                counts: {
                    transactions: sales.length,
                    returns: returnsList.length,
                    items_sold_gross: itemsSold,
                    items_returned: itemsReturned,
                    items_sold: itemsSold - itemsReturned
                },
                 totals: {
                    gross_sales: grossSales - (returnsTotalAmount - returnsTax),
                    discounts: discounts - returnsDiscount,
                    net_sales_before_tax: Math.max((grossSales - (returnsTotalAmount - returnsTax)) - (discounts - returnsDiscount), 0),
                    tax_collected: tax - returnsTax,
                    returns_amount: returnsTotalAmount,
                    returns_tax: returnsTax,
                    returns_discount: returnsDiscount,
                    net_revenue: salesTotalAmount - returnsTotalAmount
                },
                payments: paymentBreakdown,
                categories: Object.values(categoryMap),
                cashiers: Object.values(cashierMap)
            };
            return res.json({
                report_type: isZ ? 'Z' : 'X',
                date_range: { start_date, end_date },
                traditional,
                summary: traditional
            });
        }

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('reports_sales_completed', {
            siteId,
            userId: req.user?.id,
            storeId: req.user?.store_id,
            reportType: report_type,
            salesCount: sales.length,
            durationMs
        });
        res.json({
            report_type,
            date_range: { start_date, end_date },
            sales,
            summary
        });

    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('reports_sales_error', {
            siteId,
            userId: req.user?.id,
            storeId: req.user?.store_id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
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

        // Get all sales and returns in the period
        const [sales, returnsList] = await Promise.all([
            sale.findAll({
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
            }),
            creditnote.findAll({
                where: {
                    credit_note_date: { [Op.between]: [startDate, endDate] }
                },
                include: [
                    ...cashierInclude,
                    {
                        model: creditnoteitem,
                        as: 'items',
                        include: [{
                            model: product,
                            as: 'product',
                            attributes: ['id', 'name', 'product_class_code', 'price']
                        }]
                    }
                ]
            })
        ]);

        // Group items across all sales and returns
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

        returnsList.forEach(r => {
            (r.items || []).forEach(item => {
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

                itemMap[productId].total_quantity -= parseInt(item.quantity || 0);
                itemMap[productId].total_amount -= parseFloat(item.total_price || 0);
                // We don't necessarily subtract from transaction_count as a return is also a transaction of sorts, 
                // but usually this report is about sales performance. 
                // Given the instructions, we'll keep transaction_count as is or maybe it should be net transactions?
                // The instructions say "treat credit notes/returns as negative movements against sales".
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
        logger.error('reports_transaction_list_error', { siteId, userId: req.user?.id, storeId: req.user?.store_id, error: error.message, stack: error.stack });
        res.status(500).json({ message: 'Server error' });
    }
});
// Product Performance Report
router.get('/products', auth, async (req, res) => {
    try {
        const { start_date, end_date, category_id } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);

        // Ensure we include the sale model so `$sale.sale_date$` can be referenced in the where clause
        let includeWhere = {
            '$sale.sale_date$': { [Op.between]: [startDate, endDate] }
        };

        if (category_id) {
            includeWhere['$product.category_id$'] = category_id;
        }

        const [productSales, productReturns] = await Promise.all([
            saleitem.findAll({
                where: includeWhere,
                include: [
                    {
                        model: sale,
                        as: 'sale',
                        attributes: [],
                        required: true
                    },
                    {
                        model: product,
                        as: 'product',
                        include: [{ model: category, as: 'category' }]
                    }
                ],
                attributes: [
                    'product_id',
                    [sequelize.fn('SUM', sequelize.col('quantity')), 'total_quantity'],
                    [sequelize.fn('SUM', sequelize.col('total_price')), 'total_revenue'],
                    [sequelize.fn('COUNT', sequelize.col('saleitem.id')), 'transaction_count']
                ],
                group: ['product_id', 'product.id'],
                order: [[sequelize.fn('SUM', sequelize.col('total_price')), 'DESC']]
            }),
            creditnoteitem.findAll({
                where: {
                    '$creditnote.credit_note_date$': { [Op.between]: [startDate, endDate] },
                    ...(category_id ? { '$product.category_id$': category_id } : {})
                },
                include: [
                    {
                        model: creditnote,
                        as: 'creditnote',
                        attributes: [],
                        required: true
                    },
                    {
                        model: product,
                        as: 'product',
                        include: [{ model: category, as: 'category' }]
                    }
                ],
                attributes: [
                    'product_id',
                    [sequelize.fn('SUM', sequelize.col('quantity')), 'total_quantity'],
                    [sequelize.fn('SUM', sequelize.col('total_price')), 'total_revenue'],
                    [sequelize.fn('COUNT', sequelize.col('creditnoteitem.id')), 'transaction_count']
                ],
                group: ['product_id', 'product.id']
            })
        ]);

        const combinedProductStats = {};

        productSales.forEach(ps => {
            const pid = ps.product_id;
            combinedProductStats[pid] = {
                product_id: pid,
                product: ps.product,
                total_quantity: parseFloat(ps.getDataValue('total_quantity') || 0),
                total_revenue: parseFloat(ps.getDataValue('total_revenue') || 0),
                transaction_count: parseInt(ps.getDataValue('transaction_count') || 0)
            };
        });

        productReturns.forEach(pr => {
            const pid = pr.product_id;
            if (!combinedProductStats[pid]) {
                combinedProductStats[pid] = {
                    product_id: pid,
                    product: pr.product,
                    total_quantity: 0,
                    total_revenue: 0,
                    transaction_count: 0
                };
            }
            combinedProductStats[pid].total_quantity -= parseFloat(pr.getDataValue('total_quantity') || 0);
            combinedProductStats[pid].total_revenue -= parseFloat(pr.getDataValue('total_revenue') || 0);
        });

        const finalProductSales = Object.values(combinedProductStats).sort((a, b) => b.total_revenue - a.total_revenue);

        const summary = {
            total_quantity: finalProductSales.reduce((sum, item) => sum + item.total_quantity, 0),
            total_revenue: finalProductSales.reduce((sum, item) => sum + item.total_revenue, 0),
            transaction_count: finalProductSales.reduce((sum, item) => sum + item.transaction_count, 0),
            products_count: finalProductSales.length
        };

        res.json({
            date_range: { start_date, end_date },
            products: finalProductSales,
            summary
        });

    } catch (error) {
        logger.error('reports_products_error', { siteId, userId: req.user?.id, storeId: req.user?.store_id, error: error.message, stack: error.stack });
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
        logger.error('reports_inventory_error', { siteId, userId: req.user?.id, storeId: req.user?.store_id, error: error.message, stack: error.stack });
        res.status(500).json({ message: 'Server error' });
    }
});
// javascript
router.get('/user-activity', auth, async (req, res) => {
    try {
        const { start_date, end_date, user_id } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            return res.status(400).json({ message: 'Invalid date format' });
        }

        let whereClause = {
            created_at: { [Op.between]: [startDate, endDate] }
        };

        if (user_id) {
            whereClause.user_id = user_id;
        }

        logger.info('reports_user_activity_query', { siteId, userId: req.user?.id, storeId: req.user?.store_id, whereClause });

        const userSales = await sale.findAll({
            where: whereClause,
            include: [{ model: user, as: 'cashier', attributes: ['id', 'full_name', 'role'] }],
            attributes: [
                'user_id',
                [sequelize.fn('COUNT', sequelize.col('sale.id')), 'total_sales'],
                [sequelize.fn('SUM', sequelize.col('total_amount')), 'total_revenue']
            ],
            group: ['user_id', 'cashier.id'],
            order: [[sequelize.fn('COUNT', sequelize.col('id')), 'DESC']],
            raw: true
        });

        logger.info('reports_user_activity_result', { siteId, userId: req.user?.id, storeId: req.user?.store_id, rows: userSales.length });

        const summary = {
            total_sales: userSales.reduce((sum, item) => sum + parseInt(item.total_sales || 0), 0),
            total_revenue: userSales.reduce((sum, item) => sum + parseFloat(item.total_revenue || 0), 0),
            users_count: userSales.length
        };

        res.json({
            date_range: { start_date, end_date },
            user_activity: userSales,
            summary
        });

    } catch (error) {
        logger.error('reports_user_activity_error', { siteId, userId: req.user?.id, storeId: req.user?.store_id, error: error.message, stack: error.stack });
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
                '$sale.created_at$': { [Op.between]: [startDate, endDate] }
            },
            include: [
                {
                    model: product,
                    as: 'product',
                    attributes: [], // avoid selecting product.* (prevents implicit non-aggregated columns)
                    include: [{ model: category, as: 'category', attributes: ['id', 'name'] }]
                },
                { model: sale, as: 'sale', attributes: [] } // don't select sale.*; date filtered via where
            ],
            attributes: [
                [sequelize.col('product.category.id'), 'category_id'],
                [sequelize.col('product.category.name'), 'category_name'],
                [sequelize.fn('SUM', sequelize.col('quantity')), 'total_quantity'],
                [sequelize.fn('SUM', sequelize.col('total_price')), 'total_revenue'],
                [sequelize.fn('COUNT', sequelize.col('saleitem.id')), 'transaction_count']
            ],
            group: ['product.category.id', 'product.category.name'],
            order: [[sequelize.fn('SUM', sequelize.col('total_price')), 'DESC']],
            raw: true
        });
        const summary = {
            total_quantity: categorySales.reduce((sum, item) => sum + parseFloat(item.total_quantity || 0), 0),
            total_revenue: categorySales.reduce((sum, item) => sum + parseFloat(item.total_revenue || 0), 0),
            transaction_count: categorySales.reduce((sum, item) => sum + parseInt(item.transaction_count || 0), 0),
            categories_count: categorySales.length
        };

        res.json({
            date_range: { start_date, end_date },
            categories: categorySales,
            summary
        });

    } catch (error) {
        logger.error('reports_category_error', { siteId, userId: req.user?.id, storeId: req.user?.store_id, error: error.message, stack: error.stack });
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
        logger.error('reports_tax_error', { siteId, userId: req.user?.id, storeId: req.user?.store_id, error: error.message, stack: error.stack });
        res.status(500).json({ message: 'Server error' });
    }
});

// Export Report Route
router.get('/:reportType/export', auth, async (req, res) => {
    try {
        const { reportType } = req.params;
        const { format, start_date, end_date, ...additionalParams } = req.query;

        if (!['csv', 'pdf', 'xlsx'].includes(format)) {
            return res.status(400).json({ message: 'Invalid format. Use csv, pdf, or xlsx' });
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

        // Get store_id from authenticated user
        const storeId = req.user?.store_id;

        logger.info('reports_export_started', { siteId, userId: req.user?.id, storeId: storeId, reportType, start_date, end_date, format });

        // Generate report data based on type
        let reportData;
        const reportParams = { ...additionalParams };

        switch (reportType) {
            case 'sales':
                reportData = await generateSalesReport(startDate, endDate, storeId, reportParams);
                break;
            case 'products':
                reportData = await generateProductsReport(startDate, endDate, storeId, reportParams);
                break;
            case 'inventory':
                reportData = await generateInventoryReport(startDate, endDate, storeId, reportParams);
                break;
            case 'user-activity':
                reportData = await generateUserActivityReport(startDate, endDate, storeId, reportParams);
                break;
            case 'categories':
                reportData = await generateCategoriesReport(startDate, endDate, storeId, reportParams);
                break;
            case 'tax':
                reportData = await generateTaxReport(startDate, endDate, storeId, reportParams);
                break;
            case 'returns':
                reportData = await generateReturnsReport(startDate, endDate, storeId, reportParams);
                break;
            case 'transactions':
                reportData = await generateTransactionsReport(startDate, endDate, storeId, reportParams);
                break;
            case 'transaction-list':
                reportData = await generateTransactionListReport(startDate, endDate, storeId, reportParams);
                break;
            default:
                return res.status(400).json({ message: 'Invalid report type' });
        }

        if (!reportData || reportData.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No data found for the specified date range'
            });
        }

        // Check if reportData is the full response object from some of our generators
        const actualData = (reportData && !Array.isArray(reportData)) 
            ? (reportData.items || reportData.sales || reportData.returns || reportData.categories || []) 
            : reportData;
        const dataArray = Array.isArray(actualData) ? actualData : [actualData];

        if (format === 'xlsx') {
            const workbook = await createExcelReport(reportType, dataArray, startDate, endDate);
            
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=${reportType}_report_${Date.now()}.xlsx`);
            
            await workbook.xlsx.write(res);
            return res.end();
        }

        // For now, other formats return mock data or simple text
        const mockData = Buffer.from(`Report: ${reportType}\nFormat: ${format}\nDate Range: ${start_date} to ${end_date}\nRecords: ${reportData.length}`);

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename=report_${reportType}_${format}`);
        res.send(mockData);

    } catch (error) {
        logger.error('reports_export_error', { siteId, userId: req.user?.id, storeId: req.user?.store_id, error: error.message, stack: error.stack });
        res.status(500).json({ message: 'Server error' });
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
            user: process.env.SMTP_USER || 'mupumamgtsdev@gmail.com',
            pass: process.env.SMTP_PASS || 'ptrcailrtlrrkwde'
        }
    });
};
const normalizeInt = v => (v === undefined || v === null || v === '' ? undefined : parseInt(v, 10));
const normalizeFloat = v => (v === undefined || v === null || v === '' ? undefined : parseFloat(v));

// Report generation functions
const generateSalesReport = async (startDate, endDate, storeId, additionalParams = {}) => {
    const { cashier_id, payment_method, min_total, max_total } = additionalParams;

    let where = ['s.created_at BETWEEN ? AND ?'];
    const params = [startDate, endDate];

    // Filter by the store of the user (cashier) who recorded the sale
    if (storeId) { where.push('u.store_id = ?'); params.push(storeId); }
    if (cashier_id) { where.push('s.user_id = ?'); params.push(cashier_id); }
    if (payment_method) { where.push('s.payment_method = ?'); params.push(payment_method); }
    if (min_total !== undefined) { where.push('s.total_amount >= ?'); params.push(min_total); }
    if (max_total !== undefined) { where.push('s.total_amount <= ?'); params.push(max_total); }

    let query = `
        SELECT
            s.id,
            s.invoice_no,
            s.receipt_no,
            s.total_amount,
            s.payment_method,
            s.created_at,
            u.full_name as cashier_name,
            st.store_location,
            SUM(si.quantity) as items_count
        FROM sales s
        LEFT JOIN users u ON s.user_id = u.id
        LEFT JOIN stores st ON u.store_id = st.id
        LEFT JOIN saleitems si ON s.id = si.sale_id
        WHERE ${where.join(' AND ')}
        GROUP BY s.id
        ORDER BY s.created_at DESC
    `;

    const [rows] = await pool.query(query, params);
    
    // Convert items_count to Number since SUM() might return it as a string
    return rows.map(row => ({
        ...row,
        items_count: Number(row.items_count || 0)
    }));
};
const generateProductsReport = async (startDate, endDate, storeId, additionalParams = {}) => {
    const { category_id, product_id, min_sold, max_sold } = additionalParams;

    const whereProduct = [];
    const params = [startDate, endDate];

    // Use inventory store id (pi.store_id) when filtering by store
    if (storeId) { whereProduct.push('pi.store_id = ?'); params.push(storeId); }
    if (category_id) { whereProduct.push('p.category_id = ?'); params.push(category_id); }
    if (product_id) { whereProduct.push('p.id = ?'); params.push(product_id); }

    const having = [];
    if (min_sold !== undefined) { having.push('COALESCE(SUM(si.quantity),0) >= ?'); params.push(min_sold); }
    if (max_sold !== undefined) { having.push('COALESCE(SUM(si.quantity),0) <= ?'); params.push(max_sold); }

    const query = `
        SELECT
            p.id as product_id,
            p.name as product_name,
            p.product_class_code,
            c.name as category_name,
            COALESCE(pi.stock_quantity, p.stock_quantity) as stock_quantity,
            pi.store_id,
            COALESCE(SUM(si.quantity), 0) as total_sold,
            COALESCE(SUM(si.quantity * si.unit_price), 0) as total_revenue
        FROM products p
        LEFT JOIN productinventories pi ON pi.product_id = p.id
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN saleitems si ON p.id = si.product_id
        LEFT JOIN sales s ON si.sale_id = s.id AND s.created_at BETWEEN ? AND ?
        ${whereProduct.length ? `WHERE ${whereProduct.join(' AND ')}` : ''}
        GROUP BY p.id, pi.store_id
        ${having.length ? `HAVING ${having.join(' AND ')}` : ''}
        ORDER BY total_revenue DESC
         
    `;
    const [rows] = await pool.query(query, params);
    return rows;
};

const generateInventoryReport = async (startDate, endDate, storeId, additionalParams = {}) => {
    // additionalParams: low_stock_only, include_inactive, category_id, min_stock, max_stock
    const { low_stock_only, include_inactive, category_id, min_stock, max_stock } = additionalParams;
    const where = [];
    const params = [];

    // Use inventory store id (pi.store_id) when filtering by store
    if (storeId) { where.push('pi.store_id = ?'); params.push(storeId); }
    if (!include_inactive || include_inactive === 'false') { where.push('p.is_active = 1'); }
    if (category_id) { where.push('p.category_id = ?'); params.push(category_id); }
    if (min_stock !== undefined) { where.push('p.stock_quantity >= ?'); params.push(min_stock); }
    if (max_stock !== undefined) { where.push('p.stock_quantity <= ?'); params.push(max_stock); }
    // Consider inventory min stock level when determining low stock
    if (low_stock_only === 'true') { where.push('p.stock_quantity <= COALESCE(pi.min_stock_level)'); }

    let query = `
        SELECT
            p.id,
            p.name,
            p.product_class_code,
            c.name as category_name,
            p.stock_quantity,
            pi.min_stock_level,
            CASE
                WHEN p.stock_quantity <= COALESCE(pi.min_stock_level) THEN 'Low Stock'
                WHEN p.stock_quantity = 0 THEN 'Out of Stock'
                ELSE 'In Stock'
            END as stock_status,
            p.updated_at as last_updated,
            pi.store_id
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN productinventories pi ON pi.product_id = p.id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY p.stock_quantity ASC, p.name ASC
    `;

    const [rows] = await pool.query(query, params);
    return rows;
};
const generateUserActivityReport = async (startDate, endDate, storeId, additionalParams = {}) => {
    const { user_id, min_revenue } = additionalParams;
    const whereUser = [];
    const params = [startDate, endDate];

    if (storeId) { whereUser.push('u.store_id = ?'); params.push(storeId); }
    if (user_id) { whereUser.push('u.id = ?'); params.push(user_id); }

    const having = [];
    if (min_revenue !== undefined) { having.push('COALESCE(SUM(s.total_amount),0) >= ?'); params.push(min_revenue); }

    let query = `
        SELECT
            u.id,
            u.full_name,
            u.role,
            COUNT(DISTINCT s.id) as total_sales,
            COALESCE(SUM(s.total_amount), 0) as total_revenue,
            MIN(s.created_at) as first_sale,
            MAX(s.created_at) as last_sale
        FROM users u
        LEFT JOIN sales s ON u.id = s.user_id AND s.created_at BETWEEN ? AND ?
        ${whereUser.length ? `WHERE ${whereUser.join(' AND ')}` : ''}
        GROUP BY u.id
        ${having.length ? `HAVING ${having.join(' AND ')}` : ''}
        ORDER BY total_revenue DESC
    `;
    
    const [rows] = await pool.query(query, params);
    return rows;
};


const generateCategoriesReport = async (startDate, endDate, storeId, additionalParams = {}) => {
    const { min_revenue, category_id } = additionalParams;
    const whereCat = [];
    const params = [startDate, endDate];

    // Filter by the store of the user who recorded the sale
    if (storeId) { whereCat.push('u.store_id = ?'); params.push(storeId); }
    if (category_id) { whereCat.push('c.id = ?'); params.push(category_id); }

    const having = [];
    if (min_revenue !== undefined) { having.push('COALESCE(SUM(si.quantity * si.unit_price),0) >= ?'); params.push(min_revenue); }

    let query = `
        SELECT
            c.id,
            c.name,
            COUNT(DISTINCT p.id) as products_count,
            COALESCE(SUM(si.quantity), 0) as total_items_sold,
            COALESCE(SUM(si.quantity * si.unit_price), 0) as total_revenue
        FROM categories c
        LEFT JOIN products p ON c.id = p.category_id
        LEFT JOIN saleitems si ON p.id = si.product_id
        LEFT JOIN sales s ON si.sale_id = s.id AND s.created_at BETWEEN ? AND ?
        LEFT JOIN users u ON s.user_id = u.id
        ${whereCat.length ? `WHERE ${whereCat.join(' AND ')}` : ''}
        GROUP BY c.id, c.name
        ${having.length ? `HAVING ${having.join(' AND ')}` : ''}
        ORDER BY total_revenue DESC
    `;
    
    const [rows] = await pool.query(query, params);
    return rows;
};

const generateTaxReport = async (startDate, endDate, storeId, additionalParams = {}) => {
    const { payment_method } = additionalParams;
    const where = ['s.created_at BETWEEN ? AND ?'];
    const params = [startDate, endDate];

    // Filter by store of the user who performed the sale
    if (storeId) { where.push('u.store_id = ?'); params.push(storeId); }
    if (payment_method) { where.push('s.payment_method = ?'); params.push(payment_method); }

    let query = `
        SELECT
            DATE(s.created_at) as sale_date,
            COUNT(s.id) as transactions_count,
            SUM(s.total_amount) as gross_sales,
            SUM(s.total_amount * 0.16) as vat_collected,
            SUM(s.total_amount * 0.84) as net_sales,
            s.payment_method,
            u.store_id as cashier_store_id,
            st.store_location as cashier_store_location
        FROM sales s
        LEFT JOIN users u ON s.user_id = u.id
        LEFT JOIN stores st ON u.store_id = st.id
        WHERE ${where.join(' AND ')}
        GROUP BY DATE(s.created_at), s.payment_method, u.store_id, st.store_location
        ORDER BY sale_date DESC, payment_method
    `;

    const [rows] = await pool.query(query, params);
    return rows;
};

const generateTransactionsReport = async (startDate, endDate, storeId, additionalParams = {}) => {
    const { category_id, product_id } = additionalParams;

    // SALES
    const salesInclude = [
        { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(storeId ? { where: { store_id: storeId }, required: true } : {}) },
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
        { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(storeId ? { where: { store_id: storeId }, required: true } : {}) },
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

    const reportData = [];

    salesList.forEach(s => {
        reportData.push({
            type: 'SALE',
            id: s.id,
            invoice_no: s.invoice_no,
            date: s.sale_date,
            total_amount: parseFloat(s.total_amount || 0),
            payment_method: s.payment_method,
            cashier_name: s.cashier?.full_name,
            items_count: (s.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0)
        });
    });

    returnsList.forEach(r => {
        reportData.push({
            type: 'RETURN',
            id: r.id,
            invoice_no: r.invoice_no,
            date: r.credit_note_date,
            total_amount: -parseFloat(r.total_amount || 0),
            payment_method: 'N/A',
            cashier_name: r.cashier?.full_name,
            items_count: (r.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0)
        });
    });

    return reportData.sort((a, b) => new Date(b.date) - new Date(a.date));
};

const generateTransactionListReport = async (startDate, endDate, storeId, additionalParams = {}) => {
    const cashierInclude = [{
        model: user,
        as: 'cashier',
        attributes: ['id', 'full_name', 'store_id'],
        ...(storeId ? { where: { store_id: storeId }, required: true } : {})
    }];

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
        ]
    });

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

    return Object.values(itemMap).sort((a, b) => b.total_amount - a.total_amount);
};

const generateReturnsReport = async (startDate, endDate, storeId, additionalParams = {}) => {
    const { category_id, product_id } = additionalParams;

    const includeClause = [
        {
            model: user,
            as: 'cashier',
            attributes: ['id', 'full_name','store_id'],
            ...(storeId ? { where: { store_id: storeId }, required: true } : {})
        },
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

    if (category_id || product_id) {
        includeClause[2].where = {};
        if (product_id) includeClause[2].where.product_id = product_id;
        if (category_id) includeClause[2].include[0].where = { category_id };
    }

    const returnsList = await creditnote.findAll({
        where: { credit_note_date: { [Op.between]: [startDate, endDate] } },
        include: includeClause,
        order: [['credit_note_date', 'DESC']]
    });

    // Normalize fields: prefer common credit-note field names, resolve cashier name, and sum returned quantities
    return returnsList.map(r => {


        const cashierName = r.cashier?.full_name || r.cashier?.name || r.cashier_name || 'Unknown';

        const itemsCount = (r.items || []).reduce((q, i) => q + Number(i.quantity || 0), 0);

        return {
            id: r.id,
            invoice_no: r.invoice_no,
            date: r.credit_note_date || r.created_at,
            total_amount: parseFloat(r.total_amount || 0),
            payment_method: r.payment_method || 'N/A',
            cashier_name: cashierName,
            items_count: itemsCount,
            items: r.items || [],
            raw: r
        };
    });
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
        case 'transactions':
            columns = [
                { header: 'Type', key: 'type', width: 10 },
                { header: 'ID', key: 'id', width: 10 },
                { header: 'Invoice No', key: 'invoice_no', width: 20 },
                { header: 'Date', key: 'date', width: 20 },
                { header: 'Total Amount', key: 'total_amount', width: 15 },
                { header: 'Payment Method', key: 'payment_method', width: 15 },
                { header: 'Cashier', key: 'cashier_name', width: 20 },
                { header: 'Items Count', key: 'items_count', width: 12 }
            ];
            break;
        case 'transaction-list':
            columns = [
                { header: 'Product ID', key: 'product_id', width: 12 },
                { header: 'Product Name', key: 'product_name', width: 30 },
                { header: 'Class Code', key: 'product_class_code', width: 20 },
                { header: 'Total Quantity', key: 'total_quantity', width: 15 },
                { header: 'Total Amount', key: 'total_amount', width: 15 },
                { header: 'Transaction Count', key: 'transaction_count', width: 15 }
            ];
            break;
        case 'returns':
            columns = [
                { header: 'Credit Note ID', key: 'id', width: 12 },
                { header: 'Credit Note No', key: 'invoice_no', width: 20 },
                { header: 'Total Amount', key: 'total_amount', width: 15 },

                { header: 'Cashier', key: 'cashier_name', width: 20 },
                { header: 'Items Count', key: 'items_count', width: 12 },
                { header: 'Date', key: 'credit_note_date', width: 20 }
            ];
            break;
    }

    worksheet.columns = columns;

    // Add title (row 1) - merge across all columns
    const lastCol = String.fromCharCode(64 + columns.length); // Convert column count to letter
    worksheet.mergeCells(`A1:${lastCol}1`);
    const titleCell = worksheet.getCell('A1');
    titleCell.value = `${reportType.toUpperCase()} REPORT - Period: ${new Date(startDate).toLocaleDateString()} - ${new Date(endDate).toLocaleDateString()}`;
    titleCell.font = { bold: true, size: 16 };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };

    // Add header row (row 2)
    worksheet.addRow(columns.map(col => col.header));
    const headerRow = worksheet.getRow(2);
    headerRow.height = 25;
    headerRow.eachCell((cell) => {
        cell.font = headerStyle.font;
        cell.fill = headerStyle.fill;
        cell.alignment = headerStyle.alignment;
        cell.border = headerStyle.border;
    });

    // Helper aliases to map various query column names to our column keys
    const aliasMap = {
        sale_id: ['sale_id', 'id'],
        store_name: ['store_name', 'store_location', 'store'],
        created_at: ['created_at', 'sale_date', 'date', 'createdAt'],
        last_updated: ['last_updated', 'updated_at', 'updatedAt'],
        cashier_name: ['cashier_name', 'full_name', 'cashier'],
        invoice_no: ['invoice_no', 'invoice_number'],
        total_amount: ['total_amount', 'total_revenue', 'gross_sales', 'total_with_tax'],
        unit_price: ['unit_price', 'price'],
        product_id: ['product_id', 'id'],
        product_name: ['product_name', 'name'],
        customer_name: ['customer_name', 'full_name', 'customer'],
        credit_note_date: ['credit_note_date', 'date'],
        stock_quantity: ['stock_quantity', 'stock_qty', 'stock'],
        total_sold: ['total_sold', 'total_quantity'],
        transactions_count: ['transactions_count', 'total_transactions']
    };

    // Add data rows
    data.forEach((item) => {
        const rowObj = {};
        columns.forEach((col) => {
            let val;
            const aliases = aliasMap[col.key] || [col.key];
            for (const a of aliases) {
                if (item[a] !== undefined && item[a] !== null) {
                    val = item[a];
                    break;
                }
            }
            // fallback: try direct key or camelCase/no-underscore variants
            if (val === undefined) {
                const alt1 = col.key.replace(/_/g, '');
                const alt2 = col.key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
                val = item[alt1] !== undefined ? item[alt1] : item[alt2];
            }
            rowObj[col.key] = val !== undefined ? val : null;
        });

        const row = worksheet.addRow(rowObj);

        // Format cells
        row.eachCell((cell, colNumber) => {
            const column = columns[colNumber - 1];

            // Currency / numeric formatting
            if (column && (column.key.includes('amount') || column.key.includes('price') || column.key.includes('revenue') || column.key.includes('total') || column.key.includes('gross'))) {
                if (typeof cell.value === 'number') {
                    cell.numFmt = '#,##0.00';
                }
                cell.alignment = { horizontal: 'right' };
            }

            // Date formatting
            if (column && (column.key.includes('date') || column.key.includes('created_at') || column.key.includes('updated_at') || column.key.includes('sale_date') || column.key.includes('first_sale') || column.key.includes('last_sale'))) {
                if (cell.value) {
                    const dt = new Date(cell.value);
                    if (!isNaN(dt.getTime())) {
                        cell.value = dt;
                        cell.numFmt = 'yyyy-mm-dd hh:mm:ss';
                    }
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

    // Protect worksheet to disable editing
    await worksheet.protect('pos-report-protected', {
        selectLockedCells: true,
        selectUnlockedCells: true,
        formatCells: false,
        formatColumns: false,
        formatRows: false,
        insertColumns: false,
        insertRows: false,
        insertHyperlinks: false,
        deleteColumns: false,
        deleteRows: false,
        sort: false,
        autoFilter: false,
        pivotTables: false
    });

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
        const validReportTypes = ['sales', 'products', 'inventory', 'user-activity', 'categories', 'tax', 'returns', 'transactions', 'transaction-list'];
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

        logger.info('reports_email_generation_started', { siteId, userId: req.user?.id, storeId: storeId, reportType, start_date, end_date });

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
            case 'returns':
                reportData = await generateReturnsReport(startDate, endDate, storeId, additionalParams);
                break;
            case 'transactions':
                reportData = await generateTransactionsReport(startDate, endDate, storeId, additionalParams);
                break;
            case 'transaction-list':
                reportData = await generateTransactionListReport(startDate, endDate, storeId, additionalParams);
                break;
        }

        // Normalize reportData to be an array
        const actualData = (reportData && !Array.isArray(reportData))
            ? (reportData.items || reportData.sales || reportData.returns || reportData.categories || [])
            : reportData;
        const dataArray = Array.isArray(actualData) ? actualData : (actualData ? [actualData] : []);

        if (!dataArray || dataArray.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No data found for the specified date range'
            });
        }

        // Create Excel workbook
        const workbook = await createExcelReport(reportType, dataArray, startDate, endDate);

        // Save to temporary file
        const appBaseDir = (process.pkg) ? path.dirname(process.execPath) : __dirname;
        const tempDir = path.join(appBaseDir, 'temp');
        await fs.mkdir(tempDir, { recursive: true });

        const fileName = `${reportType}_report_${Date.now()}.xlsx`;
        tempFilePath = path.join(tempDir, fileName);

        await workbook.xlsx.writeFile(tempFilePath);

        // Send email with attachment
        const transporter = createEmailTransporter();

        const mailOptions = {
            from: `"${process.env.COMPANY_NAME || 'SwiftCart POS'}" <${process.env.SMTP_USER }>`,
            to: email,
            subject: `${reportType.toUpperCase()} Report - ${new Date(startDate).toLocaleDateString()} to ${new Date(endDate).toLocaleDateString()}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
                    <div style="background-color: #4472C4; color: white; padding: 20px; text-align: center;">
                        <h1 style="margin: 0; font-size: 24px;">Report Ready</h1>
                    </div>
                    <div style="padding: 20px; color: #333; line-height: 1.6;">
                        <p>Hello,</p>
                        <p>Your requested <strong>${reportType.toUpperCase()}</strong> report has been generated successfully.</p>
                        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 4px; margin: 20px 0;">
                            <h3 style="margin-top: 0; color: #4472C4;">Report Details:</h3>
                            <table style="width: 100%; border-collapse: collapse;">
                                <tr>
                                    <td style="padding: 5px 0; color: #666; width: 100px;"><strong>Period:</strong></td>
                                    <td style="padding: 5px 0;">${new Date(startDate).toLocaleDateString()} to ${new Date(endDate).toLocaleDateString()}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 5px 0; color: #666;"><strong>Records:</strong></td>
                                    <td style="padding: 5px 0;">${dataArray.length}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 5px 0; color: #666;"><strong>Format:</strong></td>
                                    <td style="padding: 5px 0;">Excel (.xlsx) - Protected</td>
                                </tr>
                            </table>
                        </div>
                        <p>The attached file is locked to prevent accidental modifications and ensure data integrity.</p>
                        <p>If you have any questions, please contact your administrator.</p>
                    </div>
                    <div style="background-color: #f0f0f0; padding: 15px; text-align: center; color: #777; font-size: 12px;">
                        <p style="margin: 0;">This is an automated message from ${process.env.COMPANY_NAME || 'SwiftCart POS'}.</p>
                        <p style="margin: 5px 0 0 0;">Please do not reply to this email.</p>
                    </div>
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
                recordsCount: dataArray.length,
                additionalParams
            }
        });

    } catch (error) {
        logger.error('reports_email_error', { siteId, userId: req.user?.id, storeId: req.user?.store_id, error: error.message, stack: error.stack });

        // Clean up temporary file if it exists
        if (tempFilePath) {
            try {
                await fs.unlink(tempFilePath);
            } catch (unlinkError) {
                logger.error('reports_email_cleanup_error', { error: unlinkError.message });
            }
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

        const returnsList = await generateReturnsReport(startDate, endDate, filterStoreId, { category_id, product_id });

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
            const date = new Date(r.date).toDateString();


            summary.payment_methods[method] = (summary.payment_methods[method] || 0) + parseFloat(r.total_amount || 0);

            if (!summary.daily_breakdown[date]) {
                summary.daily_breakdown[date] = { returns: 0, amount: 0, items_quantity: 0 };
            }
            summary.daily_breakdown[date].returns++;
           summary.daily_breakdown[date].amount += parseFloat(r.total_amount || 0);
            summary.daily_breakdown[date].items_quantity += (r.items || []).reduce((q, i) => q + Number(i.quantity || 0), 0);
        });

        const itemsSummary = returnsList.reduce((acc, r) => {
            (r.items || []).forEach(item => {
                const productId = item.product_id;
                if (!acc[productId]) {
                    acc[productId] = {
                        product_id: productId,
                        product_name: item.product?.name || 'Unknown',
                        total_quantity: 0,
                        total_amount: 0
                    };
                }
                acc[productId].total_quantity += Number(item.quantity || 0);
                acc[productId].total_amount += parseFloat(item.total_price || 0);
            });
            return acc;
        }, {});

        res.json({
            report_type,
            date_range: { start_date, end_date },
            returns: returnsList,
            summary,
            items_summary: Object.values(itemsSummary)
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
            items_sold_gross: salesList.reduce((s, x) => s + (x.items ? x.items.reduce((q, i) => q + Number(i.quantity || 0), 0) : 0), 0),
            items_returned: returnsList.reduce((s, x) => s + (x.items ? x.items.reduce((q, i) => q + Number(i.quantity || 0), 0) : 0), 0),
            items_count: (salesList.reduce((s, x) => s + (x.items ? x.items.length : 0), 0)),
            items_quantity: (salesList.reduce((s, x) => s + (x.items ? x.items.reduce((q, i) => q + Number(i.quantity || 0), 0) : 0), 0)) - (returnsList.reduce((s, x) => s + (x.items ? x.items.reduce((q, i) => q + Number(i.quantity || 0), 0) : 0), 0)),
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
                addToCategory(cat ? cat.id : null, cat ? cat.name : null, -Number(i.quantity || 0), -Number(i.total_price || 0));
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
                const changeAmount = Number(s.change_amount || 0);
                if (bd && typeof bd === 'object') {
                    Object.entries(bd).forEach(([method, amt]) => {
                        const key = (method || 'unknown').toString();
                        let finalAmt = Number(amt || 0);
                        if (s.payment_method === 'mixed' && key === 'cash' && changeAmount > 0) {
                            finalAmt = Math.max(0, finalAmt - changeAmount);
                        }
                        paymentBreakdown[key] = (paymentBreakdown[key] || 0) + finalAmt;
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
                    items_sold_gross: salesList.reduce((s, x) => s + ((x.items || []).reduce((q, i) => q + Number(i.quantity || 0), 0)), 0),
                    items_returned: returnsList.reduce((s, x) => s + ((x.items || []).reduce((q, i) => q + Number(i.quantity || 0), 0)), 0),
                    items_sold: salesList.reduce((s, x) => s + ((x.items || []).reduce((q, i) => q + Number(i.quantity || 0), 0)), 0) - returnsList.reduce((s, x) => s + ((x.items || []).reduce((q, i) => q + Number(i.quantity || 0), 0)), 0)
                },
                totals: {
                    gross_sales: grossSales - (returnsTotalAmount - returnsTax),
                    discounts: discounts - returnsDiscount,
                    net_sales_before_tax: Math.max((grossSales - (returnsTotalAmount - returnsTax)) - (discounts - returnsDiscount), 0),
                    tax_collected: tax - returnsTax,
                    returns_amount: returnsTotalAmount,
                    returns_tax: returnsTax,
                    returns_discount: returnsDiscount,
                    net_revenue: salesTotalAmount - returnsTotalAmount
                },
                payments: paymentBreakdown,
                categories
            };

            return res.json({ report_type: isZ ? 'Z' : 'X', date_range: { start_date, end_date }, traditional, summary: traditional });
        }

        res.json(payload);

    } catch (error) {
        console.error('Transactions report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;