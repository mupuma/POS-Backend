const PAYMENT_KEYS = Object.freeze(['CASH', 'CARD', 'MOBILE_MONEY', 'OTHER']);

function normalizePaymentMethod(method) {
  const value = String(method || '').trim().toLowerCase();
  if (value === 'cash') return 'CASH';
  if (['card', 'visa', 'mastercard', 'debit', 'credit', 'pos'].includes(value)) return 'CARD';
  if (['mobile', 'mobile money', 'mobile_money', 'mpesa', 'm-pesa', 'm pesa', 'momo', 'airtel money', 'tigo pesa'].includes(value)) return 'MOBILE_MONEY';
  return 'OTHER';
}

function emptyPayments() {
  return Object.fromEntries(PAYMENT_KEYS.map((key) => [key, 0]));
}

function toCents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function parseBreakdown(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function allocateSalePayments(rows) {
  const cents = emptyPayments();

  for (const row of rows || []) {
    const totalCents = toCents(row.total_amount ?? row.amount);
    const breakdown = parseBreakdown(row.payments_breakdown);
    const entries = breakdown
      ? Object.entries(breakdown).filter(([, amount]) => toCents(amount) > 0)
      : [];

    if (entries.length === 0) {
      cents[normalizePaymentMethod(row.payment_method)] += totalCents;
      continue;
    }

    const allocated = emptyPayments();
    for (const [method, amount] of entries) {
      allocated[normalizePaymentMethod(method)] += toCents(amount);
    }

    // Change handed back to the customer leaves the cash drawer, even on a
    // mixed-tender transaction.
    allocated.CASH -= toCents(row.change_amount);

    const allocatedTotal = PAYMENT_KEYS.reduce((sum, key) => sum + allocated[key], 0);
    const difference = totalCents - allocatedTotal;
    const adjustmentKey = entries.length === 1
      ? normalizePaymentMethod(entries[0][0])
      : (allocated.CASH > 0 ? 'CASH' : normalizePaymentMethod(row.payment_method));
    allocated[adjustmentKey] += difference;

    for (const key of PAYMENT_KEYS) cents[key] += allocated[key];
  }

  return Object.fromEntries(PAYMENT_KEYS.map((key) => [key, cents[key] / 100]));
}

function allocateSimplePayments(rows) {
  const cents = emptyPayments();
  for (const row of rows || []) {
    cents[normalizePaymentMethod(row.payment_method)] += toCents(row.total_amount ?? row.amount);
  }
  return Object.fromEntries(PAYMENT_KEYS.map((key) => [key, cents[key] / 100]));
}

module.exports = {
  PAYMENT_KEYS,
  normalizePaymentMethod,
  allocateSalePayments,
  allocateSimplePayments,
};
