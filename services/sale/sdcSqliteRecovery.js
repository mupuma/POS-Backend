const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SIDB_ROOT = 'C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\siData';
const SIDB_FILE_NAME = 'sidb.db';
const QR_BASE_URL = 'https://siportal.zra.org.zm/indexInvoiceData?Data=';

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value != null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return null;
}

function escapeSqlLiteral(value) {
  return String(value).replace(/'/g, "''");
}

function resolveSqliteExe() {
  const configured = firstNonEmpty(process.env.ZRA_SQLITE_EXE, process.env.SQLITE_EXE);
  if (configured) return configured;

  const candidates = [
    'C:\\sqlite3\\sqlite3.exe',
    'C:\\sqlite\\sqlite3.exe',
    path.join(process.cwd(), 'sqlite3.exe'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function resolveSidbPath() {
  const configured = firstNonEmpty(process.env.ZRA_SDC_SQLITE_DB_PATH, process.env.SIDB_DB_PATH);
  if (configured) return configured;

  try {
    const tpinBranchFolders = fs.readdirSync(SIDB_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+_\d+$/.test(entry.name))
      .map((entry) => path.join(SIDB_ROOT, entry.name, 'Data', 'db', SIDB_FILE_NAME))
      .filter((candidate) => fs.existsSync(candidate));

    return tpinBranchFolders[0] || null;
  } catch {
    return null;
  }
}

function runSqliteJson(sql, { dbPath = resolveSidbPath(), sqliteExe = resolveSqliteExe(), timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    if (!sqliteExe) {
      resolve({ success: false, error: 'sqlite3.exe not found. Set ZRA_SQLITE_EXE to the SQLite CLI path.' });
      return;
    }
    if (!dbPath || !fs.existsSync(dbPath)) {
      resolve({ success: false, error: `SDC SQLite database not found. Set ZRA_SDC_SQLITE_DB_PATH. Current path: ${dbPath || '(none)'}` });
      return;
    }

    execFile(
      sqliteExe,
      ['-readonly', '-json', dbPath, sql],
      { timeout: Number(timeoutMs), windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ success: false, dbPath, error: stderr || error.message });
          return;
        }
        try {
          resolve({ success: true, dbPath, rows: stdout.trim() ? JSON.parse(stdout) : [] });
        } catch (parseError) {
          resolve({ success: false, dbPath, error: parseError.message, raw: stdout });
        }
      }
    );
  });
}

function buildSdcSaleLookupSql(cisInvcNo) {
  const cis = escapeSqlLiteral(cisInvcNo);
  return `
SELECT
  s.invc_no AS invc_no,
  s.cis_invc_no AS cis_invc_no,
  r.rcpt_sign AS rcpt_sign,
  r.intrl_data AS intrl_data,
  r.rcpt_pbct_dt AS rcpt_pbct_dt
FROM TRNS_SALE s
JOIN TRNS_SALE_RECEIPT r ON r.invc_no = s.invc_no
WHERE s.cis_invc_no = '${cis}'
ORDER BY r.rcpt_pbct_dt DESC, s.invc_no DESC
LIMIT 1;
`.trim();
}

function resolveSdcId(row = {}) {
  return firstNonEmpty(
    row.sdcid,
    row.sdc_id,
    row.sdcId,
    process.env.ZRA_SDC_ID,
    process.env.SDC_ID
  );
}

function buildQrCodeUrl({ tpin, bhfId, rcptSign }) {
  const parts = [
    firstNonEmpty(tpin, process.env.ZRA_TPIN, '1002010901'),
    firstNonEmpty(bhfId, process.env.ZRA_BHF_ID, '000'),
    rcptSign,
  ];
  if (!parts.every(Boolean)) return null;
  return `${QR_BASE_URL}${parts.join('')}`;
}

function mapSdcSaleRowToZraData(row, { tpin, bhfId } = {}) {
  const invcNo = firstNonEmpty(row?.invc_no, row?.invcNo);
  const rcptSign = firstNonEmpty(row?.rcpt_sign, row?.rcptSign);
  const intrlData = firstNonEmpty(row?.intrl_data, row?.intrlData);
  const rcptPbctDt = firstNonEmpty(row?.rcpt_pbct_dt, row?.rcptPbctDt);
  const sdcId = resolveSdcId(row);

  return {
    rcptNo: invcNo,
    sdcId,
    rcptSign,
    intrlData,
    qrCodeUrl: buildQrCodeUrl({ tpin, bhfId, rcptSign }),
    vsdcRcptPbctDate: rcptPbctDt,
    raw: row || null,
  };
}

async function fetchSdcSaleByCisInvoice(cisInvcNo, { tpin, bhfId, timeoutMs } = {}) {
  if (!cisInvcNo) {
    return { success: false, found: false, error: 'Cannot query SDC SQLite without cisInvcNo' };
  }

  const sql = buildSdcSaleLookupSql(cisInvcNo);
  const result = await runSqliteJson(sql, { timeoutMs: timeoutMs || process.env.ZRA_SDC_LOOKUP_TIMEOUT_MS || 5000 });
  if (!result.success) {
    return { ...result, found: false, cisInvcNo };
  }

  const row = result.rows?.[0] || null;
  if (!row) {
    return { success: true, found: false, cisInvcNo, dbPath: result.dbPath };
  }

  return {
    success: true,
    found: true,
    cisInvcNo,
    dbPath: result.dbPath,
    row,
    data: mapSdcSaleRowToZraData(row, { tpin, bhfId }),
  };
}

module.exports = {
  buildQrCodeUrl,
  buildSdcSaleLookupSql,
  fetchSdcSaleByCisInvoice,
  mapSdcSaleRowToZraData,
  resolveSidbPath,
  resolveSqliteExe,
};
