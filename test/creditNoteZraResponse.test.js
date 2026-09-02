const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCreditNoteUpdatesFromZraResponse,
} = require('../services/credit-note/zraCreditNoteSubmission');
const { buildQrCodeUrl } = require('../services/sale/sdcSqliteRecovery');

test('persists recovered credit-note SDC SQLite receipt fields', async () => {
  const response = {
    success: true,
    data: {
      resultCd: '901',
      resultMsg: 'It is not valid device',
    },
    sdcRecovery: {
      found: true,
      source: 'sdc_sqlite_recovery',
      reason: 'zra_credit_note_post_failed',
      data: {
        rcptNo: '7',
        sdcId: 'SDC0060002799',
        rcptSign: 'RETURN1234567890',
        intrlData: 'RETURNINTERNALDATA',
        qrCodeUrl: buildQrCodeUrl({
          tpin: '1001688419',
          bhfId: '091',
          rcptSign: 'RETURN1234567890',
        }),
        vsdcRcptPbctDate: '20260831150000',
      },
    },
  };

  const result = await buildCreditNoteUpdatesFromZraResponse('CRN-091-10', response);

  assert.equal(result.success, true);
  assert.equal(result.updates.zra_status, 'sent');
  assert.equal(result.updates.invnumber, 'CRN-091-10');
  assert.equal(result.updates.receipt_no, '7');
  assert.equal(result.updates.sdcid, 'SDC0060002799');
  assert.equal(result.updates.receiptsig, 'RETURN1234567890');
  assert.equal(result.updates.intrldata, 'RETURNINTERNALDATA');
  assert.equal(result.updates.vsdcrcpdate, '20260831150000');
  assert.equal(result.updates.invoice_no, 'CRN0060002799/7');
});
