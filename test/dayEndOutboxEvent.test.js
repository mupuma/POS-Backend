const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const { buildDayEndPayload } = require('../services/day-end/createDayEndOutboxEvent');

test('day-end payload selects sales by sale_date business day before createdAt fallback', async () => {
  const captured = {};
  const saleRows = [{
    id: 26296,
    receipt_number: 'RCP1111-26033',
    subtotal: 70,
    discount_amount: 0,
    tax_amount: 0,
    total_amount: 70,
    payment_method: 'cash',
    amount_paid: 70,
    change_amount: 0,
    sale_date: new Date('2026-07-14T10:00:00.000Z'),
    createdAt: new Date('2026-07-15T05:28:00.000Z'),
    cashier: { id: 1, full_name: 'Cashier', store_id: 1, store: { store_number: '1110S' } },
    items: [],
  }];

  const models = {
    sale: {
      findAll: async (options) => {
        captured.saleWhere = options.where;
        return saleRows;
      },
    },
    creditnote: {
      findAll: async (options) => {
        captured.creditNoteWhere = options.where;
        return [];
      },
    },
    saleitem: {},
    creditnoteitem: {},
    product: {},
    user: {},
    customer: {},
    discount: {},
    store: {},
  };

  const payload = await buildDayEndPayload(models, 1, '2026-07-14');

  assert.equal(payload.date, '2026-07-14');
  assert.equal(payload.sales_count, 1);
  assert.equal(payload.sales[0].receipt_number, 'RCP1111-26033');
  assert.equal(captured.saleWhere[Op.or].length, 2);
  assert.ok(captured.saleWhere[Op.or][0].sale_date);
  assert.equal(captured.saleWhere[Op.or][1].sale_date, null);
  assert.ok(captured.saleWhere[Op.or][1].createdAt);
  assert.equal(captured.creditNoteWhere[Op.or].length, 2);
  assert.ok(captured.creditNoteWhere[Op.or][0].credit_note_date);
});
