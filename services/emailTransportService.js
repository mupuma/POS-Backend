const nodemailer = require('nodemailer');

function booleanEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function getEmailConfig() {
  const host = String(process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '');
  const secure = booleanEnv('SMTP_SECURE', port === 465);
  const fromAddress = String(process.env.SMTP_FROM || user).trim();
  const recipients = String(
    process.env.SALES_REPORT_RECIPIENTS
      || process.env.SALES_REPORT_RECIPIENT
      || 'admin@dappzambia.org'
  ).split(',').map((value) => value.trim()).filter(Boolean);

  return {
    host,
    port,
    secure,
    user,
    pass,
    fromAddress,
    recipients,
    companyName: String(process.env.COMPANY_NAME || 'SwiftCart POS').trim(),
    rejectUnauthorized: booleanEnv('SMTP_TLS_REJECT_UNAUTHORIZED', true),
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 20_000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 20_000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 60_000),
  };
}

function assertEmailConfigured(config = getEmailConfig()) {
  const missing = [];
  if (!config.host) missing.push('SMTP_HOST');
  if (!Number.isFinite(config.port) || config.port <= 0) missing.push('SMTP_PORT');
  if (!config.user) missing.push('SMTP_USER');
  if (!config.pass) missing.push('SMTP_PASS');
  if (!config.fromAddress) missing.push('SMTP_FROM or SMTP_USER');
  if (missing.length > 0) {
    const error = new Error(`Email is not configured. Missing: ${missing.join(', ')}`);
    error.code = 'SMTP_NOT_CONFIGURED';
    throw error;
  }
  return config;
}

function createEmailTransporter() {
  const config = assertEmailConfigured();
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: config.connectionTimeout,
    greetingTimeout: config.greetingTimeout,
    socketTimeout: config.socketTimeout,
    tls: {
      rejectUnauthorized: config.rejectUnauthorized,
      servername: config.host,
    },
  });
}

function getEmailDiagnostics() {
  const config = getEmailConfig();
  return {
    configured: Boolean(config.host && config.port && config.user && config.pass && config.fromAddress),
    host: config.host,
    port: config.port,
    secure: config.secure,
    user: config.user || null,
    fromAddress: config.fromAddress || null,
    recipientCount: config.recipients.length,
    envFile: process.env.POS_ENV_LOADED_FROM || null,
    packaged: Boolean(process.pkg || process.versions.nexe),
  };
}

async function verifyEmailTransport() {
  const transporter = createEmailTransporter();
  await transporter.verify();
  return getEmailDiagnostics();
}

module.exports = {
  assertEmailConfigured,
  createEmailTransporter,
  getEmailConfig,
  getEmailDiagnostics,
  verifyEmailTransport,
};
