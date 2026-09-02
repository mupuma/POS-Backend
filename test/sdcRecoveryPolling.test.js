const test = require('node:test');
const assert = require('node:assert/strict');

test('ZRA service polls SIDB until real SDC receipt data is available', async () => {
  const previousWaitMs = process.env.ZRA_SDC_RECOVERY_WAIT_MS;
  const previousIntervalMs = process.env.ZRA_SDC_RECOVERY_INTERVAL_MS;
  const previousLookupTimeoutMs = process.env.ZRA_SDC_LOOKUP_TIMEOUT_MS;
  process.env.ZRA_SDC_RECOVERY_WAIT_MS = '1000';
  process.env.ZRA_SDC_RECOVERY_INTERVAL_MS = '10';
  process.env.ZRA_SDC_LOOKUP_TIMEOUT_MS = '50';

  const recoveryPath = require.resolve('../services/sale/sdcSqliteRecovery');
  const servicePath = require.resolve('../services/sale/generateSmartInvoice');
  const originalRecoveryModule = require.cache[recoveryPath];
  const originalServiceModule = require.cache[servicePath];
  let calls = 0;

  require.cache[recoveryPath] = {
    id: recoveryPath,
    filename: recoveryPath,
    loaded: true,
    exports: {
      async fetchSdcSaleByCisInvoice(cisInvcNo, options) {
        calls += 1;
        assert.equal(cisInvcNo, 'INV-123');
        assert.equal(options.tpin, '1001688419');
        assert.equal(options.bhfId, '066');
        assert.equal(options.timeoutMs, 500);

        if (calls === 1) {
          return { success: true, found: false, cisInvcNo };
        }

        return {
          success: true,
          found: true,
          cisInvcNo,
          data: {
            rcptNo: '651',
            sdcId: 'SDC0030003671',
            rcptSign: 'B7HUJCBBNHQ4OJ45',
          },
        };
      },
    },
  };
  delete require.cache[servicePath];

  try {
    const ZRAIntegrationService = require('../services/sale/generateSmartInvoice');
    const service = new ZRAIntegrationService();
    const recovery = await service.fetchSaleFromSdcSqlite({
      cisInvcNo: 'INV-123',
      tpin: '1001688419',
      bhfId: '066',
    }, {
      reason: 'zra_success_missing_sdc_data',
      timeoutMs: 8000,
    });

    assert.equal(recovery.found, true);
    assert.equal(recovery.attempts, 2);
    assert.equal(recovery.data.rcptNo, '651');
    assert.equal(recovery.reason, 'zra_success_missing_sdc_data');
  } finally {
    if (originalRecoveryModule) {
      require.cache[recoveryPath] = originalRecoveryModule;
    } else {
      delete require.cache[recoveryPath];
    }
    if (originalServiceModule) {
      require.cache[servicePath] = originalServiceModule;
    } else {
      delete require.cache[servicePath];
    }
    if (previousWaitMs === undefined) {
      delete process.env.ZRA_SDC_RECOVERY_WAIT_MS;
    } else {
      process.env.ZRA_SDC_RECOVERY_WAIT_MS = previousWaitMs;
    }
    if (previousIntervalMs === undefined) {
      delete process.env.ZRA_SDC_RECOVERY_INTERVAL_MS;
    } else {
      process.env.ZRA_SDC_RECOVERY_INTERVAL_MS = previousIntervalMs;
    }
    if (previousLookupTimeoutMs === undefined) {
      delete process.env.ZRA_SDC_LOOKUP_TIMEOUT_MS;
    } else {
      process.env.ZRA_SDC_LOOKUP_TIMEOUT_MS = previousLookupTimeoutMs;
    }
  }
});
