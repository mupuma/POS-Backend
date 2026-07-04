const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSaleReconstructionDetails } = require('../services/sale/saleReconstruction');

test('builds reconstruction details for failed sales', () => {
  const details = buildSaleReconstructionDetails({
    items: [
      { product_id: 10, quantity: 2, unit_price: 25, total_price: 50, product: { name: 'Milk' } },
      { product_id: 11, quantity: 1, unit_price: 10, total_price: 10, product: { name: 'Bread' } },
    ],
    subtotal: 60,
    tax_amount: 9.6,
    total_amount: 69.6,
    discount_amount: 0,
    payment_method: 'cash',
    amount_paid: 70,
    change_amount: 0.4,
  });

  assert.equal(details.total_items, 3);
  assert.equal(details.item_count, 2);
  assert.deepEqual(details.items[0], {
    product_id: 10,
    name: 'Milk',
    quantity: 2,
    unit_price: 25,
    total_price: 50,
    tax_exclusive_total: null,
  });
  assert.equal(details.total_amount, 69.6);
});
