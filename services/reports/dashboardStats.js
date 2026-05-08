const { Op } = require('sequelize');
const { sale, saleitem, product, user, customer, productinventory, category, creditnote, creditnoteitem, sequelize } = require('../../models');

// Compute unified dashboard stats for a given request/user context
async function computeDashboardStats(req) {
  // Helper: aggregate sales by payment method, honoring payments_breakdown when present, and subtract returns
  async function aggregateByPayment(sales, startDate, endDate, filterStoreId) {
    const breakdown = {};
    for (const s of sales) {
      const totalAmount = parseFloat(s.total_amount || 0) || 0;
      const changeAmount = parseFloat(s.change_amount || 0) || 0;
      const bd = s.payments_breakdown;
      if (bd && typeof bd === 'object') {
        const sum = Object.values(bd).reduce((acc, v) => acc + Number(v || 0), 0);
        if (sum > 0) {
          for (let [method, amt] of Object.entries(bd)) {
            const key = (method || 'unknown').toLowerCase();
            let finalAmt = Number(amt || 0);
            if (s.payment_method === 'mixed' && key === 'cash' && changeAmount > 0) {
              finalAmt = Math.max(0, finalAmt - changeAmount);
            }
            breakdown[key] = (breakdown[key] || 0) + finalAmt;
          }
          continue;
        }
      }
      const method = (s.payment_method || 'unknown').toLowerCase();
      breakdown[method] = (breakdown[method] || 0) + totalAmount;
    }

    // Subtract returns
    const returnsList = await creditnote.findAll({
      where: { createdAt: { [Op.between]: [startDate, endDate] } },
      include: [{
        model: user,
        as: 'cashier',
        where: { store_id: filterStoreId },
        required: true
      }]
    });

    for (const r of returnsList) {
      const method = (r.payment_method || 'unknown').toLowerCase();
      const amount = parseFloat(r.total_amount || 0);
      breakdown[method] = (breakdown[method] || 0) - amount;
    }

    return breakdown;
  }
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000 - 1);

  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfToday.getDate() - startOfToday.getDay());

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // Previous day
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfToday.getDate() - 1);
  const endOfYesterday = new Date(startOfToday.getTime() - 1);

  // Last week
  const startOfLastWeek = new Date(startOfWeek);
  startOfLastWeek.setDate(startOfWeek.getDate() - 7);
  const endOfLastWeek = new Date(startOfWeek.getTime() - 1);

  // Last month
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(startOfMonth.getTime() - 1);

  const filterStoreId = req.user.store_id;

  const salesInclude = [
    {
      model: user,
      as: 'cashier',
      attributes: ['id', 'full_name', 'store_id'],
      where: { store_id: filterStoreId },
      required: true
    }
  ];

  // Today's sales
  const todaysSalesAll = await sale.findAll({
    where: { sale_date: { [Op.between]: [startOfToday, endOfToday] } },
    include: salesInclude,
    order: [['sale_date', 'DESC']]
  });

  const todaysSalesTotal = todaysSalesAll.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);
  const todaysTransactions = todaysSalesAll.length;

  // Week
  const weekSales = await sale.findAll({
    where: { sale_date: { [Op.between]: [startOfWeek, endOfToday] } },
    include: salesInclude
  });
    const weekSalesTotal = weekSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);

  // Month
  const monthSales = await sale.findAll({
    where: { sale_date: { [Op.between]: [startOfMonth, endOfToday] } },
    include: salesInclude
  });
  const monthSalesTotal = monthSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);

  // Previous periods for percentages
  const yesterdaySales = await sale.findAll({
    where: { sale_date: { [Op.between]: [startOfYesterday, endOfYesterday] } },
    include: salesInclude
  });
  const yesterdaySalesTotal = yesterdaySales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);
  const yesterdayTransactions = yesterdaySales.length;

  const lastWeekSales = await sale.findAll({
    where: { sale_date: { [Op.between]: [startOfLastWeek, endOfLastWeek] } },
    include: salesInclude
  });
  const lastWeekSalesTotal = lastWeekSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);

  const lastMonthSales = await sale.findAll({
    where: { sale_date: { [Op.between]: [startOfLastMonth, endOfLastMonth] } },
    include: salesInclude
  });
  const lastMonthSalesTotal = lastMonthSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);

  // Percentage calculations
  const calculatePercentage = (current, previous) => {
    if (!previous || previous === 0) return current > 0 ? 100 : 0;
    const percentage = ((current - previous) / previous) * 100;
    return Math.min(percentage, 100);
  };

  const todaysSalespercantage = calculatePercentage(todaysSalesTotal, yesterdaySalesTotal);
  const todaysTransactionspercantage = calculatePercentage(todaysTransactions, yesterdayTransactions);
  const weeksalespercentage = calculatePercentage(weekSalesTotal, lastWeekSalesTotal);
  const monthsalespercentage = calculatePercentage(monthSalesTotal, lastMonthSalesTotal);

  // Sales by payment type
  const todaysSalesByPayment = await aggregateByPayment(todaysSalesAll, startOfToday, endOfToday, filterStoreId);
  const weekSalesByPayment = await aggregateByPayment(weekSales, startOfWeek, endOfToday, filterStoreId);
  const monthSalesByPayment = await aggregateByPayment(monthSales, startOfMonth, endOfToday, filterStoreId);

  // Inventory (per store)
  const totalProducts = await productinventory.count({
    where: { store_id: filterStoreId },
    distinct: true,
    col: 'product_id'
  });

  const lowStockProducts = await productinventory.count({
    where: {
      store_id: filterStoreId,
      stock_quantity: { [Op.lte]: sequelize.col('min_stock_level') }
    }
  });

  const outOfStockProducts = await productinventory.count({
    where: { store_id: filterStoreId, stock_quantity: 0 }
  });

  // Customers and users
  const totalCustomers = await customer.count();
  const activeUsers = await user.count({ where: { is_active: true, store_id: filterStoreId } });

  // Top products
  const topProductsRaw = await saleitem.findAll({
    attributes: [
      'product_id',
      [sequelize.fn('SUM', sequelize.col('quantity')), 'total_quantity'],
      [sequelize.fn('SUM', sequelize.col('total_price')), 'total_sales']
    ],
    include: [{ model: product, as: 'product', attributes: ['id', 'name'] }],
    where: {
      createdAt: { [Op.between]: [startOfMonth, endOfToday] }
    },
    group: ['product_id', 'product.id'],
    order: [[sequelize.literal('total_quantity'), 'DESC']],
    limit: 5,
    raw: true,
    nest: true
  });

  const topProducts = topProductsRaw.map(tp => ({
    product_id: tp.product_id,
    product_name: tp.product?.name || '',
    total_quantity: parseFloat(tp.total_quantity || 0),
    total_sales: parseFloat(tp.total_sales || 0)
  }));

  // Recent sales (last 10)
  const recentSalesData = await sale.findAll({
  where: { sale_date: { [Op.between]: [startOfToday, endOfToday] } },
  include: [
    ...salesInclude,
    { model: customer, as: 'customer' },
    { model: saleitem, as: 'items', attributes: ['id', 'quantity'], required: false }
  ],
  order: [['sale_date', 'DESC']],
});

const recentSales = recentSalesData.map(s => ({
  receipt_number: s.receipt_number || s.id?.toString() || '-',
  time: s.sale_date?.toISOString() || '',
  timestamp: s.created_at?.toISOString() || '',
  date: s.sale_date?.toISOString() || '',
  total: parseFloat(s.total_amount || 0),
  amount: parseFloat(s.total_amount || 0),
  grand_total: parseFloat(s.total_amount || 0),
  items_count: Array.isArray(s.items) ? s.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0) : (s.items_count || 0),
}));

  // Recent returns (credit notes)
  const recentReturnsData = await creditnote.findAll({
  where: { createdAt: { [Op.between]: [startOfToday, endOfToday] } },
    order: [['createdAt', 'DESC']],

    include: [
      {
        model: user,
        as: 'cashier',
        attributes: ['id', 'full_name', 'store_id'],
        where: { store_id: filterStoreId },
        required: true
      },
      { model: customer, as: 'customer' },
      { model: creditnoteitem, as: 'items', attributes: ['id', 'quantity'], required: false }
    ]
  });

  const recentReturns = recentReturnsData.map(creditNote => ({
    receipt_number: creditNote.receipt_number || creditNote.id?.toString() || '-',
    credit_note_number: creditNote.invoice_no,
    time: creditNote.createdAt?.toISOString() || '',
    timestamp: creditNote.createdAt?.toISOString() || '',
    created_at: creditNote.createdAt?.toISOString() || '',
    createdAt: creditNote.createdAt?.toISOString() || '',
    date: creditNote.createdAt?.toISOString() || '',
    refund_amount: parseFloat(creditNote.total_amount || 0),
    total_refund: parseFloat(creditNote.total_amount || 0),
    refund: parseFloat(creditNote.total_amount || 0),
    amount: parseFloat(creditNote.total_amount || 0),
    total: parseFloat(creditNote.total_amount || 0),
    grand_total: parseFloat(creditNote.total_amount || 0),
    items_count: Array.isArray(creditNote.items) ? creditNote.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0) : 0,
    itemsCount: Array.isArray(creditNote.items) ? creditNote.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0) : 0,
    items: Array.isArray(creditNote.items) ? creditNote.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0) : 0,
    quantity: Array.isArray(creditNote.items) ? creditNote.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0) : 0
  }));

  // Returns summary
 const returnsStats = await creditnote.findAll({
  attributes: [
    [sequelize.fn('COUNT', sequelize.col('creditnote.id')), 'count'],
    [sequelize.fn('SUM', sequelize.col('creditnote.total_amount')), 'total']
  ],
  where: { createdAt: { [Op.between]: [startOfToday, endOfToday] } },
    include: [{
      model: user,
      as: 'cashier',
      where: { store_id: filterStoreId },
      attributes: [],
      required: true
    }],
    raw: true
  });

  const totalReturnsToday = parseInt(returnsStats[0]?.count || 0);
  const totalReturnsAmount = parseFloat(returnsStats[0]?.total || 0);

  return {
      todaysSales: todaysSalesTotal,
      todaysTransactions: todaysTransactions,
      weekSales: weekSalesTotal,
      monthSales: monthSalesTotal,
      todaysSalespercantage: todaysSalespercantage,
      todaysTransactionspercantage: todaysTransactionspercantage,
      weekSalespercentage: weeksalespercentage,
      monthSalespercentage: monthsalespercentage,
      totalProducts: totalProducts,
      lowStockProducts: lowStockProducts,
      outOfStockProducts: outOfStockProducts,
      totalCustomers: totalCustomers,
      activeUsers: activeUsers,
      topProducts: topProducts,
      recentSales: recentSales,
      recentReturns: recentReturns,
      recentCreditNotes: recentReturns,
      recent_returns: recentReturns,
      totalReturnsToday: totalReturnsToday,
      totalReturnsAmount: totalReturnsAmount,
      salesByPaymentType: {
        today: todaysSalesByPayment,
        week: weekSalesByPayment,
        month: monthSalesByPayment
      }
  };
}

module.exports = { computeDashboardStats };
