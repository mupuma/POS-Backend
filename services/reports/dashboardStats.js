const { QueryTypes } = require('sequelize');
const { sequelize, customer, user } = require('../../models');

const dashboardCache = new Map();
const DEFAULT_CACHE_TTL_MS = 30_000;
const RECEIPT_SAMPLE_LIMIT = 50;

function cacheTtlMs() {
  const configured = Number(process.env.DASHBOARD_CACHE_TTL_MS || DEFAULT_CACHE_TTL_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_CACHE_TTL_MS;
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
}

function periodBounds() {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfToday = new Date(startOfToday.getTime() + 86_400_000 - 1);
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfToday.getDate() - startOfToday.getDay());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  return { startOfToday, endOfToday, startOfWeek, startOfMonth };
}

function query(sql, replacements) {
  return sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
}

async function salesTotal(storeId, startDate, endDate) {
  const rows = await query(`
    SELECT COUNT(*) AS transactions,
           COALESCE(SUM(s.total_amount), 0) AS total
    FROM sales s
    JOIN users u ON u.id = s.user_id
    WHERE u.store_id = :storeId
      AND s.sale_date BETWEEN :startDate AND :endDate
  `, { storeId, startDate, endDate });
  return rows[0] || {};
}

function createPaymentBucket(total = 0, receiptCount = 0) {
  return { total: asNumber(total), receipt_count: asNumber(receiptCount), receipts: [] };
}

function buildPaymentBreakdowns(paymentRows, receiptRows) {
  const result = { today: {}, week: {}, month: {} };
  for (const row of paymentRows) {
    const method = row.payment_method || 'unknown';
    result.today[method] = createPaymentBucket(row.today_total, row.today_count);
    result.week[method] = createPaymentBucket(row.week_total, row.week_count);
    result.month[method] = createPaymentBucket(row.month_total, row.month_count);
  }

  for (const row of receiptRows) {
    const method = row.payment_method || 'unknown';
    const bucket = result.today[method] || (result.today[method] = createPaymentBucket());
    if (bucket.receipts.length < RECEIPT_SAMPLE_LIMIT) {
      bucket.receipts.push({
        receipt_number: row.receipt_number || String(row.id),
        receiptNumber: row.receipt_number || String(row.id),
        time: iso(row.sale_date),
        amount: asNumber(row.total_amount),
      });
    }
  }
  return result;
}

async function computeDashboardStatsUncached(storeId) {
  const { startOfToday, endOfToday, startOfWeek, startOfMonth } = periodBounds();
  const replacements = { storeId, startOfToday, endOfToday, startOfWeek, startOfMonth };

  const [today, week, month, paymentRows, receiptRows, topProducts, recentSaleRows,
    recentReturnRows, inventoryRows, totalCustomers, activeUsers, returnTotalsRows] = await Promise.all([
    salesTotal(storeId, startOfToday, endOfToday),
    salesTotal(storeId, startOfWeek, endOfToday),
    salesTotal(storeId, startOfMonth, endOfToday),
    query(`
      SELECT COALESCE(s.payment_method, 'unknown') AS payment_method,
             COALESCE(SUM(CASE WHEN s.sale_date >= :startOfToday THEN s.total_amount ELSE 0 END), 0) AS today_total,
             SUM(CASE WHEN s.sale_date >= :startOfToday THEN 1 ELSE 0 END) AS today_count,
             COALESCE(SUM(CASE WHEN s.sale_date >= :startOfWeek THEN s.total_amount ELSE 0 END), 0) AS week_total,
             SUM(CASE WHEN s.sale_date >= :startOfWeek THEN 1 ELSE 0 END) AS week_count,
             COALESCE(SUM(s.total_amount), 0) AS month_total,
             COUNT(*) AS month_count
      FROM sales s
      JOIN users u ON u.id = s.user_id
      WHERE u.store_id = :storeId
        AND s.sale_date BETWEEN :startOfMonth AND :endOfToday
      GROUP BY s.payment_method
    `, replacements),
    query(`
      SELECT s.id, s.receipt_number, s.sale_date, s.total_amount, s.payment_method
      FROM sales s
      JOIN users u ON u.id = s.user_id
      WHERE u.store_id = :storeId
        AND s.sale_date BETWEEN :startOfToday AND :endOfToday
      ORDER BY s.sale_date DESC, s.id DESC
      LIMIT ${RECEIPT_SAMPLE_LIMIT}
    `, replacements),
    query(`
      SELECT p.id AS product_id, p.name AS product_name,
             COALESCE(SUM(si.quantity), 0) AS total_quantity,
             COALESCE(SUM(si.total_price), 0) AS total_sales
      FROM sales s
      JOIN users u ON u.id = s.user_id
      JOIN saleitems si ON si.sale_id = s.id
      JOIN products p ON p.id = si.product_id
      WHERE u.store_id = :storeId
        AND s.sale_date BETWEEN :startOfMonth AND :endOfToday
      GROUP BY p.id, p.name
      ORDER BY total_quantity DESC
      LIMIT 5
    `, replacements),
    query(`
      SELECT s.id, s.receipt_number, s.sale_date, s.total_amount, s.payment_method,
             (SELECT COUNT(*) FROM saleitems si WHERE si.sale_id = s.id) AS items_count
      FROM sales s
      JOIN users u ON u.id = s.user_id
      WHERE u.store_id = :storeId
        AND s.sale_date BETWEEN :startOfToday AND :endOfToday
      ORDER BY s.sale_date DESC, s.id DESC
      LIMIT 10
    `, replacements),
    query(`
      SELECT cn.id, cn.receipt_number, cn.created_at, cn.total_amount,
             (SELECT COALESCE(SUM(cni.quantity), 0)
                FROM credit_note_items cni
               WHERE cni.credit_note_id = cn.id) AS item_quantity,
             (SELECT COUNT(*)
                FROM credit_note_items cni
               WHERE cni.credit_note_id = cn.id) AS items_count
      FROM credit_notes cn
      JOIN users u ON u.id = cn.user_id
      WHERE u.store_id = :storeId
        AND cn.created_at BETWEEN :startOfToday AND :endOfToday
      ORDER BY cn.created_at DESC, cn.id DESC
      LIMIT 10
    `, replacements),
    query(`
      SELECT COUNT(DISTINCT pi.product_id) AS total_products,
             COALESCE(SUM(CASE WHEN pi.stock_quantity <= pi.min_stock_level THEN 1 ELSE 0 END), 0) AS low_stock,
             COALESCE(SUM(CASE WHEN pi.stock_quantity <= 0 THEN 1 ELSE 0 END), 0) AS out_of_stock
      FROM productinventories pi
      WHERE pi.store_id = :storeId
    `, replacements),
    customer.count(),
    user.count({ where: { is_active: true, store_id: storeId } }),
    query(`
      SELECT COUNT(*) AS return_count, COALESCE(SUM(cn.total_amount), 0) AS return_total
      FROM credit_notes cn
      JOIN users u ON u.id = cn.user_id
      WHERE u.store_id = :storeId
        AND cn.created_at BETWEEN :startOfToday AND :endOfToday
    `, replacements),
  ]);

  const salesByPaymentType = buildPaymentBreakdowns(paymentRows, receiptRows);
  const recentSales = recentSaleRows.map((row) => ({
    receipt_number: row.receipt_number || String(row.id),
    time: iso(row.sale_date),
    timestamp: iso(row.sale_date),
    date: iso(row.sale_date),
    total: asNumber(row.total_amount),
    amount: asNumber(row.total_amount),
    grand_total: asNumber(row.total_amount),
    payment_method: row.payment_method || null,
    items_count: asNumber(row.items_count),
  }));
  const recentReturns = recentReturnRows.map((row) => ({
    receipt_number: row.receipt_number || String(row.id),
    credit_note_number: row.receipt_number || String(row.id),
    time: iso(row.created_at),
    timestamp: iso(row.created_at),
    created_at: iso(row.created_at),
    date: iso(row.created_at),
    refund_amount: asNumber(row.total_amount),
    amount: asNumber(row.total_amount),
    total: asNumber(row.total_amount),
    items_count: asNumber(row.items_count),
    quantity: asNumber(row.item_quantity),
  }));
  const inventory = inventoryRows[0] || {};
  const returnTotals = returnTotalsRows[0] || {};

  return {
    todaysSales: asNumber(today.total),
    todaysTransactions: asNumber(today.transactions),
    weekSales: asNumber(week.total),
    monthSales: asNumber(month.total),
    totalProducts: asNumber(inventory.total_products),
    lowStockProducts: asNumber(inventory.low_stock),
    outOfStockProducts: asNumber(inventory.out_of_stock),
    totalCustomers: asNumber(totalCustomers),
    activeUsers: asNumber(activeUsers),
    topProducts: topProducts.map((row) => ({
      product_id: row.product_id,
      product_name: row.product_name,
      total_quantity: asNumber(row.total_quantity),
      total_sales: asNumber(row.total_sales),
    })),
    recentSales,
    recentReturns,
    recentCreditNotes: recentReturns,
    recent_returns: recentReturns,
    totalReturnsToday: asNumber(returnTotals.return_count),
    totalReturnsAmount: asNumber(returnTotals.return_total),
    salesByPaymentType,
  };
}

async function computeDashboardStats(req) {
  const storeId = Number(req.user.store_id);
  const now = Date.now();
  const cached = dashboardCache.get(storeId);
  if (cached?.value && cached.expiresAt > now) return cached.value;
  if (cached?.promise) return cached.promise;

  const promise = computeDashboardStatsUncached(storeId)
    .then((value) => {
      dashboardCache.set(storeId, { value, expiresAt: Date.now() + cacheTtlMs() });
      return value;
    })
    .catch((error) => {
      dashboardCache.delete(storeId);
      throw error;
    });
  dashboardCache.set(storeId, { promise, expiresAt: now + cacheTtlMs() });
  return promise;
}

function clearDashboardCache(storeId) {
  if (storeId == null) dashboardCache.clear();
  else dashboardCache.delete(Number(storeId));
}

module.exports = {
  clearDashboardCache,
  computeDashboardStats,
  computeDashboardStatsUncached,
};
