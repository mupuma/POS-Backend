(async ()=>{
  try {
    const { sale, saleitem, product, user, customer, category, sequelize } = require('../models');
    const { Op } = require('sequelize');
    const startDate = new Date('2026-05-01T00:00:00.000Z');
    const endDate = new Date('2026-05-31T23:59:59.999Z');
    console.log('Running test sales export:', startDate, endDate);
    const includeClause = [
      { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'] },
      { model: customer, as: 'customer' },
      { model: saleitem, as: 'items', include: [{ model: product, as: 'product', include: [{ model: category, as: 'category' }] }] }
    ];

    const sales = await sale.findAll({ where: { sale_date: { [Op.between]: [startDate, endDate] } }, include: includeClause, order: [['sale_date','DESC']] });
    console.log('Found sales count =', sales.length);
    process.exit(0);
  } catch (e) {
    console.error('Test script error:', e);
    process.exit(2);
  }
})();
