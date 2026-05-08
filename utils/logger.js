// utils/logger.js
const { createLogger, format, transports } = require('winston');
const Transport = require('winston-transport');
const axios = require('axios');

const siteId = process.env.SITE_ID || 'DEV';

// Custom HTTP transport with batching and retry logic
class RemoteHttpTransport extends Transport {
  constructor(opts) {
    super(opts);
    this.host = opts.host;
    this.path = opts.path;
    this.auth = opts.auth;
    this.batch = [];
    this.batchSize = opts.batchSize || 10;
    this.flushInterval = opts.flushInterval || 5000; // 5 seconds

    // Start flush interval
    this.intervalId = setInterval(() => this.flush(), this.flushInterval);
  }

  log(info, callback) {
    setImmediate(() => this.emit('logged', info));

    // Add to batch
    this.batch.push(info);

    // Flush if batch is full
    if (this.batch.length >= this.batchSize) {
      this.flush();
    }

    callback();
  }

  async flush() {
    if (this.batch.length === 0) return;

    const logsToSend = [...this.batch];
    this.batch = [];

    try {
      await axios.post(
        `${this.host}${this.path}`,
        { logs: logsToSend, siteId },
        {
          headers: {
            'Content-Type': 'application/json',
            ...(this.auth && { 'Authorization': `Bearer ${this.auth}` })
          },
          timeout: 10000
        }
      );
    } catch (err) {
      // Log locally on failure but don't throw
      console.error('Failed to send logs to remote server:', err.message);
      // Optionally: re-add to batch for retry (be careful of memory)
    }
  }

  close() {
    clearInterval(this.intervalId);
    this.flush(); // Final flush
  }
}

// Create transports array
const logTransports = [
  // Console output
  new transports.Console(),

  // Local file backup
  new transports.File({
    filename: 'logs/app.log',
    maxsize: 5 * 1024 * 1024, // 5MB
    maxFiles: 5
  })
];

// Add remote transport only if configured
if (process.env.LOG_SERVER_URL) {
    console.log('Remote logging enabled to', process.env.LOG_SERVER_URL,process.env.LOG_SERVER_PATH);
  logTransports.push(
    new RemoteHttpTransport({
      host: process.env.LOG_SERVER_URL,
      path: process.env.LOG_SERVER_PATH || '/api/logs',
      auth: process.env.LOG_SERVER_TOKEN,
      level: process.env.REMOTE_LOG_LEVEL || 'info', // Only send info+ to remote
      batchSize: 10,
      flushInterval: 5000
    })
  );
}

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'warn',
  defaultMeta: {
    service: 'pos-backend',
    siteId,
    env: process.env.NODE_ENV || 'development',
    hostname: require('os').hostname()
  },
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: logTransports
});

// Pretty console in development
if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new transports.Console({
      format: format.combine(format.colorize(), format.simple())
    })
  );
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.transports.forEach(transport => {
    if (transport.close) transport.close();
  });
});

module.exports = logger;