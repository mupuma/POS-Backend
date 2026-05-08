// heartbeat.js
const axios = require('axios');
const logger = require('./utils/logger');

const CENTRAL_MONITOR_URL = process.env.CENTRAL_MONITOR_URL; // e.g. https://monitor.yourdomain.com/heartbeat

async function sendHeartbeat() {
  if (!CENTRAL_MONITOR_URL) return;

  try {
    await axios.post(CENTRAL_MONITOR_URL, {
      siteId: process.env.SITE_ID || 'DEV',
      timestamp: new Date().toISOString(),
      version: process.env.APP_VERSION || '1.0.0'
    });
    logger.info('heartbeat_sent', { siteId: process.env.SITE_ID });
  } catch (err) {
    logger.error('heartbeat_failed', {
      siteId: process.env.SITE_ID,
      error: err.message
    });
  }
}

module.exports = { sendHeartbeat };