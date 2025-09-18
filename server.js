const { app } = require('./app');
const db = require('./models');
const { createServer } = require('node:http');
const { initializeNotificationSystem, setGlobalNotificationService } = require('./notificationsInit');

const PORT = process.env.PORT || 3000;

// Create HTTP server and initialize notifications
const server = createServer(app);
const notificationService = initializeNotificationSystem(server);
setGlobalNotificationService(notificationService);

// Sync database and start server
db.sequelize.sync()
  .then(() => {
    console.log('Database connected');
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`WebSocket server available at ws://localhost:${PORT}/ws/notifications`);
    });
  })
  .catch(err => {
    console.error('Database connection failed:', err);
  });
