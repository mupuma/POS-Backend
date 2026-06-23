const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function runtimeRoot() {
  if (process.pkg || process.versions.nexe) {
    return path.dirname(process.execPath);
  }
  return path.resolve(__dirname, '..');
}

function loadRuntimeEnv() {
  const explicitPath = String(process.env.POS_ENV_FILE || '').trim();
  const candidates = [
    explicitPath ? path.resolve(explicitPath) : null,
    path.join(runtimeRoot(), '.env'),
    path.join(process.cwd(), '.env'),
  ].filter(Boolean);
  const envPath = candidates.find((candidate, index) => (
    candidates.indexOf(candidate) === index && fs.existsSync(candidate)
  ));

  if (!envPath) {
    process.env.POS_ENV_LOADED_FROM = '';
    return { loaded: false, path: null };
  }

  const result = dotenv.config({ path: envPath, override: false, quiet: true });
  if (result.error) {
    throw result.error;
  }
  process.env.POS_ENV_LOADED_FROM = envPath;
  return { loaded: true, path: envPath };
}

module.exports = { loadRuntimeEnv, runtimeRoot };
