const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { deleteProtectedLogs } = require('../services/protectedLogDeletion');

function withProtectedLogEnv(fn) {
  return async () => {
    const previousPassword = process.env.POS_DEVELOPER_PASSWORD;
    const previousHash = process.env.POS_DEVELOPER_PASSWORD_SHA256;
    const previousLock = process.env.POS_LOCK_LOG_FILES;

    process.env.POS_DEVELOPER_PASSWORD = 'dev-secret';
    delete process.env.POS_DEVELOPER_PASSWORD_SHA256;
    process.env.POS_LOCK_LOG_FILES = 'false';

    try {
      await fn();
    } finally {
      if (previousPassword === undefined) delete process.env.POS_DEVELOPER_PASSWORD;
      else process.env.POS_DEVELOPER_PASSWORD = previousPassword;

      if (previousHash === undefined) delete process.env.POS_DEVELOPER_PASSWORD_SHA256;
      else process.env.POS_DEVELOPER_PASSWORD_SHA256 = previousHash;

      if (previousLock === undefined) delete process.env.POS_LOCK_LOG_FILES;
      else process.env.POS_LOCK_LOG_FILES = previousLock;
    }
  };
}

test('protected log deletion requires the developer password', withProtectedLogEnv(async () => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-logs-'));
  fs.writeFileSync(path.join(logRoot, 'sales-2026-07-15.log'), 'sale\n');

  assert.throws(() => deleteProtectedLogs({
    logRoot,
    password: 'wrong',
    date: '2026-07-15',
  }), /Invalid developer password/);

  assert.equal(fs.existsSync(path.join(logRoot, 'sales-2026-07-15.log')), true);
}));

test('protected log deletion removes only matching log files', withProtectedLogEnv(async () => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-logs-'));
  fs.writeFileSync(path.join(logRoot, 'sales-2026-07-15.log'), 'sale\n');
  fs.writeFileSync(path.join(logRoot, 'audit-2026-07-15.log'), 'audit\n');
  fs.writeFileSync(path.join(logRoot, 'sales-2026-07-14.log'), 'old\n');
  fs.writeFileSync(path.join(logRoot, 'notes.txt'), 'not a log\n');

  const result = deleteProtectedLogs({
    logRoot,
    password: 'dev-secret',
    category: 'sales',
    date: '2026-07-15',
  });

  assert.deepEqual(result.deleted, ['sales-2026-07-15.log']);
  assert.equal(fs.existsSync(path.join(logRoot, 'sales-2026-07-15.log')), false);
  assert.equal(fs.existsSync(path.join(logRoot, 'audit-2026-07-15.log')), true);
  assert.equal(fs.existsSync(path.join(logRoot, 'sales-2026-07-14.log')), true);
  assert.equal(fs.existsSync(path.join(logRoot, 'notes.txt')), true);
}));

test('protected log deletion refuses broad deletion unless all is true', withProtectedLogEnv(async () => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-logs-'));
  fs.writeFileSync(path.join(logRoot, 'audit-2026-07-15.log'), 'audit\n');

  assert.throws(() => deleteProtectedLogs({
    logRoot,
    password: 'dev-secret',
  }), /Refusing to delete all logs/);

  const result = deleteProtectedLogs({
    logRoot,
    password: 'dev-secret',
    all: true,
  });

  assert.deepEqual(result.deleted, ['audit-2026-07-15.log']);
}));
