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

function resolveBranchId() {
  return String(process.env.ZRA_BHF_ID || '000').trim() || '000';
}

function resolveTerminalId() {
  return String(process.env.TERMINAL_ID || process.env.ZRA_TERMINAL_ID || '000').trim() || '000';
}

async function buildDayEndPayload(models, storeId, dateString) {
  const { sale, saleitem, creditnote, creditnoteitem, product, user, customer, discount, store } = models;
  const { startOfDay, endOfDay } = buildUtcDayWindow(dateString);
  const branchId = resolveBranchId();
  const terminalId = resolveTerminalId();

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

  const creditNotesForDay = await creditnote.findAll({
    where: { createdAt: { [Op.between]: [startOfDay, endOfDay] } },
    include: [
      { model: creditnoteitem, as: 'items', include: [{ model: product }] },
      { model: user, as: 'cashier', where: { store_id: storeId }, required: true, include: [{ model: store }] },
      { model: customer, as: 'customer' },
    ],
    order: [['id', 'ASC']]
  });

  return {
    date: dateString,
    store_id: storeId,
    branch_id: branchId,
    terminal_id: terminalId,
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
    })),
    credit_notes_count: creditNotesForDay.length,
    credit_notes_total_amount: creditNotesForDay.reduce((sum, creditNoteRow) => sum + Number(creditNoteRow.total_amount || 0), 0),
    credit_notes: creditNotesForDay.map((creditNoteRow) => ({
      id: creditNoteRow.id,
      receipt_number: creditNoteRow.receipt_number,
      original_sale_id: creditNoteRow.original_sale_id,
      subtotal: Number(creditNoteRow.subtotal || 0),
      discount_amount: Number(creditNoteRow.discount_amount || 0),
      tax_amount: Number(creditNoteRow.tax_amount || 0),
      total_amount: Number(creditNoteRow.total_amount || 0),
      payment_method: creditNoteRow.payment_method,
      amount_paid: Number(creditNoteRow.amount_paid || 0),
      change_amount: Number(creditNoteRow.change_amount || 0),
      credit_note_date: creditNoteRow.credit_note_date,
      notes: creditNoteRow.notes,
      reason: creditNoteRow.reason || null,
      customer: creditNoteRow.customer || null,
      cashier: creditNoteRow.cashier ? {
        id: creditNoteRow.cashier.id,
        full_name: creditNoteRow.cashier.full_name,
        store_id: creditNoteRow.cashier.store_id,
        store: creditNoteRow.cashier.store || null,
      } : null,
      items: (creditNoteRow.items || []).map((item) => ({
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

  const branchId = payload.branch_id || resolveBranchId();
  const idempotencyKey = `day_end.ready:store-${storeId}:branch-${branchId}:date-${dateString}`;
  const [row, created] = await models.sync_outbox.findOrCreate({
    where: { idempotency_key: idempotencyKey },
    defaults: {
      event_type: 'day_end.ready',
      aggregate_type: 'day_end',
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

  const events = [{
    eventType: 'day_end.ready',
    outboxId: row.id,
    idempotencyKey,
    created,
  }];

  return {
    success: true,
    queued: true,
    created,
    outboxId: row.id,
    idempotencyKey,
    events,
    payload,
  };
}

module.exports = {
  buildDayEndPayload,
  createDayEndOutboxEvent,
};
