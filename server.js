const { app } = require('./app');
const db = require('./models');
const { createServer } = require('node:http');
const { initializeNotificationSystem, setGlobalNotificationService } = require('./notificationsInit');
const InventorySyncJob = require("./jobs/inventorySyncJob");
const models = require("./models");
const inventorySyncJob = new InventorySyncJob(models);
// Expose the job for routes to allow manual triggering
app.locals.inventorySyncJob = inventorySyncJob;

const PORT = process.env.PORT || 3000;

// Create HTTP server and initialize notifications
const server = createServer(app);
const notificationService = initializeNotificationSystem(server);
setGlobalNotificationService(notificationService);
inventorySyncJob.start();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, stopping cron job...');
  inventorySyncJob.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, stopping cron job...');
  inventorySyncJob.stop();
  process.exit(0);
});
// Sync database and start server
db.sequelize.sync()
  .then(() => {
    console.log('Database connected');
    server.listen(PORT, "0.0.0.0", () => {
  //  server.listen(PORT,  () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`WebSocket server available at ws://localhost:${PORT}/ws/notifications`);
    });
  })
  .catch(err => {
    console.error('Database connection failed:', err);
  });
