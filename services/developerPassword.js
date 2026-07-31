const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyDeveloperPassword(password) {
  const supplied = String(password || '');
  if (!supplied) {
    return false;
  }

  const expectedHash = String(process.env.POS_DEVELOPER_PASSWORD_SHA256 || '').trim().toLowerCase();
  if (expectedHash) {
    return safeEqual(sha256(supplied), expectedHash);
  }

  const expected = String(process.env.POS_DEVELOPER_PASSWORD || 'mupuma@2022').trim();
  if (!expected) {
    return false;
  }

  return safeEqual(supplied, expected);
}

function requireDeveloperPasswordConfigured() {
  if (!process.env.POS_DEVELOPER_PASSWORD && !process.env.POS_DEVELOPER_PASSWORD_SHA256) {
    throw new Error('POS_DEVELOPER_PASSWORD or POS_DEVELOPER_PASSWORD_SHA256 must be configured before protected logs can be deleted');
  }
}

module.exports = {
  sha256,
  verifyDeveloperPassword,
  requireDeveloperPasswordConfigured,
};
