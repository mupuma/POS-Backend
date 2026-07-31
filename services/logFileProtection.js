const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const EVERYONE_SID = '*S-1-1-0';

function isWindows() {
  return os.platform() === 'win32';
}

function shouldProtectLogs() {
  return String(process.env.POS_LOCK_LOG_FILES || 'true').toLowerCase() !== 'false';
}

function runIcacls(args) {
  const result = spawnSync('icacls', args, {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim();
    throw new Error(message || `icacls exited with status ${result.status}`);
  }

  return result;
}

function protectLogDirectory(logRoot) {
  if (!shouldProtectLogs()) {
    return { protected: false, reason: 'disabled' };
  }

  const resolvedRoot = path.resolve(logRoot);
  fs.mkdirSync(resolvedRoot, { recursive: true });

  if (!isWindows()) {
    return { protected: false, reason: 'unsupported-platform', root: resolvedRoot };
  }

  // Remove our previous deny entry first so startup can be repeated without
  // accumulating duplicate inherited ACEs.
  try {
    runIcacls([resolvedRoot, '/remove:d', EVERYONE_SID, '/T', '/C']);
  } catch (_) {
    // No existing deny ACE is fine; the following command applies the desired state.
  }
  runIcacls([resolvedRoot, '/deny', `${EVERYONE_SID}:(OI)(CI)(DE,DC)`, '/T', '/C']);

  return { protected: true, root: resolvedRoot };
}

function unlockLogDirectory(logRoot) {
  const resolvedRoot = path.resolve(logRoot);
  fs.mkdirSync(resolvedRoot, { recursive: true });

  if (!isWindows()) {
    return { unlocked: false, reason: 'unsupported-platform', root: resolvedRoot };
  }

  runIcacls([resolvedRoot, '/remove:d', EVERYONE_SID, '/T', '/C']);
  return { unlocked: true, root: resolvedRoot };
}

function relockLogDirectory(logRoot) {
  return protectLogDirectory(logRoot);
}

module.exports = {
  protectLogDirectory,
  unlockLogDirectory,
  relockLogDirectory,
};
