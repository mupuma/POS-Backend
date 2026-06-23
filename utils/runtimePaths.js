const path = require('path');
const { runtimeRoot } = require('../config/runtimeEnv');

function writableRoot() {
  return process.env.POS_DATA_DIR
    ? path.resolve(process.env.POS_DATA_DIR)
    : runtimeRoot();
}

function runtimeTempDir() {
  return path.join(writableRoot(), 'temp');
}

module.exports = { runtimeTempDir, writableRoot };
