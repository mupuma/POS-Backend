// // Add these routes to your backend router
// const express = require("express");

// const router = express.Router();
// const { sale, saleitem, product, user, customer, category, productinventory, sequelize, creditnote, creditnoteitem, store } = require('../models');
// const auth = require('../middleware/auth');
// const { Op } = require('sequelize');
// const { annotateSalesWithReturnState, getReturnStateMap } = require('../services/sales/returnState');
// const { buildActorFromUser, logRequestAudit } = require('../services/auditLogService');

// function getModels(req) {
//     return req.app.locals.models || require('../models');
// }

// function getReportAuditContext(req) {
//     const exportMatch = req.path.match(/^\/([^/]+)\/export$/);
//     if (req.method === 'GET' && exportMatch) {
//         return { action: 'report.export', operation: 'export', reportType: exportMatch[1] };
//     }

//     const emailMatch = req.path.match(/^\/([^/]+)\/email$/);
//     if (req.method === 'POST' && emailMatch) {
//         return { action: 'report.email', operation: 'email', reportType: emailMatch[1] };
//     }

//     const reportTypeByPath = {
//         '/sales': 'sales',
//         '/transaction-list': 'transaction-list',
//         '/products': 'products',
//         '/inventory': 'inventory',
//         '/user-activity': 'user-activity',
//         '/categories': 'categories',
//         '/tax': 'tax',
//         '/returns': 'returns',
//         '/transactions': 'transactions',
//     };

//     const reportType = reportTypeByPath[req.path];
//     if (!reportType) {
//         return null;
//     }

//     return { action: 'report.generate', operation: 'generate', reportType };
// }

// router.use((req, res, next) => {
//     const auditContext = getReportAuditContext(req);

//     if (!auditContext) {
//         next();
//         return;
//     }

//     res.on('finish', () => {
//         if (!req.user) {
//             return;
//         }

//         const params = req.method === 'POST' ? req.body || {} : req.query || {};

//         void logRequestAudit(getModels(req), req, {
//             action: auditContext.action,
//             outcome: res.statusCode < 400 ? 'success' : 'failure',
//             entityType: 'report',
//             ...buildActorFromUser(req.user),
//             target_identifier: auditContext.reportType,
//             target_name: auditContext.reportType,
//             details: {
//                 operation: auditContext.operation,
//                 route: req.originalUrl,
//                 statusCode: res.statusCode,
//                 start_date: params.start_date || null,
//                 end_date: params.end_date || null,
//                 report_type: params.report_type || null,
//                 format: params.format || null,
//                 email: auditContext.operation === 'email' ? params.email || null : null,
//             },
//         });
//     });

//     next();
// });

// async function getActiveSalesRows(rows) {
//     const annotated = await annotateSalesWithReturnState(rows);
//     return {
//         annotated,
//         active: annotated.filter(row => !row.is_fully_returned)
//     };
// }

// async function getActiveSaleItemRows(rows) {
//     const saleRows = rows
//         .map(row => row.sale)
//         .filter(Boolean);
//     const returnStateMap = await getReturnStateMap(saleRows);
//     const activeSaleIds = new Set(
//         [...returnStateMap.entries()]
//             .filter(([, state]) => !state.is_fully_returned)
//             .map(([saleId]) => saleId)
//     );
//     return rows.filter(row => activeSaleIds.has(row.sale?.id));
// }

// function buildCashierPerformance(salesList, returnsList = []) {
//     const cashierMap = new Map();

//     const ensureEntry = (userId, name) => {
//         const key = userId != null ? String(userId) : 'unknown';
//         if (!cashierMap.has(key)) {
//             cashierMap.set(key, {
//                 cashier_id: userId ?? null,
//                 cashier_name: name || 'Unknown',
//                 items_sold: 0,
//                 gross_sales: 0,
//                 transactions: 0,
//                 returns: 0,
//             });
//         }
//         return cashierMap.get(key);
//     };

//     (salesList || []).forEach((saleRow) => {
//         const entry = ensureEntry(saleRow.user_id, saleRow.cashier?.full_name);
//         entry.transactions += 1;
//         entry.gross_sales += Number(saleRow.subtotal || 0);
//         entry.items_sold += (saleRow.items || []).reduce(
//             (qty, item) => qty + Number(item.quantity || 0),
//             0
//         );
//     });

//     (returnsList || []).forEach((returnRow) => {
//         const entry = ensureEntry(returnRow.user_id, returnRow.cashier?.full_name);
//         entry.returns += 1;
//     });

//     return [...cashierMap.values()].sort((a, b) => b.gross_sales - a.gross_sales);
// }

// async function resolveStoreInfo(storeId) {
//     if (!storeId) {
//         return null;
//     }

//     const storeRecord = await store.findByPk(storeId, {
//         attributes: ['id', 'store_number', 'store_location'],
//     });

//     if (!storeRecord) {
//         return null;
//     }

//     return {
//         id: storeRecord.id,
//         name: storeRecord.store_location || storeRecord.store_number || `Store ${storeRecord.id}`,
//         store_number: storeRecord.store_number || null,
//     };
// }

// // Dashboard Statistics (unified)
// router.get('/dashboard', auth, async (req, res) => {
//     try {
//         const { computeDashboardStats } = require('../services/reports/dashboardStats');
//         const data = await computeDashboardStats(req);
//         console.log(data);
//         res.json({ success: true, data, timestamp: new Date().toISOString() });
//     } catch (error) {
//         console.error('Dashboard stats error:', error);
//         res.status(500).json({ success: false, message: 'Server error' });
//     }
// });

// // Sales Report (comprehensive)
// router.get('/sales', auth, async (req, res) => {
//     try {
//         const { start_date, end_date, report_type = 'summary', category_id, product_id, user_id } = req.query;

//         if (!start_date || !end_date) {
//             return res.status(400).json({ message: 'Start date and end date are required' });
//         }

//         const startDate = new Date(start_date);
//         const endDate = new Date(end_date);

//         let whereClause = {
//             sale_date: { [Op.between]: [startDate, endDate] }
//         };

//         if (user_id) {
//             whereClause.user_id = user_id;
//         }

//         const filterStoreId = req.user.store_id;

//         const includeClause = [
//             { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
//             { model: customer, as: 'customer' },
//             {
//                 model: saleitem,
//                 as: 'items',
//                 include: [{
//                     model: product,
//                     as: 'product',
//                     include: [{ model: category, as: 'category' }]
//                 }]
//             }
//         ];

//         // Filter by category or product if specified
//         if (category_id || product_id) {
//             includeClause[2].where = {};
//             if (product_id) {
//                 includeClause[2].where.product_id = product_id;
//             }
//             if (category_id) {
//                 includeClause[2].include[0].where = { category_id };
//             }
//         }

//         const sales = await sale.findAll({
//             where: whereClause,
//             include: includeClause,
//             order: [['sale_date', 'DESC']]
//         });

//         const activeSales = (await getActiveSalesRows(sales)).active;

//         const summary = {
//             total_sales: activeSales.length,
//             total_revenue: activeSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0),
//             total_discounts: activeSales.reduce((sum, s) => sum + parseFloat(s.discount_amount || 0), 0),
//             total_tax: activeSales.reduce((sum, s) => sum + parseFloat(s.tax_amount || 0), 0),
//             items_count: activeSales.reduce((sum, s) => sum + (s.items ? s.items.length : 0), 0),
//             items_quantity: activeSales.reduce((sum, s) => sum + (s.items ? s.items.reduce((q, i) => q + Number(i.quantity || 0), 0) : 0), 0),
//             payment_methods: {},
//             daily_breakdown: {}
//         };

//         // Group by payment method (allocating mixed payments) and daily breakdown
//         activeSales.forEach(s => {
//             const date = s.sale_date.toDateString();

//             // Allocate by payment breakdown if present
//             const bd = s.payments_breakdown;
//             if (bd && typeof bd === 'object') {
//                 const total = Object.values(bd).reduce((a, v) => a + Number(v || 0), 0) || 0;
//                 if (total > 0) {
//                     Object.entries(bd).forEach(([method, amt]) => {
//                         const key = method || 'unknown';
//                         summary.payment_methods[key] = (summary.payment_methods[key] || 0) + Number(amt || 0);
//                     });
//                 } else {
//                     const method = s.payment_method || 'unknown';
//                     summary.payment_methods[method] = (summary.payment_methods[method] || 0) + parseFloat(s.total_amount || 0);
//                 }
//             } else {
//                 const method = s.payment_method || 'unknown';
//                 summary.payment_methods[method] = (summary.payment_methods[method] || 0) + parseFloat(s.total_amount || 0);
//             }

//             if (!summary.daily_breakdown[date]) {
//                 summary.daily_breakdown[date] = { sales: 0, revenue: 0 };
//             }
//             summary.daily_breakdown[date].sales++;
//             summary.daily_breakdown[date].revenue += parseFloat(s.total_amount || 0);
//         });

//         // Traditional X/Z format support on /reports/sales using the same endpoint
//         if (['x', 'z', 'X', 'Z'].includes(report_type)) {
//             const isZ = report_type.toLowerCase() === 'z';

//             // Fetch returns within the same date range to net against sales
//             const returnsInclude = [
//                 { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
//                 {
//                     model: creditnoteitem,
//                     as: 'items',
//                     include: [{
//                         model: product,
//                         as: 'product',
//                         include: [{ model: category, as: 'category' }]
//                     }]
//                 }
//             ];

//             const returnsList = await creditnote.findAll({
//                 where: { credit_note_date: { [Op.between]: [startDate, endDate] } },
//                 include: returnsInclude
//             });

//             const grossSales = activeSales.reduce((sum, s) => sum + Number(s.subtotal || 0), 0);
//             const discounts = activeSales.reduce((sum, s) => sum + Number(s.discount_amount || 0), 0);
//             const tax = activeSales.reduce((sum, s) => sum + Number(s.tax_amount || 0), 0);
//             const salesTotalAmount = activeSales.reduce((sum, s) => sum + Number(s.total_amount || 0), 0);
//             const returnsTotalAmount = returnsList.reduce((sum, r) => sum + Number(r.total_amount || 0), 0);
//             const returnsTax = returnsList.reduce((sum, r) => sum + Number(r.tax_amount || 0), 0);
//             const returnsDiscount = returnsList.reduce((sum, r) => sum + Number(r.discount_amount || 0), 0);

//             // Normalize to CASH, CARD, MOBILE_MONEY, OTHER
//             const normalizeMethod = (m) => {
//                 const x = (m || '').toString().trim().toLowerCase();
//                 if (x === 'cash') return 'CASH';
//                 if (['card', 'visa', 'mastercard', 'debit', 'credit', 'pos'].includes(x)) return 'CARD';
//                 if (['mobile', 'mobile money', 'mobile_money', 'mpesa', 'm-pesa', 'm pesa', 'momo', 'airtel money', 'tigo pesa'].includes(x)) return 'MOBILE_MONEY';
//                 return 'OTHER';
//             };

//             const paymentBreakdown = { CASH: 0, CARD: 0, MOBILE_MONEY: 0, OTHER: 0 };
//             activeSales.forEach(s => {
//                 const bd = s.payments_breakdown;
//                 if (bd && typeof bd === 'object') {
//                     Object.entries(bd).forEach(([method, amt]) => {
//                         const key = normalizeMethod(method);
//                         paymentBreakdown[key] = (paymentBreakdown[key] || 0) + Number(amt || 0);
//                     });
//                 } else {
//                     const key = normalizeMethod(s.payment_method);
//                     paymentBreakdown[key] = (paymentBreakdown[key] || 0) + Number(s.total_amount || 0);
//                 }
//             });
//             returnsList.forEach(r => {
//                 const key = normalizeMethod(r.payment_method);
//                 paymentBreakdown[key] = (paymentBreakdown[key] || 0) - Number(r.total_amount || 0);
//             });

//             const itemsSold = activeSales.reduce((s, x) => s + ((x.items || []).reduce((q, i) => q + Number(i.quantity || 0), 0)), 0);
//             const itemsReturned = returnsList.reduce((s, x) => s + ((x.items || []).reduce((q, i) => q + Number(i.quantity || 0), 0)), 0);

//             // Category summary (net of returns)
//             const categoryMap = {};
//             const addToCategory = (catId, catName, qty, amount) => {
//                 const key = catId || 'uncategorized';
//                 if (!categoryMap[key]) {
//                     categoryMap[key] = { category_id: catId || null, category_name: catName || 'Uncategorized', items_quantity: 0, revenue: 0 };
//                 }
//                 categoryMap[key].items_quantity += qty;
//                 categoryMap[key].revenue += amount;
//             };
//             activeSales.forEach(saleRow => {
//                 (saleRow.items || []).forEach(i => {
//                     const cat = i.product && i.product.category;
//                     addToCategory(cat ? cat.id : null, cat ? cat.name : null, Number(i.quantity || 0), Number(i.total_price || 0));
//                 });
//             });
//             returnsList.forEach(ret => {
//                 (ret.items || []).forEach(i => {
//                     const cat = i.product && i.product.category;
//                     addToCategory(cat ? cat.id : null, cat ? cat.name : null, Number(i.quantity || 0), -Number(i.total_price || 0));
//                 });
//             });

//             const storeInfo = await resolveStoreInfo(filterStoreId);
//             const cashiers = buildCashierPerformance(activeSales, returnsList);

//             const traditional = {
//                 report_name: isZ ? 'Z Report' : 'X Report',
//                 period: { start: start_date, end: end_date },
//                 store_id: req.user && req.user.store_id ? req.user.store_id : null,
//                 store: storeInfo || undefined,
//                 cashier: req.user && req.user.full_name ? { id: req.user.id, name: req.user.full_name } : undefined,
//                 cashiers,
//                 counts: {
//                     transactions: activeSales.length,
//                     returns: returnsList.length,
//                     items_sold: itemsSold,
//                     items_returned: itemsReturned
//                 },
//                 totals: {
//                     gross_sales: grossSales,
//                     discounts: discounts,
//                     net_sales_before_tax: Math.max(grossSales - discounts, 0),
//                     tax_collected: tax,
//                     returns_amount: returnsTotalAmount,
//                     returns_tax: returnsTax,
//                     returns_discount: returnsDiscount,
//                     net_revenue: salesTotalAmount - returnsTotalAmount
//                 },
//                 payments: paymentBreakdown,
//                 categories: Object.values(categoryMap)
//             };

//             return res.json({ report_type: isZ ? 'Z' : 'X', date_range: { start_date, end_date }, traditional });
//         }

//         res.json({
//             report_type,
//             date_range: { start_date, end_date },
//             sales: activeSales,
//             summary
//         });

//     } catch (error) {
//         console.error('Sales report error:', error);
//         res.status(500).json({ message: 'Server error' });
//     }
// });

// // Transaction List Report - Grouped by Item
// router.get('/transaction-list', auth, async (req, res) => {
//     try {
//         const { start_date, end_date, period = 'day' } = req.query;

//         if (!start_date || !end_date) {
//             return res.status(400).json({ message: 'Start date and end date are required' });
//         }

//         const startDate = new Date(start_date);
//         const endDate = new Date(end_date);
//         const filterStoreId = req.user.store_id;

//         const cashierInclude = [{
//             model: user,
//             as: 'cashier',
//             attributes: ['id', 'full_name', 'store_id'],
//             ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {})
//         }];

//         // Get all sales in the period
//         const sales = await sale.findAll({
//             where: {
//                 sale_date: { [Op.between]: [startDate, endDate] }
//             },
//             include: [
//                 ...cashierInclude,
//                 {
//                     model: saleitem,
//                     as: 'items',
//                     include: [{
//                         model: product,
//                         as: 'product',
//                         attributes: ['id', 'name', 'product_class_code', 'price']
//                     }]
//                 }
//             ],
//             order: [['sale_date', 'DESC']]
//         });

//         const activeSales = (await getActiveSalesRows(sales)).active;

//         // Group items across all sales
//         const itemMap = {};

//         activeSales.forEach(s => {
//             (s.items || []).forEach(item => {
//                 const productId = item.product_id;
//                 const productName = item.product?.name || 'Unknown Product';

//                 if (!itemMap[productId]) {
//                     itemMap[productId] = {
//                         product_id: productId,
//                         product_name: productName,
//                         product_class_code: item.product?.product_class_code || '',
//                         total_quantity: 0,
//                         total_amount: 0,
//                         transaction_count: 0
//                     };
//                 }

//                 itemMap[productId].total_quantity += parseInt(item.quantity || 0);
//                 itemMap[productId].total_amount += parseFloat(item.total_price || 0);
//                 itemMap[productId].transaction_count += 1;
//             });
//         });

//         const itemsSummary = Object.values(itemMap).sort((a, b) =>
//             b.total_amount - a.total_amount
//         );

//         const summary = {
//             period,
//             total_transactions: activeSales.length,
//             total_items_sold: itemsSummary.reduce((sum, item) => sum + item.total_quantity, 0),
//             total_revenue: itemsSummary.reduce((sum, item) => sum + item.total_amount, 0),
//             unique_products: itemsSummary.length
//         };

//         res.json({
//             date_range: { start_date, end_date },
//             period,
//             summary,
//             items: itemsSummary
//         });

//     } catch (error) {
//         console.error('Transaction list report error:', error);
//         res.status(500).json({ message: 'Server error' });
//     }
// });
// // Product Performance Report
// router.get('/products', auth, async (req, res) => {
//     try {
//         const { start_date, end_date, category_id, limit = 50 } = req.query;

//         if (!start_date || !end_date) {
//             return res.status(400).json({ message: 'Start date and end date are required' });
//         }

//         const startDate = new Date(start_date);
//         const endDate = new Date(end_date);

//         let includeWhere = {
//             '$sale.sale_date$': { [Op.between]: [startDate, endDate] }
//         };

//         if (category_id) {
//             includeWhere['$product.category_id$'] = category_id;
//         }

//         const productSalesRows = await saleitem.findAll({
//             where: includeWhere,
//             include: [
//                 {
//                     model: product,
//                     as: 'product',
//                     include: [{ model: category, as: 'category' }]
//                 },
//                 { model: sale, as: 'sale' }
//             ]
//         });

//         const activeProductSalesRows = await getActiveSaleItemRows(productSalesRows);
//         const productMap = new Map();

//         activeProductSalesRows.forEach(row => {
//             const current = productMap.get(row.product_id) || {
//                 product_id: row.product_id,
//                 product_name: row.product?.name || 'Unknown Product',
//                 product_class_code: row.product?.product_class_code || '',
//                 total_quantity: 0,
//                 total_revenue: 0,
//                 transaction_count: 0,
//             };
//             current.total_quantity += Number(row.quantity || 0);
//             current.total_revenue += Number(row.total_price || 0);
//             current.transaction_count += 1;
//             productMap.set(row.product_id, current);
//         });

//         const productSales = [...productMap.values()].sort((a, b) => b.total_revenue - a.total_revenue).slice(0, parseInt(limit));

//         res.json({
//             date_range: { start_date, end_date },
//             products: productSales
//         });

//     } catch (error) {
//         console.error('Product performance report error:', error);
//         res.status(500).json({ message: 'Server error' });
//     }
// });

// // Inventory Report
// router.get('/inventory', auth, async (req, res) => {
//     try {
//         const { low_stock_only, category_id, include_inactive = false } = req.query;

//         const store_id = req.user.store_id;

//         // Build inventory where clause
//         const inventoryWhere = { store_id };

//         const productWhere = {};
//         if (!include_inactive || include_inactive === 'false') {
//             productWhere.is_active = true;
//         }
//         if (category_id) {
//             productWhere.category_id = category_id;
//         }
//         if (low_stock_only === 'true') {
//             inventoryWhere[Op.and] = [
//                 sequelize.where(sequelize.col('stock_quantity'), Op.lte, sequelize.col('min_stock_level'))
//             ];
//         }

//         const inventories = await productinventory.findAll({
//             where: inventoryWhere,
//             include: [{ model: product, as: 'product', where: productWhere, include: [{ model: category, as: 'category' }] }],
//             order: [['stock_quantity', 'ASC']]
//         });

//         const summary = {
//             total_products: inventories.length,
//             total_stock_value: inventories.reduce((sum, inv) =>
//                 sum + (parseFloat(inv.product?.cost || 0) * parseInt(inv.stock_quantity || 0)), 0),
//             low_stock_items: inventories.filter(inv =>
//                 parseInt(inv.stock_quantity || 0) <= parseInt(inv.min_stock_level || 0)).length,
//             out_of_stock_items: inventories.filter(inv =>
//                 parseInt(inv.stock_quantity || 0) === 0).length
//         };

//         res.json({
//             inventories,
//             summary
//         });

//     } catch (error) {
//         console.error('Inventory report error:', error);
//         res.status(500).json({ message: 'Server error' });
//     }
// });

// // User Activity Report
// router.get('/user-activity', auth, async (req, res) => {
//     try {
//         const { start_date, end_date, user_id } = req.query;

//         if (!start_date || !end_date) {
//             return res.status(400).json({ message: 'Start date and end date are required' });
//         }

//         const startDate = new Date(start_date);
//         const endDate = new Date(end_date);

//         let whereClause = {
//             sale_date: { [Op.between]: [startDate, endDate] }
//         };

//         if (user_id) {
//             whereClause.user_id = user_id;
//         }

//         const userSales = await sale.findAll({
//             where: whereClause,
//             include: [{ model: user, as: 'cashier', attributes: ['id', 'full_name', 'role'] }]
//         });

//         const activeUserSales = (await getActiveSalesRows(userSales)).active;
//         const userActivityMap = new Map();

//         activeUserSales.forEach(s => {
//             const key = s.user_id;
//             const current = userActivityMap.get(key) || {
//                 user_id: key,
//                 cashier: s.cashier || null,
//                 total_sales: 0,
//                 total_revenue: 0,
//             };
//             current.total_sales += 1;
//             current.total_revenue += Number(s.total_amount || 0);
//             userActivityMap.set(key, current);
//         });

//         res.json({
//             date_range: { start_date, end_date },
//             user_activity: [...userActivityMap.values()].sort((a, b) => b.total_sales - a.total_sales)
//         });

//     } catch (error) {
//         console.error('User activity report error:', error);
//         res.status(500).json({ message: 'Server error' });
//     }
// });

// // Category Performance Report
// router.get('/categories', auth, async (req, res) => {
//     try {
//         const { start_date, end_date } = req.query;

//         if (!start_date || !end_date) {
//             return res.status(400).json({ message: 'Start date and end date are required' });
//         }

//         const startDate = new Date(start_date);
//         const endDate = new Date(end_date);

//         const categorySalesRows = await saleitem.findAll({
//             where: {
//                 '$sale.sale_date$': { [Op.between]: [startDate, endDate] }
//             },
//             include: [
//                 {
//                     model: product,
//                     as: 'product',
//                     include: [{ model: category, as: 'category' }]
//                 },
//                 { model: sale, as: 'sale' }
//             ]
//         });

//         const activeCategorySalesRows = await getActiveSaleItemRows(categorySalesRows);
//         const categoryMap = new Map();

//         activeCategorySalesRows.forEach(row => {
//             const cat = row.product && row.product.category;
//             const key = cat ? cat.id : 'uncategorized';
//             const current = categoryMap.get(key) || {
//                 category_id: cat ? cat.id : null,
//                 category_name: cat ? cat.name : 'Uncategorized',
//                 total_quantity: 0,
//                 total_revenue: 0,
//                 transaction_count: 0,
//             };
//             current.total_quantity += Number(row.quantity || 0);
//             current.total_revenue += Number(row.total_price || 0);
//             current.transaction_count += 1;
//             categoryMap.set(key, current);
//         });

//         const categorySales = [...categoryMap.values()].sort((a, b) => b.total_revenue - a.total_revenue);

//         res.json({
//             date_range: { start_date, end_date },
//             categories: categorySales
//         });

//     } catch (error) {
//         console.error('Category performance report error:', error);
//         res.status(500).json({ message: 'Server error' });
//     }
// });

// // Tax Report
// router.get('/tax', auth, async (req, res) => {
//     try {
//         const { start_date, end_date } = req.query;

//         if (!start_date || !end_date) {
//             return res.status(400).json({ message: 'Start date and end date are required' });
//         }

//         const startDate = new Date(start_date);
//         const endDate = new Date(end_date);

//         const taxSales = await sale.findAll({
//             where: {
//                 sale_date: { [Op.between]: [startDate, endDate] }
//             }
//         });
//         const activeTaxSales = (await getActiveSalesRows(taxSales)).active;

//         const taxSummary = activeTaxSales.reduce((acc, saleRow) => {
//             acc.total_subtotal += Number(saleRow.subtotal || 0);
//             acc.total_tax += Number(saleRow.tax_amount || 0);
//             acc.total_with_tax += Number(saleRow.total_amount || 0);
//             acc.total_transactions += 1;
//             return acc;
//         }, {
//             total_subtotal: 0,
//             total_tax: 0,
//             total_with_tax: 0,
//             total_transactions: 0,
//         });

//         const dailyMap = new Map();
//         activeTaxSales.forEach(saleRow => {
//             const key = saleRow.sale_date ? new Date(saleRow.sale_date).toISOString().slice(0, 10) : 'unknown';
//             const current = dailyMap.get(key) || {
//                 date: key,
//                 daily_tax: 0,
//                 daily_transactions: 0,
//             };
//             current.daily_tax += Number(saleRow.tax_amount || 0);
//             current.daily_transactions += 1;
//             dailyMap.set(key, current);
//         });

//         res.json({
//             date_range: { start_date, end_date },
//             summary: taxSummary,
//             daily_breakdown: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date))
//         });

//     } catch (error) {
//         console.error('Tax report error:', error);
//         res.status(500).json({ message: 'Server error' });
//     }
// });

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

// // Email Report Route - All reports are sent in Excel format only
// const ExcelJS = require('exceljs');
// const nodemailer = require('nodemailer');
// const fs = require('fs').promises;
// const path = require('path');
// const { pool } = require('../config/database'); // Adjust path as needed

// // Configure email transporter (use environment variables)
// const createEmailTransporter = () => {
//     return nodemailer.createTransport({
//         host: process.env.SMTP_HOST || 'smtp.gmail.com',
//         port: process.env.SMTP_PORT || 587,
//         secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
//         auth: {
//             user: process.env.SMTP_USER,
//             pass: process.env.SMTP_PASS
//         }
//     });
// };

// // Report generation functions
// const generateSalesReport = async (startDate, endDate, storeId, additionalParams) => {
//     const query = `
//         SELECT 
//             s.id as sale_id,
//             s.receipt_number,
//             s.invoice_no,
//             s.receipt_no,
//             s.total_amount,
//             s.payment_method,
//             s.sale_date as created_at,
//             u.full_name as cashier_name,
//             COALESCE(st.store_number, st.store_location, st.id) as store_name,
//             COUNT(si.id) as items_count
//         FROM sales s
//         LEFT JOIN users u ON s.user_id = u.id
//         LEFT JOIN stores st ON u.store_id = st.id
//         LEFT JOIN sale_items si ON s.id = si.sale_id
//         WHERE s.sale_date BETWEEN ? AND ?
//         ${storeId ? 'AND u.store_id = ?' : ''}
//         GROUP BY s.id
//         ORDER BY s.sale_date DESC
//     `;

//     const params = storeId ? [startDate, endDate, storeId] : [startDate, endDate];
//     const [rows] = await pool.query(query, params);
//     return rows;
// };

// const generateProductsReport = async (startDate, endDate, storeId, additionalParams) => {
//     const query = `
//         SELECT 
//             p.id as product_id,
//             p.name as product_name,
//             p.product_class_code,
//             c.name as category_name,
//             p.price as unit_price,
//             p.stock_quantity,
//             COALESCE(SUM(si.quantity), 0) as total_sold,
//             COALESCE(SUM(si.quantity * si.unit_price), 0) as total_revenue
//         FROM products p
//         LEFT JOIN categories c ON p.category_id = c.id
//         LEFT JOIN sale_items si ON p.id = si.product_id
//         LEFT JOIN sales s ON si.sale_id = s.id AND s.created_at BETWEEN ? AND ?
//         WHERE p.store_id = ?
//         GROUP BY p.id
//         ORDER BY total_revenue DESC
//     `;

//     const [rows] = await pool.query(query, [startDate, endDate, storeId]);
//     return rows;
// };

// const generateInventoryReport = async (startDate, endDate, storeId, additionalParams) => {
//     const query = `
//         SELECT 
//             p.id as product_id,
//             p.name as product_name,
//             p.product_class_code,
//             c.name as category_name,
//             p.price as unit_price,
//             p.stock_quantity,
//             p.min_stock_level as reorder_level,
//             CASE 
//                 WHEN p.stock_quantity <= p.min_stock_level THEN 'Low Stock'
//                 WHEN p.stock_quantity = 0 THEN 'Out of Stock'
//                 ELSE 'In Stock'
//             END as stock_status,
//             p.updated_at as last_updated
//         FROM products p
//         LEFT JOIN categories c ON p.category_id = c.id
//         WHERE p.store_id = ?
//         ORDER BY p.stock_quantity ASC, p.name ASC
//     `;

//     const [rows] = await pool.query(query, [storeId]);
//     return rows;
// };

// const generateUserActivityReport = async (startDate, endDate, storeId, additionalParams) => {
//     const query = `
//         SELECT 
//             u.id as user_id,
//             u.full_name,
//             u.email,
//             u.role,
//             COUNT(DISTINCT s.id) as total_sales,
//             COALESCE(SUM(s.total_amount), 0) as total_revenue,
//             MIN(s.created_at) as first_sale,
//             MAX(s.created_at) as last_sale
//         FROM users u
//         LEFT JOIN sales s ON u.id = s.user_id AND s.created_at BETWEEN ? AND ?
//         WHERE u.store_id = ?
//         GROUP BY u.id
//         ORDER BY total_revenue DESC
//     `;

//     const [rows] = await pool.query(query, [startDate, endDate, storeId]);
//     return rows;
// };

// const generateCategoriesReport = async (startDate, endDate, storeId, additionalParams) => {
//     const query = `
//         SELECT 
//             c.id as category_id,
//             c.name as category_name,
//             COUNT(DISTINCT p.id) as products_count,
//             COALESCE(SUM(si.quantity), 0) as total_items_sold,
//             COALESCE(SUM(si.quantity * si.unit_price), 0) as total_revenue
//         FROM categories c
//         LEFT JOIN products p ON c.id = p.category_id
//         LEFT JOIN sale_items si ON p.id = si.product_id
//         LEFT JOIN sales s ON si.sale_id = s.id AND s.created_at BETWEEN ? AND ?
//         WHERE c.store_id = ?
//         GROUP BY c.id
//         ORDER BY total_revenue DESC
//     `;

//     const [rows] = await pool.query(query, [startDate, endDate, storeId]);
//     return rows;
// };

// const generateTaxReport = async (startDate, endDate, storeId, additionalParams) => {
//     const query = `
//         SELECT 
//             DATE(s.created_at) as sale_date,
//             COUNT(s.id) as transactions_count,
//             SUM(s.total_amount) as gross_sales,
//             SUM(s.total_amount * 0.16) as vat_collected,
//             SUM(s.total_amount * 0.84) as net_sales,
//             s.payment_method
//         FROM sales s
//         WHERE s.created_at BETWEEN ? AND ?
//         ${storeId ? 'AND s.store_id = ?' : ''}
//         GROUP BY DATE(s.created_at), s.payment_method
//         ORDER BY sale_date DESC, payment_method
//     `;

//     const params = storeId ? [startDate, endDate, storeId] : [startDate, endDate];
//     const [rows] = await pool.query(query, params);
//     return rows;
// };

// // Create Excel workbook from data
// const createExcelReport = async (reportType, data, startDate, endDate) => {
//     const workbook = new ExcelJS.Workbook();
//     const worksheet = workbook.addWorksheet(reportType.toUpperCase() + ' Report');

//     // Style definitions
//     const headerStyle = {
//         font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 },
//         fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } },
//         alignment: { vertical: 'middle', horizontal: 'center' },
//         border: {
//             top: { style: 'thin' },
//             left: { style: 'thin' },
//             bottom: { style: 'thin' },
//             right: { style: 'thin' }
//         }
//     };

//     // Add title
//     worksheet.mergeCells('A1:F1');
//     const titleCell = worksheet.getCell('A1');
//     titleCell.value = `${reportType.toUpperCase()} REPORT`;
//     titleCell.font = { bold: true, size: 16 };
//     titleCell.alignment = { horizontal: 'center', vertical: 'middle' };

//     // Add date range
//     worksheet.mergeCells('A2:F2');
//     const dateCell = worksheet.getCell('A2');
//     dateCell.value = `Period: ${new Date(startDate).toLocaleDateString()} - ${new Date(endDate).toLocaleDateString()}`;
//     dateCell.alignment = { horizontal: 'center' };

//     worksheet.addRow([]); // Empty row

//     // Define columns based on report type
//     let columns = [];

//     switch (reportType) {
//         case 'sales':
//             columns = [
//                 { header: 'Sale ID', key: 'sale_id', width: 12 },
//                 { header: 'Invoice No', key: 'invoice_no', width: 20 },
//                 { header: 'Receipt No', key: 'receipt_no', width: 20 },
//                 { header: 'Total Amount', key: 'total_amount', width: 15 },
//                 { header: 'Payment Method', key: 'payment_method', width: 15 },
//                 { header: 'Cashier', key: 'cashier_name', width: 20 },
//                 { header: 'Store', key: 'store_name', width: 20 },
//                 { header: 'Items Count', key: 'items_count', width: 12 },
//                 { header: 'Date', key: 'created_at', width: 20 }
//             ];
//             break;
//         case 'products':
//             columns = [
//                 { header: 'Product ID', key: 'product_id', width: 12 },
//                 { header: 'Product Name', key: 'product_name', width: 30 },
//                 { header: 'Classification code', key: 'product_class_code', width: 20 },
//                 { header: 'Category', key: 'category_name', width: 20 },
//                 { header: 'Unit Price', key: 'unit_price', width: 15 },
//                 { header: 'Stock Qty', key: 'stock_quantity', width: 12 },
//                 { header: 'Total Sold', key: 'total_sold', width: 12 },
//                 { header: 'Total Revenue', key: 'total_revenue', width: 15 }
//             ];
//             break;
//         case 'inventory':
//             columns = [
//                 { header: 'Product ID', key: 'product_id', width: 12 },
//                 { header: 'Product Name', key: 'product_name', width: 30 },
//                 { header: 'Classification code', key: 'product_class_code', width: 20 },
//                 { header: 'Category', key: 'category_name', width: 20 },
//                 { header: 'Unit Price', key: 'unit_price', width: 15 },
//                 { header: 'Stock Qty', key: 'stock_quantity', width: 12 },
//                 { header: 'Reorder Level', key: 'reorder_level', width: 15 },
//                 { header: 'Status', key: 'stock_status', width: 15 },
//                 { header: 'Last Updated', key: 'last_updated', width: 20 }
//             ];
//             break;
//         case 'user-activity':
//             columns = [
//                 { header: 'User ID', key: 'user_id', width: 12 },
//                 { header: 'Full Name', key: 'full_name', width: 25 },
//                 { header: 'Email', key: 'email', width: 30 },
//                 { header: 'Role', key: 'role', width: 15 },
//                 { header: 'Total Sales', key: 'total_sales', width: 15 },
//                 { header: 'Total Revenue', key: 'total_revenue', width: 15 },
//                 { header: 'First Sale', key: 'first_sale', width: 20 },
//                 { header: 'Last Sale', key: 'last_sale', width: 20 }
//             ];
//             break;
//         case 'categories':
//             columns = [
//                 { header: 'Category ID', key: 'category_id', width: 15 },
//                 { header: 'Category Name', key: 'category_name', width: 25 },
//                 { header: 'Products Count', key: 'products_count', width: 15 },
//                 { header: 'Items Sold', key: 'total_items_sold', width: 15 },
//                 { header: 'Total Revenue', key: 'total_revenue', width: 15 }
//             ];
//             break;
//         case 'tax':
//             columns = [
//                 { header: 'Date', key: 'sale_date', width: 15 },
//                 { header: 'Transactions', key: 'transactions_count', width: 15 },
//                 { header: 'Gross Sales', key: 'gross_sales', width: 15 },
//                 { header: 'VAT (16%)', key: 'vat_collected', width: 15 },
//                 { header: 'Net Sales', key: 'net_sales', width: 15 },
//                 { header: 'Payment Method', key: 'payment_method', width: 15 }
//             ];
//             break;
//     }

//     worksheet.columns = columns;

//     // Apply header style
//     const headerRow = worksheet.getRow(4);
//     headerRow.eachCell((cell) => {
//         cell.style = headerStyle;
//     });
//     headerRow.height = 25;

//     // Add data rows
//     data.forEach((item) => {
//         const row = worksheet.addRow(item);

//         // Format currency columns
//         row.eachCell((cell, colNumber) => {
//             const column = columns[colNumber - 1];
//             if (column && (column.key.includes('amount') || column.key.includes('price') || column.key.includes('revenue'))) {
//                 cell.numFmt = 'K#,##0.00';
//                 cell.alignment = { horizontal: 'right' };
//             }

//             // Format date columns
//             if (column && (column.key.includes('date') || column.key.includes('created_at') || column.key.includes('updated_at'))) {
//                 if (cell.value) {
//                     cell.value = new Date(cell.value);
//                     cell.numFmt = 'yyyy-mm-dd hh:mm:ss';
//                 }
//             }

//             // Add borders
//             cell.border = {
//                 top: { style: 'thin', color: { argb: 'FFD3D3D3' } },
//                 left: { style: 'thin', color: { argb: 'FFD3D3D3' } },
//                 bottom: { style: 'thin', color: { argb: 'FFD3D3D3' } },
//                 right: { style: 'thin', color: { argb: 'FFD3D3D3' } }
//             };
//         });
//     });

//     // Add summary row for financial reports
//     if (['sales', 'products', 'categories', 'tax'].includes(reportType)) {
//         worksheet.addRow([]);
//         const summaryRow = worksheet.addRow(['TOTAL', '', '', '', '', '', '', '']);
//         summaryRow.font = { bold: true };
//         summaryRow.fill = {
//             type: 'pattern',
//             pattern: 'solid',
//             fgColor: { argb: 'FFF2F2F2' }
//         };
//     }

//     return workbook;
// };

// // Main route handler
// router.post('/:reportType/email', auth, async (req, res) => {
//     let tempFilePath = null;

//     try {
//         const { reportType } = req.params;
//         const { format, start_date, end_date, email, ...additionalParams } = req.body;

//         // Validate required parameters
//         if (!start_date || !end_date || !email) {
//             return res.status(400).json({
//                 message: 'start_date, end_date, and email are required',
//                 success: false
//             });
//         }

//         // Validate email format
//         const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
//         if (!emailRegex.test(email)) {
//             return res.status(400).json({
//                 message: 'Invalid email format',
//                 success: false
//             });
//         }

//         // Force format to be xlsx
//         const finalFormat = 'xlsx';

//         // Validate reportType
//         const validReportTypes = ['sales', 'products', 'inventory', 'user-activity', 'categories', 'tax'];
//         if (!validReportTypes.includes(reportType)) {
//             return res.status(400).json({
//                 message: `Invalid report type. Must be one of: ${validReportTypes.join(', ')}`,
//                 success: false
//             });
//         }

//         // Validate date range
//         const startDate = new Date(start_date);
//         const endDate = new Date(end_date);

//         if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
//             return res.status(400).json({
//                 message: 'Invalid date format. Use ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)',
//                 success: false
//             });
//         }

//         if (startDate > endDate) {
//             return res.status(400).json({
//                 message: 'start_date cannot be after end_date',
//                 success: false
//             });
//         }

//         // Get store_id from authenticated user
//         const storeId = req.user?.store_id;

//         console.log(`Generating ${reportType} report from ${start_date} to ${end_date} for store ${storeId}`);

//         // Generate report data based on type
//         let reportData;
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
//         }

//         if (!reportData || reportData.length === 0) {
//             return res.status(404).json({
//                 success: false,
//                 message: 'No data found for the specified date range'
//             });
//         }

//         // Create Excel workbook
//         const workbook = await createExcelReport(reportType, reportData, startDate, endDate);

//         // Save to temporary file
//         const tempDir = path.join(__dirname, '../temp');
//         await fs.mkdir(tempDir, { recursive: true });

//         const fileName = `${reportType}_report_${Date.now()}.xlsx`;
//         tempFilePath = path.join(tempDir, fileName);

//         await workbook.xlsx.writeFile(tempFilePath);

//         // Send email with attachment
//         const transporter = createEmailTransporter();

//         const mailOptions = {
//             from: `"${process.env.COMPANY_NAME || 'SwiftCart POS'}" <${process.env.SMTP_USER}>`,
//             to: email,
//             subject: `${reportType.toUpperCase()} Report - ${new Date(startDate).toLocaleDateString()} to ${new Date(endDate).toLocaleDateString()}`,
//             html: `
//                 <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
//                     <h2 style="color: #4472C4;">Your ${reportType.toUpperCase()} Report is Ready</h2>
//                     <p>Hello,</p>
//                     <p>Please find attached your requested ${reportType} report for the period:</p>
//                     <ul>
//                         <li><strong>From:</strong> ${new Date(startDate).toLocaleDateString()}</li>
//                         <li><strong>To:</strong> ${new Date(endDate).toLocaleDateString()}</li>
//                         <li><strong>Records:</strong> ${reportData.length}</li>
//                     </ul>
//                     <p>The report is in Excel format (.xlsx) and can be opened with Microsoft Excel, Google Sheets, or any compatible spreadsheet application.</p>
//                     <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
//                     <p style="color: #666; font-size: 12px;">
//                         This is an automated message from ${process.env.COMPANY_NAME || 'DAPP POS'}. 
//                         Please do not reply to this email.
//                     </p>
//                 </div>
//             `,
//             attachments: [
//                 {
//                     filename: fileName,
//                     path: tempFilePath
//                 }
//             ]
//         };

//         await transporter.sendMail(mailOptions);

//         // Clean up temporary file
//         await fs.unlink(tempFilePath);
//         tempFilePath = null;

//         // Return success response
//         res.status(200).json({
//             success: true,
//             status: 'ok',
//             message: `${reportType} report has been sent to ${email} in Excel format`,
//             details: {
//                 reportType,
//                 format: finalFormat,
//                 dateRange: {
//                     start_date,
//                     end_date
//                 },
//                 email,
//                 recordsCount: reportData.length,
//                 additionalParams
//             }
//         });

//     } catch (error) {
//         console.error('Email report error:', error);

//         // Clean up temporary file if it exists


//         res.status(500).json({
//             message: 'Server error while sending report email',
//             success: false,
//             error: process.env.NODE_ENV === 'development' ? error.message : undefined
//         });
//     }
// });
// // Returns Report (credit notes)
// router.get('/returns', auth, async (req, res) => {
//     try {
//         const { start_date, end_date, report_type = 'summary', category_id, product_id, user_id } = req.query;

//         if (!start_date || !end_date) {
//             return res.status(400).json({ message: 'Start date and end date are required' });
//         }

//         const startDate = new Date(start_date);
//         const endDate = new Date(end_date);

//         const filterStoreId = req.user.store_id;

//         const returnsWhere = {
//             credit_note_date: { [Op.between]: [startDate, endDate] },
//         };
//         if (user_id) {
//             returnsWhere.user_id = user_id;
//         }

//         const includeClause = [
//             { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
//             { model: customer, as: 'customer' },
//             {
//                 model: creditnoteitem,
//                 as: 'items',
//                 include: [{
//                     model: product,
//                     as: 'product',
//                     include: [{ model: category, as: 'category' }]
//                 }]
//             }
//         ];

//         // Filter by category or product if specified
//         if (category_id || product_id) {
//             includeClause[2].where = {};
//             if (product_id) {
//                 includeClause[2].where.product_id = product_id;
//             }
//             if (category_id) {
//                 includeClause[2].include[0].where = { category_id };
//             }
//         }

//         const returnsList = await creditnote.findAll({
//             where: returnsWhere,
//             include: includeClause,
//             order: [['credit_note_date', 'DESC']]
//         });

//         const summary = {
//             total_returns: returnsList.length,
//             total_amount: returnsList.reduce((sum, r) => sum + parseFloat(r.total_amount || 0), 0),
//             total_discounts: returnsList.reduce((sum, r) => sum + parseFloat(r.discount_amount || 0), 0),
//             total_tax: returnsList.reduce((sum, r) => sum + parseFloat(r.tax_amount || 0), 0),
//             items_count: returnsList.reduce((sum, r) => sum + (r.items ? r.items.length : 0), 0),
//             items_quantity: returnsList.reduce((sum, r) => sum + (r.items ? r.items.reduce((q, i) => q + Number(i.quantity || 0), 0) : 0), 0),
//             payment_methods: {},
//             daily_breakdown: {}
//         };

//         returnsList.forEach(r => {
//             const method = r.payment_method || 'unknown';
//             const date = new Date(r.credit_note_date).toDateString();

//             summary.payment_methods[method] = (summary.payment_methods[method] || 0) + parseFloat(r.total_amount || 0);

//             if (!summary.daily_breakdown[date]) {
//                 summary.daily_breakdown[date] = { returns: 0, amount: 0 };
//             }
//             summary.daily_breakdown[date].returns++;
//             summary.daily_breakdown[date].amount += parseFloat(r.total_amount || 0);
//         });

//         res.json({
//             report_type,
//             date_range: { start_date, end_date },
//             returns: returnsList,
//             summary
//         });

//     } catch (error) {
//         console.error('Returns report error:', error);
//         res.status(500).json({ message: 'Server error' });
//     }
// });

// // Combined Transactions Report (sales + returns)
// router.get('/transactions', auth, async (req, res) => {
//     try {
//         const { start_date, end_date, report_type = 'summary', category_id, product_id } = req.query;

//         if (!start_date || !end_date) {
//             return res.status(400).json({ message: 'Start date and end date are required' });
//         }

//         const startDate = new Date(start_date);
//         const endDate = new Date(end_date);
//         const filterStoreId = req.user.store_id;

//         // SALES
//         const salesInclude = [
//             { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
//             {
//                 model: saleitem,
//                 as: 'items',
//                 include: [{
//                     model: product,
//                     as: 'product',
//                     include: [{ model: category, as: 'category' }]
//                 }]
//             }
//         ];
//         if (category_id || product_id) {
//             salesInclude[1].where = {};
//             if (product_id) salesInclude[1].where.product_id = product_id;
//             if (category_id) salesInclude[1].include[0].where = { category_id };
//         }
//         const salesList = await sale.findAll({
//             where: { sale_date: { [Op.between]: [startDate, endDate] } },
//             include: salesInclude
//         });

//         // RETURNS
//         const returnsInclude = [
//             { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
//             {
//                 model: creditnoteitem,
//                 as: 'items',
//                 include: [{
//                     model: product,
//                     as: 'product',
//                     include: [{ model: category, as: 'category' }]
//                 }]
//             }
//         ];
//         if (category_id || product_id) {
//             returnsInclude[1].where = {};
//             if (product_id) returnsInclude[1].where.product_id = product_id;
//             if (category_id) returnsInclude[1].include[0].where = { category_id };
//         }
//         const returnsList = await creditnote.findAll({
//             where: { credit_note_date: { [Op.between]: [startDate, endDate] } },
//             include: returnsInclude
//         });

//         const overall = {
//             total_sales: salesList.length,
//             total_returns: returnsList.length,
//             items_count: (salesList.reduce((s, x) => s + (x.items ? x.items.length : 0), 0)) + (returnsList.reduce((s, x) => s + (x.items ? x.items.length : 0), 0)),
//             items_quantity: (salesList.reduce((s, x) => s + (x.items ? x.items.reduce((q, i) => q + Number(i.quantity || 0), 0) : 0), 0)) + (returnsList.reduce((s, x) => s + (x.items ? x.items.reduce((q, i) => q + Number(i.quantity || 0), 0) : 0), 0)),
//             revenue: salesList.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0) - returnsList.reduce((sum, r) => sum + parseFloat(r.total_amount || 0), 0),
//         };

//         // Per-category breakdown
//         const categoryMap = {};
//         const addToCategory = (catId, catName, qty, amount) => {
//             if (!categoryMap[catId || 'uncategorized']) {
//                 categoryMap[catId || 'uncategorized'] = { category_id: catId || null, category_name: catName || 'Uncategorized', items_quantity: 0, revenue: 0 };
//             }
//             categoryMap[catId || 'uncategorized'].items_quantity += qty;
//             categoryMap[catId || 'uncategorized'].revenue += amount;
//         };

//         // Sales items positive
//         salesList.forEach(s => {
//             (s.items || []).forEach(i => {
//                 const cat = i.product && i.product.category;
//                 addToCategory(cat ? cat.id : null, cat ? cat.name : null, Number(i.quantity || 0), Number(i.total_price || 0));
//             });
//         });
//         // Returns items negative revenue and quantities
//         returnsList.forEach(r => {
//             (r.items || []).forEach(i => {
//                 const cat = i.product && i.product.category;
//                 addToCategory(cat ? cat.id : null, cat ? cat.name : null, Number(i.quantity || 0), -Number(i.total_price || 0));
//             });
//         });

//         const categories = Object.values(categoryMap);

//         const payload = {
//             report_type,
//             date_range: { start_date, end_date },
//             summary: overall,
//             categories
//         };

//         if (report_type === 'detailed') {
//             payload.sales = salesList;
//             payload.returns = returnsList;
//         }

//         // Traditional X/Z format support using the same endpoint
//         if (['x', 'z', 'X', 'Z'].includes(report_type)) {
//             const isZ = report_type.toLowerCase() === 'z';
//             const grossSales = salesList.reduce((sum, s) => sum + Number(s.subtotal || 0), 0);
//             const discounts = salesList.reduce((sum, s) => sum + Number(s.discount_amount || 0), 0);
//             const tax = salesList.reduce((sum, s) => sum + Number(s.tax_amount || 0), 0);
//             const salesTotalAmount = salesList.reduce((sum, s) => sum + Number(s.total_amount || 0), 0);
//             const returnsTotalAmount = returnsList.reduce((sum, r) => sum + Number(r.total_amount || 0), 0);
//             const returnsTax = returnsList.reduce((sum, r) => sum + Number(r.tax_amount || 0), 0);
//             const returnsDiscount = returnsList.reduce((sum, r) => sum + Number(r.discount_amount || 0), 0);

//             // Payment methods breakdown (net of returns if method matches)
//             const paymentBreakdown = {};
//             salesList.forEach(s => {
//                 const bd = s.payments_breakdown;
//                 if (bd && typeof bd === 'object') {
//                     Object.entries(bd).forEach(([method, amt]) => {
//                         const key = (method || 'unknown').toString();
//                         paymentBreakdown[key] = (paymentBreakdown[key] || 0) + Number(amt || 0);
//                     });
//                 } else {
//                     const method = s.payment_method || 'unknown';
//                     paymentBreakdown[method] = (paymentBreakdown[method] || 0) + Number(s.total_amount || 0);
//                 }
//             });
//             returnsList.forEach(r => {
//                 const method = r.payment_method || 'unknown';
//                 paymentBreakdown[method] = (paymentBreakdown[method] || 0) - Number(r.total_amount || 0);
//             });

//             const storeInfo = await resolveStoreInfo(filterStoreId);
//             const cashiers = buildCashierPerformance(salesList, returnsList);

//             const traditional = {
//                 report_name: isZ ? 'Z Report' : 'X Report',
//                 period: { start: start_date, end: end_date },
//                 store_id: req.user && req.user.store_id ? req.user.store_id : null,
//                 store: storeInfo || undefined,
//                 cashier: req.user && req.user.full_name ? { id: req.user.id, name: req.user.full_name } : undefined,
//                 cashiers,
//                 counts: {
//                     transactions: salesList.length,
//                     returns: returnsList.length,
//                     items_sold: salesList.reduce((s, x) => s + ((x.items || []).reduce((q, i) => q + Number(i.quantity || 0), 0)), 0),
//                     items_returned: returnsList.reduce((s, x) => s + ((x.items || []).reduce((q, i) => q + Number(i.quantity || 0), 0)), 0)
//                 },
//                 totals: {
//                     gross_sales: grossSales,
//                     discounts: discounts,
//                     net_sales_before_tax: Math.max(grossSales - discounts, 0),
//                     tax_collected: tax,
//                     returns_amount: returnsTotalAmount,
//                     returns_tax: returnsTax,
//                     returns_discount: returnsDiscount,
//                     net_revenue: salesTotalAmount - returnsTotalAmount
//                 },
//                 payments: paymentBreakdown,
//                 categories
//             };

//             return res.json({ report_type: isZ ? 'Z' : 'X', date_range: { start_date, end_date }, traditional });
//         }

//         res.json(payload);

//     } catch (error) {
//         console.error('Transactions report error:', error);
//         res.status(500).json({ message: 'Server error' });
//     }
// });

// router.generateSalesReport = generateSalesReport;
// router.createExcelReport = createExcelReport;
// router.createEmailTransporter = createEmailTransporter;

// module.exports = router;




// reports.js - Complete working code

const express = require("express");
const router = express.Router();
const ExcelJS = require('exceljs');
const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');
const { Op } = require('sequelize');

const { sale, saleitem, product, user, customer, category, productinventory, sequelize, creditnote, creditnoteitem, store } = require('../models');
const auth = require('../middleware/auth');
const { annotateSalesWithReturnState, getReturnStateMap } = require('../services/sales/returnState');
const { buildActorFromUser, logRequestAudit } = require('../services/auditLogService');
const { sortRows } = require('../services/query/inMemorySort');

// ==================== HELPER FUNCTIONS ====================

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
    if (!reportType) return null;

    return { action: 'report.generate', operation: 'generate', reportType };
}

// Format currency for ZMW
const formatCurrency = (value) => {
    if (value === null || value === undefined) return '0.00';
    return parseFloat(value).toLocaleString('en-ZM', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
};

// Format date for display
const formatDate = (date) => {
    if (!date) return '';
    const d = new Date(date);
    return d.toLocaleDateString('en-ZM', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
};

async function getActiveSalesRows(rows) {
    const annotated = await annotateSalesWithReturnState(rows);
    return {
        annotated,
        active: annotated.filter(row => !row.is_fully_returned)
    };
}

async function getActiveSaleItemRows(rows) {
    const saleRows = rows.map(row => row.sale).filter(Boolean);
    const returnStateMap = await getReturnStateMap(saleRows);
    const activeSaleIds = new Set(
        [...returnStateMap.entries()]
            .filter(([, state]) => !state.is_fully_returned)
            .map(([saleId]) => saleId)
    );
    return rows.filter(row => activeSaleIds.has(row.sale?.id));
}

function buildCashierPerformance(salesList, returnsList = []) {
    const cashierMap = new Map();

    const ensureEntry = (userId, name) => {
        const key = userId != null ? String(userId) : 'unknown';
        if (!cashierMap.has(key)) {
            cashierMap.set(key, {
                cashier_id: userId ?? null,
                cashier_name: name || 'Unknown',
                items_sold: 0,
                gross_sales: 0,
                transactions: 0,
                returns: 0,
            });
        }
        return cashierMap.get(key);
    };

    (salesList || []).forEach((saleRow) => {
        const entry = ensureEntry(saleRow.user_id, saleRow.cashier?.full_name);
        entry.transactions += 1;
        entry.gross_sales += Number(saleRow.subtotal || 0);
        entry.items_sold += (saleRow.items || []).reduce(
            (qty, item) => qty + Number(item.quantity || 0),
            0
        );
    });

    (returnsList || []).forEach((returnRow) => {
        const entry = ensureEntry(returnRow.user_id, returnRow.cashier?.full_name);
        entry.returns += 1;
    });

    return [...cashierMap.values()].sort((a, b) => b.gross_sales - a.gross_sales);
}

async function resolveStoreInfo(storeId) {
    if (!storeId) return null;
    const storeRecord = await store.findByPk(storeId, {
        attributes: ['id', 'store_number', 'store_location'],
    });
    if (!storeRecord) return null;
    return {
        id: storeRecord.id,
        name: storeRecord.store_location || storeRecord.store_number || `Store ${storeRecord.id}`,
        store_number: storeRecord.store_number || null,
    };
}

// ==================== MIDDLEWARE ====================

router.use((req, res, next) => {
    const auditContext = getReportAuditContext(req);
    if (!auditContext) {
        next();
        return;
    }

    res.on('finish', () => {
        if (!req.user) return;
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

// ==================== REPORT ENDPOINTS ====================

// Dashboard Statistics
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

// Sales Report
router.get('/sales', auth, async (req, res) => {
    try {
        const { start_date, end_date, report_type = 'summary', category_id, product_id, user_id } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);
        let whereClause = { sale_date: { [Op.between]: [startDate, endDate] } };
        if (user_id) whereClause.user_id = user_id;

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

        if (category_id || product_id) {
            includeClause[2].where = {};
            if (product_id) includeClause[2].where.product_id = product_id;
            if (category_id) includeClause[2].include[0].where = { category_id };
        }

        const sales = await sale.findAll({
            where: whereClause,
            include: includeClause
        });
        sortRows(sales, [['sale_date', 'DESC']]);

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

        activeSales.forEach(s => {
            const date = s.sale_date.toDateString();
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

        if (['x', 'z', 'X', 'Z'].includes(report_type)) {
            const isZ = report_type.toLowerCase() === 'z';
            const returnsList = await creditnote.findAll({
                where: { credit_note_date: { [Op.between]: [startDate, endDate] } },
                include: [
                    { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
                    { model: creditnoteitem, as: 'items', include: [{ model: product, as: 'product' }] }
                ]
            });

            const grossSales = activeSales.reduce((sum, s) => sum + Number(s.subtotal || 0), 0);
            const discounts = activeSales.reduce((sum, s) => sum + Number(s.discount_amount || 0), 0);
            const tax = activeSales.reduce((sum, s) => sum + Number(s.tax_amount || 0), 0);
            const salesTotalAmount = activeSales.reduce((sum, s) => sum + Number(s.total_amount || 0), 0);
            const returnsTotalAmount = returnsList.reduce((sum, r) => sum + Number(r.total_amount || 0), 0);
            const returnsTax = returnsList.reduce((sum, r) => sum + Number(r.tax_amount || 0), 0);
            const returnsDiscount = returnsList.reduce((sum, r) => sum + Number(r.discount_amount || 0), 0);

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

            const storeInfo = await resolveStoreInfo(filterStoreId);
            const cashiers = buildCashierPerformance(activeSales, returnsList);

            const traditional = {
                report_name: isZ ? 'Z Report' : 'X Report',
                period: { start: start_date, end: end_date },
                store_id: req.user && req.user.store_id ? req.user.store_id : null,
                store: storeInfo || undefined,
                cashier: req.user && req.user.full_name ? { id: req.user.id, name: req.user.full_name } : undefined,
                cashiers,
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

        res.json({ report_type, date_range: { start_date, end_date }, sales: activeSales, summary });
    } catch (error) {
        console.error('Sales report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Transaction List Report
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

        const sales = await sale.findAll({
            where: { sale_date: { [Op.between]: [startDate, endDate] } },
            include: [
                ...cashierInclude,
                {
                    model: saleitem,
                    as: 'items',
                    include: [{ model: product, as: 'product', attributes: ['id', 'name', 'product_class_code', 'price'] }]
                }
            ]
        });
        sortRows(sales, [['sale_date', 'DESC']]);

        const activeSales = (await getActiveSalesRows(sales)).active;
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

        const itemsSummary = Object.values(itemMap).sort((a, b) => b.total_amount - a.total_amount);
        const summary = {
            period,
            total_transactions: activeSales.length,
            total_items_sold: itemsSummary.reduce((sum, item) => sum + item.total_quantity, 0),
            total_revenue: itemsSummary.reduce((sum, item) => sum + item.total_amount, 0),
            unique_products: itemsSummary.length
        };

        res.json({ date_range: { start_date, end_date }, period, summary, items: itemsSummary });
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
        let includeWhere = { '$sale.sale_date$': { [Op.between]: [startDate, endDate] } };
        if (category_id) includeWhere['$product.category_id$'] = category_id;

        const productSalesRows = await saleitem.findAll({
            where: includeWhere,
            include: [
                { model: product, as: 'product', include: [{ model: category, as: 'category' }] },
                { model: sale, as: 'sale' }
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
        res.json({ date_range: { start_date, end_date }, products: productSales });
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

        const inventoryWhere = { store_id };
        const productWhere = {};
        if (!include_inactive || include_inactive === 'false') productWhere.is_active = true;
        if (category_id) productWhere.category_id = category_id;
        if (low_stock_only === 'true') {
            inventoryWhere[Op.and] = [
                sequelize.where(sequelize.col('stock_quantity'), Op.lte, sequelize.col('min_stock_level'))
            ];
        }

        const inventories = await productinventory.findAll({
            where: inventoryWhere,
            include: [{ model: product, as: 'product', where: productWhere, include: [{ model: category, as: 'category' }] }]
        });
        sortRows(inventories, [['stock_quantity', 'ASC']]);

        const summary = {
            total_products: inventories.length,
            total_stock_value: inventories.reduce((sum, inv) => sum + (parseFloat(inv.product?.cost || 0) * parseInt(inv.stock_quantity || 0)), 0),
            low_stock_items: inventories.filter(inv => parseInt(inv.stock_quantity || 0) <= parseInt(inv.min_stock_level || 0)).length,
            out_of_stock_items: inventories.filter(inv => parseInt(inv.stock_quantity || 0) === 0).length
        };

        res.json({ inventories, summary });
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
        let whereClause = { sale_date: { [Op.between]: [startDate, endDate] } };
        if (user_id) whereClause.user_id = user_id;

        const userSales = await sale.findAll({
            where: whereClause,
            include: [{ model: user, as: 'cashier', attributes: ['id', 'full_name', 'role'] }]
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

        res.json({ date_range: { start_date, end_date }, user_activity: [...userActivityMap.values()].sort((a, b) => b.total_sales - a.total_sales) });
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

        const categorySalesRows = await saleitem.findAll({
            where: { '$sale.sale_date$': { [Op.between]: [startDate, endDate] } },
            include: [
                { model: product, as: 'product', include: [{ model: category, as: 'category' }] },
                { model: sale, as: 'sale' }
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
        res.json({ date_range: { start_date, end_date }, categories: categorySales });
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

        const taxSales = await sale.findAll({
            where: { sale_date: { [Op.between]: [startDate, endDate] } }
        });
        const activeTaxSales = (await getActiveSalesRows(taxSales)).active;

        const taxSummary = activeTaxSales.reduce((acc, saleRow) => {
            acc.total_subtotal += Number(saleRow.subtotal || 0);
            acc.total_tax += Number(saleRow.tax_amount || 0);
            acc.total_with_tax += Number(saleRow.total_amount || 0);
            acc.total_transactions += 1;
            return acc;
        }, { total_subtotal: 0, total_tax: 0, total_with_tax: 0, total_transactions: 0 });

        const dailyMap = new Map();
        activeTaxSales.forEach(saleRow => {
            const key = saleRow.sale_date ? new Date(saleRow.sale_date).toISOString().slice(0, 10) : 'unknown';
            const current = dailyMap.get(key) || { date: key, daily_tax: 0, daily_transactions: 0 };
            current.daily_tax += Number(saleRow.tax_amount || 0);
            current.daily_transactions += 1;
            dailyMap.set(key, current);
        });

        res.json({ date_range: { start_date, end_date }, summary: taxSummary, daily_breakdown: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)) });
    } catch (error) {
        console.error('Tax report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Returns Report
router.get('/returns', auth, async (req, res) => {
    try {
        const { start_date, end_date, report_type = 'summary', category_id, product_id, user_id } = req.query;
        if (!start_date || !end_date) {
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);
        const filterStoreId = req.user.store_id;

        const returnsWhere = { credit_note_date: { [Op.between]: [startDate, endDate] } };
        if (user_id) returnsWhere.user_id = user_id;

        const includeClause = [
            { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
            { model: customer, as: 'customer' },
            { model: creditnoteitem, as: 'items', include: [{ model: product, as: 'product', include: [{ model: category, as: 'category' }] }] }
        ];

        if (category_id || product_id) {
            includeClause[2].where = {};
            if (product_id) includeClause[2].where.product_id = product_id;
            if (category_id) includeClause[2].include[0].where = { category_id };
        }

        const returnsList = await creditnote.findAll({
            where: returnsWhere,
            include: includeClause
        });
        sortRows(returnsList, [['credit_note_date', 'DESC']]);

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

        res.json({ report_type, date_range: { start_date, end_date }, returns: returnsList, summary });
    } catch (error) {
        console.error('Returns report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Combined Transactions Report
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
            { model: saleitem, as: 'items', include: [{ model: product, as: 'product', include: [{ model: category, as: 'category' }] }] }
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
            { model: creditnoteitem, as: 'items', include: [{ model: product, as: 'product', include: [{ model: category, as: 'category' }] }] }
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

        const categoryMap = {};
        const addToCategory = (catId, catName, qty, amount) => {
            const key = catId || 'uncategorized';
            if (!categoryMap[key]) {
                categoryMap[key] = { category_id: catId || null, category_name: catName || 'Uncategorized', items_quantity: 0, revenue: 0 };
            }
            categoryMap[key].items_quantity += qty;
            categoryMap[key].revenue += amount;
        };

        salesList.forEach(s => {
            (s.items || []).forEach(i => {
                const cat = i.product && i.product.category;
                addToCategory(cat ? cat.id : null, cat ? cat.name : null, Number(i.quantity || 0), Number(i.total_price || 0));
            });
        });
        returnsList.forEach(r => {
            (r.items || []).forEach(i => {
                const cat = i.product && i.product.category;
                addToCategory(cat ? cat.id : null, cat ? cat.name : null, Number(i.quantity || 0), -Number(i.total_price || 0));
            });
        });

        const categories = Object.values(categoryMap);
        const payload = { report_type, date_range: { start_date, end_date }, summary: overall, categories };
        if (report_type === 'detailed') {
            payload.sales = salesList;
            payload.returns = returnsList;
        }

        if (['x', 'z', 'X', 'Z'].includes(report_type)) {
            const isZ = report_type.toLowerCase() === 'z';
            const grossSales = salesList.reduce((sum, s) => sum + Number(s.subtotal || 0), 0);
            const discounts = salesList.reduce((sum, s) => sum + Number(s.discount_amount || 0), 0);
            const tax = salesList.reduce((sum, s) => sum + Number(s.tax_amount || 0), 0);
            const salesTotalAmount = salesList.reduce((sum, s) => sum + Number(s.total_amount || 0), 0);
            const returnsTotalAmount = returnsList.reduce((sum, r) => sum + Number(r.total_amount || 0), 0);
            const returnsTax = returnsList.reduce((sum, r) => sum + Number(r.tax_amount || 0), 0);
            const returnsDiscount = returnsList.reduce((sum, r) => sum + Number(r.discount_amount || 0), 0);

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

            const storeInfo = await resolveStoreInfo(filterStoreId);
            const cashiers = buildCashierPerformance(salesList, returnsList);

            const traditional = {
                report_name: isZ ? 'Z Report' : 'X Report',
                period: { start: start_date, end: end_date },
                store_id: req.user && req.user.store_id ? req.user.store_id : null,
                store: storeInfo || undefined,
                cashier: req.user && req.user.full_name ? { id: req.user.id, name: req.user.full_name } : undefined,
                cashiers,
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



// ==================== PROFESSIONAL EXCEL EXPORT ====================

// Professional Excel export for all report types
router.get('/:reportType/export', auth, async (req, res) => {
    try {
        const { reportType } = req.params;
        const { format, start_date, end_date, ...additionalParams } = req.query;

        if (!format || format.toLowerCase() !== 'xlsx') {
            return res.status(400).json({ message: 'Invalid format. Use xlsx' });
        }

        if (!start_date || !end_date) {
            return res.status(400).json({ message: 'start_date and end_date are required' });
        }

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);
        const filterStoreId = req.user?.store_id;

        let reportData = [];
        let reportTitle = '';
        let columns = [];

        // Generate data based on report type
        switch (reportType) {
            case 'sales':
                reportTitle = 'SALES REPORT';
                columns = [
                    { header: 'Receipt #', key: 'receipt_number', width: 18 },
                    { header: 'Date & Time', key: 'date', width: 20 },
                    { header: 'Cashier', key: 'cashier', width: 25 },
                    { header: 'Customer', key: 'customer_name', width: 25 },
                    { header: 'Items', key: 'items_count', width: 10 },
                    { header: 'Subtotal (ZMW)', key: 'subtotal', width: 15 },
                    { header: 'Tax (ZMW)', key: 'tax', width: 15 },
                    { header: 'Discount (ZMW)', key: 'discount', width: 15 },
                    { header: 'Total (ZMW)', key: 'total', width: 15 },
                    { header: 'Payment Method', key: 'payment_method', width: 18 }
                ];
                
                const sales = await sale.findAll({
                    where: { sale_date: { [Op.between]: [startDate, endDate] } },
                    include: [
                        { model: user, as: 'cashier', attributes: ['id', 'full_name'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
                        { model: customer, as: 'customer' },
                        { model: saleitem, as: 'items', include: [{ model: product, as: 'product' }] }
                    ]
                });
                sortRows(sales, [['sale_date', 'DESC']]);
                const activeSales = (await getActiveSalesRows(sales)).active;
                
                reportData = activeSales.map(s => ({
                    receipt_number: s.receipt_number || s.invoice_no || 'N/A',
                    date: formatDate(s.sale_date),
                    cashier: s.cashier?.full_name || 'Unknown',
                    customer_name: s.customer?.name || 'Walk-in',
                    items_count: s.items?.length || 0,
                    subtotal: Number(s.subtotal || 0),
                    tax: Number(s.tax_amount || 0),
                    discount: Number(s.discount_amount || 0),
                    total: Number(s.total_amount || 0),
                    payment_method: (s.payment_method || 'cash').toUpperCase()
                }));
                break;

            case 'products':
                reportTitle = 'PRODUCT PERFORMANCE REPORT';
                columns = [
                    { header: 'Product ID', key: 'product_id', width: 12 },
                    { header: 'Product Name', key: 'product_name', width: 35 },
                    { header: 'Classification Code', key: 'product_class_code', width: 18 },
                    { header: 'Category', key: 'category_name', width: 20 },
                    { header: 'Unit Price (ZMW)', key: 'unit_price', width: 15 },
                    { header: 'Quantity Sold', key: 'total_quantity', width: 15 },
                    { header: 'Total Revenue (ZMW)', key: 'total_revenue', width: 18 }
                ];
                
                const productSalesRows = await saleitem.findAll({
                    where: { '$sale.sale_date$': { [Op.between]: [startDate, endDate] } },
                    include: [
                        { model: product, as: 'product', include: [{ model: category, as: 'category' }] },
                        { model: sale, as: 'sale' }
                    ]
                });
                const activeProductRows = await getActiveSaleItemRows(productSalesRows);
                const productMap = new Map();
                activeProductRows.forEach(row => {
                    const current = productMap.get(row.product_id) || {
                        product_id: row.product_id,
                        product_name: row.product?.name || 'Unknown Product',
                        product_class_code: row.product?.product_class_code || '',
                        category_name: row.product?.category?.name || 'Uncategorized',
                        total_quantity: 0,
                        total_revenue: 0,
                        unit_price: row.product?.price || 0
                    };
                    current.total_quantity += Number(row.quantity || 0);
                    current.total_revenue += Number(row.total_price || 0);
                    productMap.set(row.product_id, current);
                });
                reportData = [...productMap.values()].sort((a, b) => b.total_revenue - a.total_revenue);
                break;

            case 'inventory':
                reportTitle = 'INVENTORY REPORT';
                columns = [
                    { header: 'Product ID', key: 'product_id', width: 12 },
                    { header: 'Product Name', key: 'product_name', width: 35 },
                    { header: 'Classification Code', key: 'product_class_code', width: 18 },
                    { header: 'Category', key: 'category_name', width: 20 },
                    { header: 'Unit Price (ZMW)', key: 'unit_price', width: 15 },
                    { header: 'Cost (ZMW)', key: 'cost', width: 15 },
                    { header: 'Stock Quantity', key: 'stock_quantity', width: 15 },
                    { header: 'Min Stock Level', key: 'min_stock_level', width: 15 },
                    { header: 'Total Value (ZMW)', key: 'total_value', width: 18 },
                    { header: 'Status', key: 'stock_status', width: 15 }
                ];
                
                const store_id = req.user.store_id;
                const inventories = await productinventory.findAll({
                    where: { store_id },
                    include: [{ model: product, as: 'product', include: [{ model: category, as: 'category' }] }]
                });
                sortRows(inventories, [['stock_quantity', 'ASC']]);
                reportData = inventories.map(inv => ({
                    product_id: inv.product_id,
                    product_name: inv.product?.name || 'Unknown',
                    product_class_code: inv.product?.product_class_code || '',
                    category_name: inv.product?.category?.name || 'Uncategorized',
                    unit_price: Number(inv.product?.price || 0),
                    cost: Number(inv.product?.cost || 0),
                    stock_quantity: inv.stock_quantity,
                    min_stock_level: inv.min_stock_level,
                    total_value: Number(inv.product?.cost || 0) * inv.stock_quantity,
                    stock_status: inv.stock_quantity <= inv.min_stock_level ? 'Low Stock' : (inv.stock_quantity === 0 ? 'Out of Stock' : 'In Stock')
                }));
                break;

            case 'user-activity':
                reportTitle = 'USER ACTIVITY REPORT';
                columns = [
                    { header: 'User ID', key: 'user_id', width: 12 },
                    { header: 'Full Name', key: 'full_name', width: 30 },
                    { header: 'Email', key: 'email', width: 30 },
                    { header: 'Role', key: 'role', width: 15 },
                    { header: 'Transactions', key: 'total_sales', width: 15 },
                    { header: 'Total Revenue (ZMW)', key: 'total_revenue', width: 18 }
                ];
                
                const userSales = await sale.findAll({
                    where: { sale_date: { [Op.between]: [startDate, endDate] } },
                    include: [{ model: user, as: 'cashier', attributes: ['id', 'full_name', 'email', 'role'] }]
                });
                const activeUserSales = (await getActiveSalesRows(userSales)).active;
                const userMap = new Map();
                activeUserSales.forEach(s => {
                    const current = userMap.get(s.user_id) || {
                        user_id: s.user_id,
                        full_name: s.cashier?.full_name || 'Unknown',
                        email: s.cashier?.email || '',
                        role: s.cashier?.role || 'cashier',
                        total_sales: 0,
                        total_revenue: 0
                    };
                    current.total_sales += 1;
                    current.total_revenue += Number(s.total_amount || 0);
                    userMap.set(s.user_id, current);
                });
                reportData = [...userMap.values()].sort((a, b) => b.total_revenue - a.total_revenue);
                break;

            case 'categories':
                reportTitle = 'CATEGORY PERFORMANCE REPORT';
                columns = [
                    { header: 'Category ID', key: 'category_id', width: 15 },
                    { header: 'Category Name', key: 'category_name', width: 30 },
                    { header: 'Items Sold', key: 'total_quantity', width: 15 },
                    { header: 'Total Revenue (ZMW)', key: 'total_revenue', width: 18 }
                ];
                
                const catSalesRows = await saleitem.findAll({
                    where: { '$sale.sale_date$': { [Op.between]: [startDate, endDate] } },
                    include: [
                        { model: product, as: 'product', include: [{ model: category, as: 'category' }] },
                        { model: sale, as: 'sale' }
                    ]
                });
                const activeCatRows = await getActiveSaleItemRows(catSalesRows);
                const catMap = new Map();
                activeCatRows.forEach(row => {
                    const cat = row.product?.category;
                    const key = cat?.id || 'uncategorized';
                    const current = catMap.get(key) || {
                        category_id: cat?.id || null,
                        category_name: cat?.name || 'Uncategorized',
                        total_quantity: 0,
                        total_revenue: 0
                    };
                    current.total_quantity += Number(row.quantity || 0);
                    current.total_revenue += Number(row.total_price || 0);
                    catMap.set(key, current);
                });
                reportData = [...catMap.values()].sort((a, b) => b.total_revenue - a.total_revenue);
                break;

            case 'tax':
                reportTitle = 'TAX REPORT';
                columns = [
                    { header: 'Date', key: 'date', width: 15 },
                    { header: 'Transactions', key: 'transactions', width: 15 },
                    { header: 'Gross Sales (ZMW)', key: 'gross_sales', width: 18 },
                    { header: 'Tax Amount (ZMW)', key: 'tax_amount', width: 18 },
                    { header: 'Net Sales (ZMW)', key: 'net_sales', width: 18 }
                ];
                
                const taxSales = await sale.findAll({
                    where: { sale_date: { [Op.between]: [startDate, endDate] } }
                });
                const activeTaxSales = (await getActiveSalesRows(taxSales)).active;
                const dailyTaxMap = new Map();
                activeTaxSales.forEach(s => {
                    const dateKey = s.sale_date.toISOString().slice(0, 10);
                    const current = dailyTaxMap.get(dateKey) || {
                        date: dateKey,
                        transactions: 0,
                        gross_sales: 0,
                        tax_amount: 0,
                        net_sales: 0
                    };
                    current.transactions += 1;
                    current.gross_sales += Number(s.total_amount || 0);
                    current.tax_amount += Number(s.tax_amount || 0);
                    current.net_sales += Number(s.total_amount || 0) - Number(s.tax_amount || 0);
                    dailyTaxMap.set(dateKey, current);
                });
                reportData = [...dailyTaxMap.values()].sort((a, b) => a.date.localeCompare(b.date));
                break;

            case 'returns':
                reportTitle = 'RETURNS REPORT';
                columns = [
                    { header: 'Credit Note #', key: 'credit_note_number', width: 18 },
                    { header: 'Date', key: 'date', width: 20 },
                    { header: 'Cashier', key: 'cashier', width: 25 },
                    { header: 'Customer', key: 'customer', width: 25 },
                    { header: 'Items', key: 'items_count', width: 10 },
                    { header: 'Subtotal (ZMW)', key: 'subtotal', width: 15 },
                    { header: 'Tax (ZMW)', key: 'tax', width: 15 },
                    { header: 'Total (ZMW)', key: 'total', width: 15 },
                    { header: 'Reason', key: 'reason', width: 30 }
                ];
                
                const returnsList = await creditnote.findAll({
                    where: { credit_note_date: { [Op.between]: [startDate, endDate] } },
                    include: [
                        { model: user, as: 'cashier', attributes: ['id', 'full_name'] },
                        { model: customer, as: 'customer' },
                        { model: creditnoteitem, as: 'items', include: [{ model: product, as: 'product' }] }
                    ]
                });
                reportData = returnsList.map(r => ({
                    credit_note_number: r.credit_note_number || 'N/A',
                    date: formatDate(r.credit_note_date),
                    cashier: r.cashier?.full_name || 'Unknown',
                    customer: r.customer?.name || 'Walk-in',
                    items_count: r.items?.length || 0,
                    subtotal: Number(r.subtotal || 0),
                    tax: Number(r.tax_amount || 0),
                    total: Number(r.total_amount || 0),
                    reason: r.reason || 'N/A'
                }));
                break;

            default:
                return res.status(400).json({ message: `Unknown report type: ${reportType}` });
        }

        if (!reportData || reportData.length === 0) {
            return res.status(404).json({ message: 'No data found for the specified date range' });
        }

        // Create workbook
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet(reportTitle.substring(0, 31)); // Excel sheet name max 31 chars

        // ===== ADD HEADERS PROPERLY =====
        
        // Add title row
        worksheet.mergeCells(`A1:${String.fromCharCode(64 + columns.length)}1`);
        const titleCell = worksheet.getCell('A1');
        titleCell.value = reportTitle;
        titleCell.font = { bold: true, size: 14, name: 'Calibri' };
        titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
        worksheet.getRow(1).height = 25;

        // Add date range row
        worksheet.mergeCells(`A2:${String.fromCharCode(64 + columns.length)}2`);
        const dateCell = worksheet.getCell('A2');
        dateCell.value = `Period: ${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`;
        dateCell.font = { size: 11, name: 'Calibri', italic: true };
        dateCell.alignment = { horizontal: 'center', vertical: 'middle' };
        worksheet.getRow(2).height = 20;

        // Add generation date row
        worksheet.mergeCells(`A3:${String.fromCharCode(64 + columns.length)}3`);
        const genCell = worksheet.getCell('A3');
        genCell.value = `Generated: ${new Date().toLocaleString()}`;
        genCell.font = { size: 10, name: 'Calibri', italic: true };
        genCell.alignment = { horizontal: 'center', vertical: 'middle' };
        worksheet.getRow(3).height = 20;

        // Add empty row for spacing
        worksheet.addRow([]);

        // ===== ADD COLUMN HEADERS (ROW 5) =====
        const headerRow = worksheet.addRow(columns.map(c => c.header));
        headerRow.height = 25;
        
        // Style the header row
        const headerStyle = {
            font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' },
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E75B6' } },
            alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
            border: {
                top: { style: 'thin', color: { argb: 'FFD3D3D3' } },
                left: { style: 'thin', color: { argb: 'FFD3D3D3' } },
                bottom: { style: 'thin', color: { argb: 'FFD3D3D3' } },
                right: { style: 'thin', color: { argb: 'FFD3D3D3' } }
            }
        };
        
        headerRow.eachCell(cell => {
            cell.style = headerStyle;
        });

        // Set column widths
        columns.forEach((col, idx) => {
            const colLetter = String.fromCharCode(65 + idx);
            worksheet.getColumn(colLetter).width = col.width;
        });

        // ===== ADD DATA ROWS =====
        const dataStartRow = worksheet.rowCount + 1;
        
        reportData.forEach(item => {
            const row = worksheet.addRow(columns.map(col => item[col.key] !== undefined ? item[col.key] : ''));
            
            // Format currency columns
            columns.forEach((col, idx) => {
                const cell = row.getCell(idx + 1);
                if (col.key.includes('price') || col.key.includes('revenue') || 
                    col.key.includes('total') || col.key.includes('subtotal') || 
                    col.key.includes('tax') || col.key.includes('amount') || 
                    col.key.includes('cost') || col.key.includes('value')) {
                    cell.numFmt = '#,##0.00';
                    cell.alignment = { horizontal: 'right' };
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

        // ===== ADD TOTAL ROW =====
        worksheet.addRow([]);
        const totalRow = worksheet.addRow({});
        
        // Calculate totals for numeric columns
        const numericColumns = ['subtotal', 'tax', 'discount', 'total', 'total_revenue', 'total_quantity', 'stock_quantity', 'total_value', 'gross_sales', 'tax_amount', 'net_sales'];
        
        columns.forEach((col, idx) => {
            if (numericColumns.includes(col.key) || col.key.includes('price') || col.key.includes('revenue') || col.key.includes('amount')) {
                const total = reportData.reduce((sum, item) => sum + (Number(item[col.key]) || 0), 0);
                if (total > 0) {
                    const cell = totalRow.getCell(idx + 1);
                    cell.value = total;
                    cell.numFmt = '#,##0.00';
                    cell.font = { bold: true };
                }
            }
        });
        
        // Add "TOTAL" label in first column
        if (columns.length > 0) {
            totalRow.getCell(1).value = 'TOTAL';
            totalRow.getCell(1).font = { bold: true };
        }
        
        // Style total row
        const totalRowStyle = {
            font: { bold: true, size: 11, name: 'Calibri' },
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F0FA' } },
            border: {
                top: { style: 'thin', color: { argb: 'FFD3D3D3' } },
                bottom: { style: 'double', color: { argb: 'FF2E75B6' } }
            }
        };
        
        if (totalRow.values) {
            Object.keys(totalRow.values).forEach(key => {
                if (!isNaN(parseInt(key))) {
                    totalRow.getCell(parseInt(key)).style = totalRowStyle;
                }
            });
        }

        // Freeze header row (row 5 is the header)
        worksheet.views = [{ state: 'frozen', ySplit: 5 }];
        
        // Add auto-filter
        worksheet.autoFilter = {
            from: `A${dataStartRow}`,
            to: `${String.fromCharCode(64 + columns.length)}${worksheet.rowCount - 1}`
        };

        // Generate file
        const buffer = await workbook.xlsx.writeBuffer();
        const fileName = `${reportType}_report_${start_date}_to_${end_date}.xlsx`;
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Cache-Control', 'no-cache');
        res.send(Buffer.from(buffer));

    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({ message: 'Server error generating export', error: error.message });
    }
});
// ==================== EMAIL REPORT ====================

const createEmailTransporter = () => {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: process.env.SMTP_PORT || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
};

router.post('/:reportType/email', auth, async (req, res) => {
    let tempFilePath = null;
    try {
        const { reportType } = req.params;
        const { format, start_date, end_date, email, ...additionalParams } = req.body;

        if (!start_date || !end_date || !email) {
            return res.status(400).json({ message: 'start_date, end_date, and email are required', success: false });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ message: 'Invalid email format', success: false });
        }

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);
        const filterStoreId = req.user?.store_id;

        const sales = await sale.findAll({
            where: { sale_date: { [Op.between]: [startDate, endDate] } },
            include: [
                { model: user, as: 'cashier', attributes: ['id', 'full_name'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
                { model: saleitem, as: 'items', include: [{ model: product, as: 'product' }] }
            ]
        });

        const activeSales = (await getActiveSalesRows(sales)).active;

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Report');

        worksheet.mergeCells('A1:H1');
        worksheet.getCell('A1').value = `${reportType.toUpperCase()} REPORT`;
        worksheet.getCell('A1').font = { bold: true, size: 14 };
        
        worksheet.mergeCells('A2:H2');
        worksheet.getCell('A2').value = `Period: ${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`;

        worksheet.addRow([]);
        worksheet.addRow(['Receipt #', 'Date', 'Cashier', 'Items', 'Subtotal', 'Tax', 'Discount', 'Total']);
        worksheet.getRow(4).font = { bold: true };

        activeSales.forEach(sale => {
            worksheet.addRow([
                sale.receipt_number || 'N/A',
                formatDate(sale.sale_date),
                sale.cashier?.full_name || 'Unknown',
                sale.items?.length || 0,
                Number(sale.subtotal || 0),
                Number(sale.tax_amount || 0),
                Number(sale.discount_amount || 0),
                Number(sale.total_amount || 0)
            ]);
        });

        worksheet.addRow([]);
        worksheet.addRow(['TOTAL', '', '', '', 
            activeSales.reduce((s, x) => s + Number(x.subtotal || 0), 0),
            activeSales.reduce((s, x) => s + Number(x.tax_amount || 0), 0),
            activeSales.reduce((s, x) => s + Number(x.discount_amount || 0), 0),
            activeSales.reduce((s, x) => s + Number(x.total_amount || 0), 0)
        ]);
        worksheet.getRow(worksheet.rowCount).font = { bold: true };

        const tempDir = path.join(__dirname, '../temp');
        await fs.mkdir(tempDir, { recursive: true });
        const fileName = `${reportType}_report_${Date.now()}.xlsx`;
        tempFilePath = path.join(tempDir, fileName);
        await workbook.xlsx.writeFile(tempFilePath);

        const transporter = createEmailTransporter();
        const mailOptions = {
            from: `"${process.env.COMPANY_NAME || 'DAPP POS'}" <${process.env.SMTP_USER}>`,
            to: email,
            subject: `${reportType.toUpperCase()} Report - ${new Date(startDate).toLocaleDateString()} to ${new Date(endDate).toLocaleDateString()}`,
            html: `<div><h2>Your ${reportType.toUpperCase()} Report is Ready</h2><p>Period: ${new Date(startDate).toLocaleDateString()} - ${new Date(endDate).toLocaleDateString()}</p><p>Records: ${activeSales.length}</p></div>`,
            attachments: [{ filename: fileName, path: tempFilePath }]
        };

        await transporter.sendMail(mailOptions);
        await fs.unlink(tempFilePath);
        tempFilePath = null;

        res.status(200).json({ success: true, message: `${reportType} report sent to ${email}` });
    } catch (error) {
        console.error('Email report error:', error);
        if (tempFilePath) await fs.unlink(tempFilePath).catch(() => {});
        res.status(500).json({ message: 'Server error while sending report email', success: false });
    }
});

module.exports = router;