const { Op } = require('sequelize');
const { sortRows } = require('../query/inMemorySort');

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

  // Full-day payload build: load all rows for the day then sort in JS by id, so MySQL
  // never has to filesort the large sale/credit-note TEXT/JSON columns.
  const salesForDay = await sale.findAll({
    where: { createdAt: { [Op.between]: [startOfDay, endOfDay] } },
    include: [
      { model: saleitem, as: 'items', include: [{ model: product }] },
      { model: user, as: 'cashier', where: { store_id: storeId }, required: true, include: [{ model: store }] },
      { model: customer, as: 'customer' },
      { model: discount, as: 'discount' },
    ]
  });
  sortRows(salesForDay, [['id', 'ASC']]);

  const creditNotesForDay = await creditnote.findAll({
    where: { createdAt: { [Op.between]: [startOfDay, endOfDay] } },
    include: [
      { model: creditnoteitem, as: 'items', include: [{ model: product }] },
      { model: user, as: 'cashier', where: { store_id: storeId }, required: true, include: [{ model: store }] },
      { model: customer, as: 'customer' },
    ]
  });
  sortRows(creditNotesForDay, [['id', 'ASC']]);

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
      sale_date: saleRow.sale_date || saleRow.createdAt || null,
      invoice_no: saleRow.invoice_no || null,
      invnumber: saleRow.invnumber || null,
      receipt_no: saleRow.receipt_no || null,
      sdcid: saleRow.sdcid || null,
      receiptsig: saleRow.receiptsig || null,
      intrldata: saleRow.intrldata || null,
      qrcode_url: saleRow.qrcode_url || null,
      qrfilepath: saleRow.qrfilepath || null,
      vsdcrcpdate: saleRow.vsdcrcpdate || null,
      zra_status: saleRow.zra_status || 'pending',
      zra_error: saleRow.zra_error || null,
      receipt_printed: Boolean(saleRow.receipt_printed),
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

// Builds the daily credit-note batch payload. This mirrors how the day-end sales batch
// is built, but contains ONLY the day's credit notes so they can be posted to Sage as a
// single consolidated OE credit-note document (instead of one document per credit note).
async function buildCreditNoteBatchPayload(models, storeId, dateString) {
  const { creditnote, creditnoteitem, product, user, customer, store } = models;
  const { startOfDay, endOfDay } = buildUtcDayWindow(dateString);
  const branchId = resolveBranchId();
  const terminalId = resolveTerminalId();

  const creditNotesForDay = await creditnote.findAll({
    where: { createdAt: { [Op.between]: [startOfDay, endOfDay] } },
    include: [
      { model: creditnoteitem, as: 'items', include: [{ model: product }] },
      { model: user, as: 'cashier', where: { store_id: storeId }, required: true, include: [{ model: store }] },
      { model: customer, as: 'customer' },
    ]
  });
  sortRows(creditNotesForDay, [['id', 'ASC']]);

  return {
    date: dateString,
    store_id: storeId,
    branch_id: branchId,
    terminal_id: terminalId,
    credit_notes_count: creditNotesForDay.length,
    credit_notes_total_amount: creditNotesForDay.reduce((sum, creditNoteRow) => sum + Number(creditNoteRow.total_amount || 0), 0),
    credit_notes: creditNotesForDay.map((creditNoteRow) => ({
      id: creditNoteRow.id,
      receipt_number: creditNoteRow.receipt_number,
      reference: creditNoteRow.receipt_number,
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
      sdcid: creditNoteRow.sdcid || null,
      invoice_no: creditNoteRow.invoice_no || null,
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

// Queues the daily credit-note batch as a `credit_note_batch.ready` outbox event, exactly
// like the sales `day_end.ready` batch. Idempotent per (store, branch, date).
async function createCreditNoteBatchOutboxEvent(models, { storeId, userId = null, dateString }) {
  const payload = await buildCreditNoteBatchPayload(models, storeId, dateString);

  if (payload.credit_notes_count === 0) {
    return { success: true, queued: false, payload };
  }

  const branchId = payload.branch_id || resolveBranchId();
  const idempotencyKey = `credit_note_batch.ready:store-${storeId}:branch-${branchId}:date-${dateString}`;
  const [row, created] = await models.sync_outbox.findOrCreate({
    where: { idempotency_key: idempotencyKey },
    defaults: {
      event_type: 'credit_note_batch.ready',
      aggregate_type: 'credit_note_batch',
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
    eventType: 'credit_note_batch.ready',
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
  buildCreditNoteBatchPayload,
  createCreditNoteBatchOutboxEvent,
};
