const fs = require('fs');
const path = require('path');
const { getLogRoot } = require('./fileAuditLogger');
const { requireDeveloperPasswordConfigured, verifyDeveloperPassword } = require('./developerPassword');
const { relockLogDirectory, unlockLogDirectory } = require('./logFileProtection');

const CATEGORY_PREFIXES = new Set([
  'audit',
  'auth',
  'sales',
  'sales-readable',
  'credit-notes',
  'credit-notes-readable',
]);

function isLockEnabled() {
  return String(process.env.POS_LOCK_LOG_FILES || 'true').toLowerCase() !== 'false';
}

function validateDateKey(date) {
  if (date == null || date === '') {
    return null;
  }

  const value = String(date).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('date must use YYYY-MM-DD format');
  }

  return value;
}

function validateCategory(category) {
  if (category == null || category === '') {
    return null;
  }

  const value = String(category).trim();
  if (!CATEGORY_PREFIXES.has(value)) {
    throw new Error(`category must be one of: ${Array.from(CATEGORY_PREFIXES).join(', ')}`);
  }

  return value;
}

function validateFileName(fileName) {
  if (fileName == null || fileName === '') {
    return null;
  }

  const value = path.basename(String(fileName).trim());
  if (value !== String(fileName).trim() || !value.endsWith('.log')) {
    throw new Error('fileName must be a .log file name without path separators');
  }

  return value;
}

function logFileMatches(fileName, filters) {
  if (!fileName.endsWith('.log')) {
    return false;
  }

  if (filters.fileName) {
    return fileName === filters.fileName;
  }

  if (filters.category && !fileName.startsWith(`${filters.category}-`)) {
    return false;
  }

  if (filters.date && !fileName.endsWith(`${filters.date}.log`)) {
    return false;
  }

  return true;
}

function listMatchingLogFiles(logRoot, filters) {
  const root = path.resolve(logRoot);
  if (!fs.existsSync(root)) {
    return [];
  }

  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && logFileMatches(entry.name, filters))
    .map((entry) => {
      const fullPath = path.resolve(root, entry.name);
      if (!fullPath.startsWith(`${root}${path.sep}`)) {
        throw new Error('Refusing to delete a file outside the log directory');
      }
      return { name: entry.name, path: fullPath };
    });
}

function deleteProtectedLogs(options = {}) {
  requireDeveloperPasswordConfigured();
  if (!verifyDeveloperPassword(options.password)) {
    throw new Error('Invalid developer password');
  }

  const filters = {
    date: validateDateKey(options.date),
    category: validateCategory(options.category),
    fileName: validateFileName(options.fileName),
  };

  if (!filters.date && !filters.category && !filters.fileName && options.all !== true) {
    throw new Error('Refusing to delete all logs unless all is true');
  }

  const logRoot = path.resolve(options.logRoot || getLogRoot());
  const matchedFiles = listMatchingLogFiles(logRoot, filters);
  const deleted = [];

  if (matchedFiles.length === 0) {
    return { deletedCount: 0, deleted, logRoot };
  }

  if (isLockEnabled()) {
    unlockLogDirectory(logRoot);
  }

  try {
    for (const file of matchedFiles) {
      fs.unlinkSync(file.path);
      deleted.push(file.name);
    }
  } finally {
    if (isLockEnabled()) {
      relockLogDirectory(logRoot);
    }
  }

  return { deletedCount: deleted.length, deleted, logRoot };
}

module.exports = {
  deleteProtectedLogs,
  listMatchingLogFiles,
};
