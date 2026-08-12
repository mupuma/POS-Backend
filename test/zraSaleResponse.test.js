const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildSaleUpdatesFromZraResponse,
  isZraSaleAlreadyExistsResponse,
  requiresComplianceRefresh,
} = require('../services/sale/zraSaleResponse');
const { normalizeZraStatusForSync } = require('../services/sync/enrichDayEndPayload');
const ZRAIntegrationService = require('../services/sale/generateSmartInvoice');
const { buildQrCodeUrl, mapSdcSaleRowToZraData } = require('../services/sale/sdcSqliteRecovery');

function readLastJsonLine(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]);
}

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

test('does not mark a sale as sent when ZRA returns a failure result code', async () => {
  const response = {
    success: true,
    data: {
      resultCd: '902',
      resultMsg: 'Duplicate invoice number',
      data: {
        rcptNo: '1001',
        sdcId: 'SDC001',
      },
    },
  };

  const result = await buildSaleUpdatesFromZraResponse('INV100', response);

  assert.equal(result.success, false);
  assert.match(result.error, /rejected/i);
  assert.equal(result.updates, undefined);
});

test('marks a sale as sent only when ZRA returns success code and required references', async () => {
  const response = {
    success: true,
    data: {
      resultCd: '000',
      resultMsg: 'Accepted',
      data: {
        rcptNo: '1001',
        sdcId: 'SDC001',
      },
    },
  };

  const result = await buildSaleUpdatesFromZraResponse('INV100', response);

  assert.equal(result.success, true);
  assert.equal(result.updates.zra_status, 'sent');
  assert.equal(result.updates.receipt_no, '1001');
  assert.equal(result.updates.sdcid, 'SDC001');
});

test('flags sent sales with missing compliance data for refetch', () => {
  assert.equal(requiresComplianceRefresh({ zra_status: 'sent', receipt_no: null, sdcid: null }), true);
  assert.equal(requiresComplianceRefresh({ zra_status: 'sent', receipt_no: 'RCP1', sdcid: 'SDC1', receiptsig: 'SIG', intrldata: 'DATA' }), false);
  assert.equal(requiresComplianceRefresh({ zra_status: 'pending' }), true);
});

test('writes full ZRA sales response details to a daily log file', () => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zra-sales-response-'));
  process.env.POS_LOG_DIR = logRoot;

  const { writeZraSalesResponseLog } = require('../services/sale/zraFullResponseLogger');
  const filePath = writeZraSalesResponseLog({
    source: 'test',
    saleId: 123,
    receiptNumber: 'RCP123',
    cisInvoiceNo: 'INV123',
    outcome: 'zra_sales_missing_required_data',
    error: 'ZRA did not return SDC data',
    normalizedResponse: { resultCd: '000', resultMsg: 'Accepted' },
    fullResponse: {
      success: true,
      data: {
        resultCd: '000',
        resultMsg: 'Accepted',
        data: { rcptNo: null, sdcId: null },
      },
    },
  });

  const record = readLastJsonLine(filePath);

  assert.equal(record.sale_id, 123);
  assert.equal(record.log_kind, 'current');
  assert.equal(record.receipt_number, 'RCP123');
  assert.equal(record.full_response.data.resultMsg, 'Accepted');
  assert.equal(record.normalized_response.resultCd, '000');
  assert.match(path.basename(filePath), /^zra-sales-current-response-\d{4}-\d{2}-\d{2}\.log$/);
});

test('writes ZRA sales request details in a Postman-friendly shape', () => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zra-sales-request-'));
  process.env.POS_LOG_DIR = logRoot;

  const { writeZraSalesRequestLog } = require('../services/sale/zraFullResponseLogger');
  const filePath = writeZraSalesRequestLog({
    source: 'test',
    endpoint: 'saveSales',
    method: 'POST',
    url: 'http://zra.test/trnsSales/saveSales',
    headers: { 'Content-Type': 'application/json' },
    body: { cisInvcNo: 'INV123', itemList: [{ itemCd: 'ITEM1' }] },
  });

  const record = readLastJsonLine(filePath);

  assert.equal(record.copy_to_postman.method, 'POST');
  assert.equal(record.copy_to_postman.url, 'http://zra.test/trnsSales/saveSales');
  assert.equal(record.copy_to_postman.body.cisInvcNo, 'INV123');
  assert.equal(record.request.postman.body.mode, 'raw');
  assert.match(record.request.postman.body.raw, /INV123/);
  assert.match(path.basename(filePath), /^zra-sales-current-request-\d{4}-\d{2}-\d{2}\.log$/);
});

test('writes retry ZRA sales logs to retry-specific files', () => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zra-sales-retry-'));
  process.env.POS_LOG_DIR = logRoot;

  const {
    writeZraSalesRequestLog,
    writeZraSalesResponseLog,
  } = require('../services/sale/zraFullResponseLogger');

  const requestPath = writeZraSalesRequestLog({
    source: 'zra_retry.sales',
    logKind: 'retry',
    url: 'http://zra.test/trnsSales/saveSales',
    body: { cisInvcNo: 'INV124' },
  });
  const responsePath = writeZraSalesResponseLog({
    source: 'zra_retry.sales',
    logKind: 'retry',
    fullResponse: { success: false, error: 'timeout' },
  });

  assert.match(path.basename(requestPath), /^zra-sales-retry-request-\d{4}-\d{2}-\d{2}\.log$/);
  assert.match(path.basename(responsePath), /^zra-sales-retry-response-\d{4}-\d{2}-\d{2}\.log$/);

  const requestRecord = readLastJsonLine(requestPath);
  const responseRecord = readLastJsonLine(responsePath);
  assert.equal(requestRecord.log_kind, 'retry');
  assert.equal(responseRecord.log_kind, 'retry');
});

test('day-end sync does not send incomplete ZRA sales as sent', () => {
  assert.deepEqual(
    normalizeZraStatusForSync({
      invnumber: 'INV1106-26099',
      zra_status: 'sent',
    }),
    {
      invnumber: 'INV1106-26099',
      zra_status: 'pending',
    }
  );

  assert.deepEqual(
    normalizeZraStatusForSync({
      invnumber: 'INV1106-26099',
      zra_status: 'sent',
      zra_error: 'ZRA rejected sales data',
    }),
    {
      invnumber: 'INV1106-26099',
      zra_status: 'failed',
      zra_error: 'ZRA rejected sales data',
    }
  );

  assert.equal(
    normalizeZraStatusForSync({
      invnumber: 'INV1106-26099',
      zra_status: 'sent',
      sdcid: 'SDC001',
      receipt_no: '1001',
    }).zra_status,
    'sent'
  );
});

test('ZRA service builds endpoint URLs with one slash between base and path', () => {
  process.env.ZRA_BASE_URL = 'http://localhost:8082/zraprodvsdc/';
  const zraService = new ZRAIntegrationService();

  assert.equal(
    zraService.buildUrl('/trnsSales/saveSales'),
    'http://localhost:8082/zraprodvsdc/trnsSales/saveSales'
  );
  assert.equal(
    zraService.buildUrl('stock/saveStockItems'),
    'http://localhost:8082/zraprodvsdc/stock/saveStockItems'
  );
});

test('detects ZRA duplicate sale responses for existing sale lookup', () => {
  assert.equal(isZraSaleAlreadyExistsResponse({
    resultCd: '902',
    resultMsg: 'Sale already exists',
  }), true);
  assert.equal(isZraSaleAlreadyExistsResponse({
    error: { resultMsg: 'Duplicate invoice number' },
  }), true);
  assert.equal(isZraSaleAlreadyExistsResponse({
    resultCd: '000',
    resultMsg: 'Accepted',
  }), false);
});

test('maps SDC SQLite receipt rows to local receipt fields', () => {
  const previousSdcId = process.env.ZRA_SDC_ID;
  process.env.ZRA_SDC_ID = 'SDC0030003671';

  const mapped = mapSdcSaleRowToZraData({
    invc_no: '651',
    rcpt_sign: 'B7HUJCBBNHQ4OJ45',
    intrl_data: 'BAYFRSHYOKUSJF53MGZEWRIW7Y',
    rcpt_pbct_dt: '20260301104245',
  }, {
    tpin: '1001688419',
    bhfId: '066',
  });

  assert.equal(mapped.rcptNo, '651');
  assert.equal(mapped.sdcId, 'SDC0030003671');
  assert.equal(mapped.rcptSign, 'B7HUJCBBNHQ4OJ45');
  assert.equal(mapped.intrlData, 'BAYFRSHYOKUSJF53MGZEWRIW7Y');
  assert.equal(mapped.vsdcRcptPbctDate, '20260301104245');
  assert.equal(
    mapped.qrCodeUrl,
    'https://siportal.zra.org.zm/indexInvoiceData?Data=1001688419066B7HUJCBBNHQ4OJ45'
  );

  if (previousSdcId == null) {
    delete process.env.ZRA_SDC_ID;
  } else {
    process.env.ZRA_SDC_ID = previousSdcId;
  }
});

test('uses recovered SDC SQLite data when ZRA duplicate response has fiscal fields in sidb', async () => {
  const previousSdcId = process.env.ZRA_SDC_ID;
  process.env.ZRA_SDC_ID = 'SDC0030003671';

  const response = {
    success: true,
    data: {
      resultCd: '924',
      resultMsg: 'CIS Invoice number already exists. [cisInvcNo]',
    },
    sdcRecovery: {
      found: true,
      source: 'sdc_sqlite_recovery',
      reason: 'zra_sale_already_exists',
      data: {
        rcptNo: '651',
        sdcId: 'SDC0030003671',
        rcptSign: 'B7HUJCBBNHQ4OJ45',
        intrlData: 'BAYFRSHYOKUSJF53MGZEWRIW7Y',
        qrCodeUrl: buildQrCodeUrl({
          tpin: '1001688419',
          bhfId: '066',
          rcptSign: 'B7HUJCBBNHQ4OJ45',
        }),
        vsdcRcptPbctDate: '20260301104245',
      },
    },
  };

  const result = await buildSaleUpdatesFromZraResponse('INV1106-669', response);

  assert.equal(result.success, true);
  assert.equal(result.updates.zra_status, 'sent');
  assert.equal(result.updates.receipt_no, '651');
  assert.equal(result.updates.sdcid, 'SDC0030003671');
  assert.equal(result.updates.invoice_no, 'INV0030003671/651');
  assert.equal(
    result.updates.qrcode_url,
    'https://siportal.zra.org.zm/indexInvoiceData?Data=1001688419066B7HUJCBBNHQ4OJ45'
  );

  if (previousSdcId == null) {
    delete process.env.ZRA_SDC_ID;
  } else {
    process.env.ZRA_SDC_ID = previousSdcId;
  }
});
