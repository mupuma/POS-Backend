const { Op } = require('sequelize');
const { sale, saleitem, product, user, customer, productinventory, category, creditnote, creditnoteitem, sequelize } = require('../../models');

// Compute unified dashboard stats for a given request/user context
async function computeDashboardStats(req) {
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
  const todaysSalesTotal = todaysSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);
  const todaysTransactions = todaysSales.length;

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
      { model: customer, as: 'customer' }
    ],
    order: [['sale_date', 'DESC']],
    limit: 10
  });

  const recentSales = recentSalesData.map(s => ({
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

  const dashboardStats = {
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
    totalReturnsAmount: totalReturnsAmount
  };

  return dashboardStats;
}

module.exports = { computeDashboardStats };
