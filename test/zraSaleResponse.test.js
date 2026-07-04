const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSaleUpdatesFromZraResponse, requiresComplianceRefresh } = require('../services/sale/zraSaleResponse');

test('does not mark a sale as sent when ZRA omits SDC information', async () => {
  const response = {
    success: true,
    data: {
      resultCd: '000',
      resultMsg: 'Accepted',
    },
  };

  const result = await buildSaleUpdatesFromZraResponse('INV100', response);

  assert.equal(result.success, false);
  assert.match(result.error, /SDC data/i);
  assert.equal(result.updates, undefined);
});

test('flags sent sales with missing compliance data for refetch', () => {
  assert.equal(requiresComplianceRefresh({ zra_status: 'sent', receipt_no: null, sdcid: null }), true);
  assert.equal(requiresComplianceRefresh({ zra_status: 'sent', receipt_no: 'RCP1', sdcid: 'SDC1', receiptsig: 'SIG', intrldata: 'DATA' }), false);
  assert.equal(requiresComplianceRefresh({ zra_status: 'pending' }), true);
});
