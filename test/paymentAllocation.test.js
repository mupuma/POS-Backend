const test = require('node:test');
const assert = require('node:assert/strict');
const { allocateSalePayments } = require('../services/reports/paymentAllocation');

test('allocates mixed tenders and removes cash change', () => {
  const payments = allocateSalePayments([{
    total_amount: 180,
    payment_method: 'mixed',
    payments_breakdown: { cash: 100, card: 100 },
    change_amount: 20,
  }]);

  assert.deepEqual(payments, {
    CASH: 80,
    CARD: 100,
    MOBILE_MONEY: 0,
    OTHER: 0,
  });
});

test('parses MySQL JSON strings and preserves the sale total', () => {
  const payments = allocateSalePayments([{
    total_amount: '75.50',
    payment_method: 'mixed',
    payments_breakdown: '{"cash": "25.50", "mobile_money": 50}',
    change_amount: 0,
  }]);

  assert.equal(Object.values(payments).reduce((sum, value) => sum + value, 0), 75.50);
  assert.equal(payments.CASH, 25.50);
  assert.equal(payments.MOBILE_MONEY, 50);
});

test('falls back to the top-level payment method', () => {
  assert.deepEqual(allocateSalePayments([{
    total_amount: 42,
    payment_method: 'cash',
  }]), {
    CASH: 42,
    CARD: 0,
    MOBILE_MONEY: 0,
    OTHER: 0,
  });
});
