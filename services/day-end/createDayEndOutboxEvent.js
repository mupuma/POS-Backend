const { Op } = require('sequelize');

function buildUtcDayWindow(dateString) {
  const baseDate = new Date(dateString);
  const startOfDay = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 0, 0, 0, 0);
  const endOfDay = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 23, 59, 59, 999);
  return { startOfDay, endOfDay };
}

function buildDayEndAggregateId(dateString) {
  return Number(String(dateString).replace(/-/g, ''));
}

function resolveBranchTerminalId() {
  return String(process.env[`ZRA_BHF_ID_${'Terminal A'}`] || '000').trim() || '000';
}

async function buildDayEndPayload(models, storeId, dateString) {
  const { sale, saleitem, product, user, customer, discount, store } = models;
  const { startOfDay, endOfDay } = buildUtcDayWindow(dateString);
  const branchId = resolveBranchTerminalId();

  const salesForDay = await sale.findAll({
    where: { createdAt: { [Op.between]: [startOfDay, endOfDay] } },
    include: [
      { model: saleitem, as: 'items', include: [{ model: product }] },
      { model: user, as: 'cashier', where: { store_id: storeId }, required: true, include: [{ model: store }] },
      { model: customer, as: 'customer' },
      { model: discount, as: 'discount' },
    ],
    order: [['id', 'ASC']]
  });

  return {
    date: dateString,
    store_id: storeId,
    branch_id: branchId,
    terminal_id: branchId,
    sales_count: salesForDay.length,
    sales: salesForDay.map((saleRow) => ({
      id: saleRow.id,
      receipt_number: saleRow.receipt_number,
      subtotal: Number(saleRow.subtotal),
      discount_amount: Number(saleRow.discount_amount || 0),
      tax_amount: Number(saleRow.tax_amount || 0),
      total_amount: Number(saleRow.total_amount),
      payment_method: saleRow.payment_method,
      amount_paid: Number(saleRow.amount_paid),
      change_amount: Number(saleRow.change_amount || 0),
      notes: saleRow.notes,
      customer: saleRow.customer || null,
      discount: saleRow.discount || null,
      cashier: saleRow.cashier ? {
        id: saleRow.cashier.id,
        full_name: saleRow.cashier.full_name,
        store_id: saleRow.cashier.store_id,
        store: saleRow.cashier.store || null,
      } : null,
      items: (saleRow.items || []).map((item) => ({
        product_id: item.product_id,
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
        total_price: Number(item.total_price),
        product: item.product || null,
        product_code: item.product?.product_code || null,
      }))
    }))
  };
}

async function createDayEndOutboxEvent(models, { storeId, userId = null, dateString }) {
  const payload = await buildDayEndPayload(models, storeId, dateString);

  if (payload.sales_count === 0) {
    return { success: true, queued: false, payload };
  }

  const branchId = payload.branch_id || payload.terminal_id || resolveBranchTerminalId();
  const eventDefinitions = [
    { event_type: 'day_end.ready', aggregate_type: 'day_end' },
    { event_type: 'shipment.ready', aggregate_type: 'shipment_batch' },
    { event_type: 'ar_batch.ready', aggregate_type: 'ar_batch' },
  ];

  const events = [];

  for (const definition of eventDefinitions) {
    const idempotencyKey = `${definition.event_type}:store-${storeId}:branch-${branchId}:date-${dateString}`;
    const [row, created] = await models.sync_outbox.findOrCreate({
      where: { idempotency_key: idempotencyKey },
      defaults: {
        event_type: definition.event_type,
        aggregate_type: definition.aggregate_type,
        aggregate_id: buildDayEndAggregateId(dateString),
        store_id: storeId,
        user_id: userId,
        receipt_number: null,
        idempotency_key: idempotencyKey,
        payload,
        status: 'pending',
        attempt_count: 0,
        next_retry_at: new Date(),
      }
    });

    if (!created) {
      await row.update({
        payload,
        user_id: userId,
        last_error: null,
        next_retry_at: row.status === 'sent' ? row.next_retry_at : new Date(),
        status: row.status === 'sent' ? 'sent' : 'pending',
      });
    }

    events.push({
      eventType: definition.event_type,
      outboxId: row.id,
      idempotencyKey,
      created,
    });
  }

  return {
    success: true,
    queued: true,
    created: events.some((event) => event.created),
    outboxId: events[0]?.outboxId || null,
    idempotencyKey: events[0]?.idempotencyKey || null,
    events,
    payload,
  };
}

module.exports = {
  buildDayEndPayload,
  createDayEndOutboxEvent,
};
