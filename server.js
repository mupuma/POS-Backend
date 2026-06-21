require('dotenv').config();

const { initLogDirectory } = require('./services/fileAuditLogger');

const { app } = require('./app');
const db = require('./models');
const { createServer } = require('node:http');
const { initializeNotificationSystem, setGlobalNotificationService } = require('./notificationsInit');
const InventorySyncJob = require("./jobs/inventorySyncJob");
const ZraRetryJob = require("./jobs/zraRetryJob");
const DayEndJob = require("./jobs/dayEndJob");
const SalesReportEmailJob = require("./jobs/salesReportEmailJob");
const CustomerKycJob = require("./jobs/customerKycJob");
const models = require("./models");
const inventorySyncJob = new InventorySyncJob(models);
const zraRetryJob = new ZraRetryJob(models);
const dayEndJob = new DayEndJob(models);
const salesReportEmailJob = new SalesReportEmailJob(models);
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

// Ensure indexes exist on frequently-sorted columns. Without an index on the
// ORDER BY column, MySQL must filesort the matching rows, and because tables like
// `sales`/`credit_notes` carry large TEXT/JSON columns (notes, zra_error,
// payments_breakdown, etc.) the sort buffer overflows once there are thousands of
// rows -> ER_OUT_OF_SORTMEMORY. An index lets the optimizer order via the index and
// skip the filesort entirely. Idempotent: only adds an index when it is missing.
async function ensureIndexes() {
  const queryInterface = models.sequelize.getQueryInterface();

  const indexPlan = [
    ['sales', ['sale_date'], 'idx_sales_sale_date'],
    ['sales', ['created_at'], 'idx_sales_created_at'],
    ['sales', ['user_id'], 'idx_sales_user_id'],
    ['sales', ['user_id', 'sale_date', 'id'], 'idx_sales_user_date_id'],
    ['credit_notes', ['credit_note_date'], 'idx_credit_notes_credit_note_date'],
    ['credit_notes', ['created_at'], 'idx_credit_notes_created_at'],
    ['credit_notes', ['user_id'], 'idx_credit_notes_user_id'],
    ['credit_notes', ['original_sale_id'], 'idx_credit_notes_original_sale_id'],
    ['credit_notes', ['user_id', 'created_at', 'id'], 'idx_credit_notes_user_created_id'],
    ['saleitems', ['sale_id', 'product_id'], 'idx_saleitems_sale_product'],
    ['credit_note_items', ['credit_note_id'], 'idx_credit_note_items_note'],
    ['productinventories', ['store_id', 'product_id'], 'idx_productinventories_store_product'],
    ['users', ['store_id', 'is_active'], 'idx_users_store_active'],
    ['notifications', ['created_at'], 'idx_notifications_created_at'],
    ['notifications', ['user_id'], 'idx_notifications_user_id'],
    ['audit_logs', ['occurred_at'], 'idx_audit_logs_occurred_at'],
    ['products', ['name'], 'idx_products_name'],
    ['customers', ['zra_lookup_requested_at'], 'idx_customers_zra_lookup_requested_at'],
  ];

  for (const [table, fields, name] of indexPlan) {
    try {
      const existing = await queryInterface.showIndex(table);
      if (existing.some((index) => index.name === name)) {
        continue;
      }
      await queryInterface.addIndex(table, fields, { name });
      console.log(`Created index ${name} on ${table}(${fields.join(', ')})`);
    } catch (error) {
      console.warn(`Skipped index ${name} on ${table}: ${error.message}`);
    }
  }
}

// Expose the job for routes to allow manual triggering
app.locals.inventorySyncJob = inventorySyncJob;
app.locals.zraRetryJob = zraRetryJob;
app.locals.dayEndJob = dayEndJob;
app.locals.salesReportEmailJob = salesReportEmailJob;
app.locals.syncOutboxJob = syncOutboxJob;
app.locals.customerKycJob = customerKycJob;
app.locals.models = models;

const PORT = process.env.PORT || 3000;

const logPaths = initLogDirectory();
console.log(`POS audit log directory: ${logPaths.root}`);
console.log(`Sales log (readable): ${logPaths.salesReadable}`);
console.log(`Sales log (JSON):     ${logPaths.salesJson}`);
console.log(`Credit notes log (readable): ${logPaths.creditNotesReadable}`);
console.log(`Credit notes log (JSON):     ${logPaths.creditNotes}`);

// Create HTTP server and initialize notifications
const server = createServer(app);
const notificationService = initializeNotificationSystem(server);
setGlobalNotificationService(notificationService);
inventorySyncJob.start();
zraRetryJob.start();
dayEndJob.start();
salesReportEmailJob.start();
syncOutboxJob.start();
customerKycJob.start();
// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, stopping cron job...');
  inventorySyncJob.stop();
  zraRetryJob.stop();
  dayEndJob.stop();
  salesReportEmailJob.stop();
  syncOutboxJob.stop();
  customerKycJob.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, stopping cron job...');
  inventorySyncJob.stop();
  zraRetryJob.stop();
  dayEndJob.stop();
  salesReportEmailJob.stop();
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
      .then(() => ensureCreditNoteSchema())
      .then(() => ensureIndexes());
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
