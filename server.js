const { app } = require('./app');
const db = require('./models');
const { createServer } = require('node:http');
const { initializeNotificationSystem, setGlobalNotificationService } = require('./notificationsInit');
const InventorySyncJob = require("./jobs/inventorySyncJob");
const ZraRetryJob = require("./jobs/zraRetryJob");
const DayEndJob = require("./jobs/dayEndJob");
const models = require("./models");
const inventorySyncJob = new InventorySyncJob(models);
const zraRetryJob = new ZraRetryJob(models);
const dayEndJob = new DayEndJob(models);
// Expose the job for routes to allow manual triggering
app.locals.inventorySyncJob = inventorySyncJob;
app.locals.zraRetryJob = zraRetryJob;
app.locals.dayEndJob = dayEndJob;

const PORT = process.env.PORT || 3000;
const { sendHeartbeat } = require('./heartbeat');
const {info} = require("./utils/logger");

// ... after app is created and server is started ...
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 60000);

setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

info('server_started', {
  siteId: process.env.SITE_ID || 'DEV',
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS
});
// Create HTTP server and initialize notifications
const server = createServer(app);
const notificationService = initializeNotificationSystem(server);
setGlobalNotificationService(notificationService);
inventorySyncJob.start();
zraRetryJob.start();
dayEndJob.start();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, stopping cron job...');
  inventorySyncJob.stop();
  zraRetryJob.stop();
  dayEndJob.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, stopping cron job...');
  inventorySyncJob.stop();
  zraRetryJob.stop();
  dayEndJob.stop();
  process.exit(0);
});
if (process.versions.nexe) {
  require('nexe-natives')({
    modules: [
      'mysql2/build/Release/mysql_bindings.node',
      'tedious/build/Release/tedious.node'
    ]
  });
}
// Sync database and start server
db.sequelize.sync()
  .then(() => {
    console.log('Database connected');
    server.listen(PORT, "127.0.0.1", () => {
  //  server.listen(PORT,  () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`WebSocket server available at ws://localhost:${PORT}/ws/notifications`);
    });
  })
  .catch(err => {
    console.error('Database connection failed:', err);
  });
