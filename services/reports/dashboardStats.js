const { Op } = require('sequelize');
const { sale, saleitem, product, user, customer, productinventory, category, creditnote, creditnoteitem, sequelize } = require('../../models');
const { annotateSalesWithReturnState } = require('../sales/returnState');

// Compute unified dashboard stats for a given request/user context
async function computeDashboardStats(req) {
  // Helper: aggregate sales by payment method, honoring payments_breakdown when present
  function aggregateByPayment(sales) {
    const breakdown = {};
    for (const s of sales) {
      const totalAmount = parseFloat(s.total_amount || 0) || 0;
      const receiptNumber = s.receipt_number || (s.id != null ? String(s.id) : '-');
      const time = s.sale_date?.toISOString?.() || '';

      const addReceipt = (method, amt) => {
        const key = method || 'unknown';
        if (!breakdown[key]) {
          breakdown[key] = { total: 0, receipts: [] };
        }
        breakdown[key].total += Number(amt || 0);
        breakdown[key].receipts.push({
          receipt_number: receiptNumber,
          time,
          amount: Number(amt || 0),
        });
      };

      const bd = s.payments_breakdown;
      if (bd && typeof bd === 'object') {
        const sum = Object.values(bd).reduce((acc, v) => acc + Number(v || 0), 0);
        if (sum > 0) {
          for (const [method, amt] of Object.entries(bd)) {
            addReceipt(method, amt);
          }
          continue;
        }
      }
      addReceipt(s.payment_method || 'unknown', totalAmount);
    }
    return breakdown;
  }
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000 - 1);

  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfToday.getDate() - startOfToday.getDay());

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

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
  const todaysSales = await sale.findAll({
    where: { sale_date: { [Op.between]: [startOfToday, endOfToday] } },
    include: salesInclude,
    order: [['sale_date', 'DESC']],
    limit: 10
  });

  // Week
  const weekSales = await sale.findAll({
    where: { sale_date: { [Op.between]: [startOfWeek, endOfToday] } },
    include: salesInclude
  });

  // Month
  const monthSales = await sale.findAll({
    where: { sale_date: { [Op.between]: [startOfMonth, endOfToday] } },
    include: salesInclude
  });

  const [todayAnnotated, weekAnnotated, monthAnnotated] = await Promise.all([
    annotateSalesWithReturnState(todaysSales),
    annotateSalesWithReturnState(weekSales),
    annotateSalesWithReturnState(monthSales),
  ]);

  const activeTodaysSales = todayAnnotated.filter(s => !s.is_fully_returned);
  const activeWeekSales = weekAnnotated.filter(s => !s.is_fully_returned);
  const activeMonthSales = monthAnnotated.filter(s => !s.is_fully_returned);

  const monthSalesWithItems = await sale.findAll({
    where: { sale_date: { [Op.between]: [startOfMonth, endOfToday] } },
    include: [
      ...salesInclude,
      {
        model: saleitem,
        as: 'items',
        include: [{
          model: product,
          as: 'product',
          attributes: ['id', 'name']
        }]
      }
    ]
  });
  const monthItemsAnnotated = await annotateSalesWithReturnState(monthSalesWithItems);
  const activeMonthSalesWithItems = monthItemsAnnotated.filter(s => !s.is_fully_returned);

  const todaysSalesTotal = activeTodaysSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);
  const todaysTransactions = activeTodaysSales.length;
  const weekSalesTotal = activeWeekSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);
  const monthSalesTotal = activeMonthSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);

  // Sales by payment type
  const todaysSalesByPayment = aggregateByPayment(activeTodaysSales);
  const weekSalesByPayment = aggregateByPayment(activeWeekSales);
  const monthSalesByPayment = aggregateByPayment(activeMonthSales);

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

  // Top products from active month sales only
  const topProductMap = new Map();
  for (const saleRow of activeMonthSalesWithItems) {
    for (const item of saleRow.items || []) {
      const productId = item.product_id;
      const productName = item.product?.name || '';
      const current = topProductMap.get(productId) || {
        product_id: productId,
        product_name: productName,
        total_quantity: 0,
        total_sales: 0,
      };
      current.product_name = current.product_name || productName;
      current.total_quantity += Number(item.quantity || 0);
      current.total_sales += Number(item.total_price || 0);
      topProductMap.set(productId, current);
    }
  }
  const topProducts = [...topProductMap.values()]
    .sort((a, b) => b.total_quantity - a.total_quantity)
    .slice(0, 5);

  // Recent sales (last 10)
  const recentSalesData = await sale.findAll({
    where: { sale_date: { [Op.between]: [startOfToday, endOfToday] } },
    include: [
      ...salesInclude,
      { model: customer, as: 'customer' }
    ],
    order: [['sale_date', 'DESC']],
    limit: 10
  });

  const recentSales = activeTodaysSales.slice(0, 10).map(s => ({
    receipt_number: s.receipt_number || s.id?.toString() || '-',
    time: s.sale_date?.toISOString() || '',
    timestamp: s.sale_date?.toISOString() || '',
    date: s.sale_date?.toISOString() || '',
    total: parseFloat(s.total_amount || 0),
    amount: parseFloat(s.total_amount || 0),
    grand_total: parseFloat(s.total_amount || 0),
    items_count: Array.isArray(s.items) ? s.items.length : (s.items_count || 0),
  }));

  // Recent returns (credit notes)
  const recentReturnsData = await creditnote.findAll({
    where: { createdAt: { [Op.between]: [startOfToday, endOfToday] } },
    order: [['createdAt', 'DESC']],
    limit: 10,
    include: [
      {
        model: user,
        as: 'cashier',
        attributes: ['id', 'full_name', 'store_id'],
        where: { store_id: filterStoreId },
        required: true
      },
      { model: customer, as: 'customer' }
    ]
  });

  const recentReturns = recentReturnsData.map(creditNote => ({
    receipt_number: creditNote.receipt_number || creditNote.id?.toString() || '-',
    credit_note_number: creditNote.receipt_number,
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
    items_count: creditNote.items ? creditNote.items.length : 0,
    itemsCount: creditNote.items ? creditNote.items.length : 0,
    items: creditNote.items ? creditNote.items.length : 0,
    quantity: creditNote.items ? creditNote.items.reduce((sum, item) => sum + (item.quantity || 0), 0) : 0
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
