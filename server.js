require('dotenv').config();

const { app } = require('./app');
const db = require('./models');
const { createServer } = require('node:http');
const { initializeNotificationSystem, setGlobalNotificationService } = require('./notificationsInit');
const InventorySyncJob = require("./jobs/inventorySyncJob");
const ZraRetryJob = require("./jobs/zraRetryJob");
const DayEndJob = require("./jobs/dayEndJob");
const CustomerKycJob = require("./jobs/customerKycJob");
const models = require("./models");
const inventorySyncJob = new InventorySyncJob(models);
const zraRetryJob = new ZraRetryJob(models);
const dayEndJob = new DayEndJob(models);
const SyncOutboxJob = require("./jobs/syncOutboxJob");
const syncOutboxJob = new SyncOutboxJob(models);
const customerKycJob = new CustomerKycJob(models);

function setStartupState(stage, { ready = false, error = null } = {}) {
  app.locals.startupState = {
    ready,
    stage,
    error,
  };
}

async function ensureCustomerSchema() {
  const queryInterface = models.sequelize.getQueryInterface();
  let table;

  try {
    table = await queryInterface.describeTable('customers');
  } catch (error) {
    return;
  }

  const missingColumns = [
    ['legal_name', { type: models.Sequelize.STRING(150), allowNull: true }],
    ['tpin', { type: models.Sequelize.STRING(20), allowNull: true, unique: true }],
    ['lookup_status', { type: models.Sequelize.STRING(20), allowNull: false, defaultValue: 'resolved' }],
    ['lookup_source', { type: models.Sequelize.STRING(20), allowNull: true }],
    ['lookup_error', { type: models.Sequelize.TEXT, allowNull: true }],
    ['central_customer_id', { type: models.Sequelize.STRING(100), allowNull: true }],
    ['last_verified_at', { type: models.Sequelize.DATE, allowNull: true }],
    ['last_synced_at', { type: models.Sequelize.DATE, allowNull: true }],
    ['zra_lookup_requested_at', { type: models.Sequelize.DATE, allowNull: true }],
    ['zra_lookup_completed_at', { type: models.Sequelize.DATE, allowNull: true }],
    ['needs_central_sync', { type: models.Sequelize.BOOLEAN, allowNull: false, defaultValue: false }],
  ];

  for (const [columnName, definition] of missingColumns) {
    if (!table[columnName]) {
      await queryInterface.addColumn('customers', columnName, definition);
    }
  }
}

async function ensureCreditNoteSchema() {
  const queryInterface = models.sequelize.getQueryInterface();
  let table;

  try {
    table = await queryInterface.describeTable('credit_notes');
  } catch (error) {
    return;
  }

  const missingColumns = [
    ['zra_status', { type: models.Sequelize.ENUM('pending', 'sent', 'failed'), allowNull: false, defaultValue: 'pending' }],
    ['zra_error', { type: models.Sequelize.TEXT, allowNull: true }],
    ['retry_count', { type: models.Sequelize.INTEGER, allowNull: false, defaultValue: 0 }],
    ['next_retry_at', { type: models.Sequelize.DATE, allowNull: true }],
    ['last_retry_at', { type: models.Sequelize.DATE, allowNull: true }],
    ['sage_status', { type: models.Sequelize.ENUM('pending', 'sent', 'failed'), allowNull: false, defaultValue: 'pending' }],
    ['sage_error', { type: models.Sequelize.TEXT, allowNull: true }],
    ['sage_document_number', { type: models.Sequelize.STRING(100), allowNull: true }],
    ['sage_document_uniquifier', { type: models.Sequelize.STRING(100), allowNull: true }],
    ['sage_reference', { type: models.Sequelize.STRING(255), allowNull: true }],
  ];

  for (const [columnName, definition] of missingColumns) {
    if (!table[columnName]) {
      await queryInterface.addColumn('credit_notes', columnName, definition);
    }
  }
}

// Expose the job for routes to allow manual triggering
app.locals.inventorySyncJob = inventorySyncJob;
app.locals.zraRetryJob = zraRetryJob;
app.locals.dayEndJob = dayEndJob;
app.locals.syncOutboxJob = syncOutboxJob;
app.locals.customerKycJob = customerKycJob;
app.locals.models = models;

const PORT = process.env.PORT || 3000;

// Create HTTP server and initialize notifications
const server = createServer(app);
const notificationService = initializeNotificationSystem(server);
setGlobalNotificationService(notificationService);
inventorySyncJob.start();
zraRetryJob.start();
dayEndJob.start();
syncOutboxJob.start();
customerKycJob.start();
// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, stopping cron job...');
  inventorySyncJob.stop();
  zraRetryJob.stop();
  dayEndJob.stop();
  syncOutboxJob.stop();
  customerKycJob.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, stopping cron job...');
  inventorySyncJob.stop();
  zraRetryJob.stop();
  dayEndJob.stop();
  syncOutboxJob.stop();
  customerKycJob.stop();
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
setStartupState('database_connecting');
db.sequelize.authenticate()
  .then(() => {
    setStartupState('ensuring_schema');
    return ensureCustomerSchema()
      .then(() => ensureCreditNoteSchema());
  })
  .then(() => {
    setStartupState('database_syncing');
    return db.sequelize.sync();
  })
  .then(() => {
    setStartupState('starting_server');
    console.log('Database connected');
    server.listen(PORT, "127.0.0.1", () => {
  //  server.listen(PORT,  () => {
      setStartupState('ready', { ready: true });
      console.log(`Server running on port ${PORT}`);
      console.log(`WebSocket server available at ws://localhost:${PORT}/ws/notifications`);
    });
  })
  .catch(err => {
    setStartupState('failed', { error: err?.message || String(err) });
    console.error('Database connection failed:', err);
  });
