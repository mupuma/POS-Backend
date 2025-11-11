const cron = require('node-cron');
const Sage300InventoryService = require('../services/getSageStockQuantityOnHand');
const mssqlDb = require('../models_mssql');
class InventorySyncJob {
  constructor(models) {
    this.models = models;
    this.inventoryService = new Sage300InventoryService(mssqlDb);
    this.isRunning = false;
    this.cronJob = null;
    this.lastSyncedDate = null; // in-memory tracking to avoid duplicate daily syncs
  }

  /**
   * Check if sync has already been done today (in-memory only)
   * @returns {Promise<boolean>}
   */
  async hasSyncedToday() {
    const today = new Date().toISOString().split('T')[0];
    return this.lastSyncedDate === today;
  }

  /**
   * Kept for backward compatibility; no logging info is stored anymore.
   * @returns {Promise<Object|null>}
   */
  async getTodaySyncStatus() {
    return null;
  }

  /**
   * Kept for backward compatibility; no history is stored anymore.
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async getSyncHistory(limit = 30) {
    return [];
  }

  /**
   * Run the inventory sync
   * @param {string} triggeredBy - 'scheduled' or 'manual'
   * @returns {Promise<Object>}
   */
  async runSync(triggeredBy = 'scheduled') {
    if (this.isRunning) {
      return { skipped: true, reason: 'Already running' };
    }

    this.isRunning = true;
    const startTime = new Date();

    try {
      // Get location-to-store mapping
      const locationStoreMap = await this.inventoryService.getLocationStoreMapping(this.models);

      if (Object.keys(locationStoreMap).length === 0) {
        throw new Error('No store location mappings found. Please ensure stores have location_code set.');
      }

      // Run the sync
      const results = await this.inventoryService.syncInventoryToDatabase(
        this.models,
        'CP',
        locationStoreMap
      );
      console.log(results);

      const endTime = new Date();
      const durationSeconds = Math.floor((endTime - startTime) / 1000);

      // Determine status (for response only)
      let status = 'success';
      if (results.errors.length > 0) {
        status = results.success.length > 0 ? 'partial' : 'failed';
      }

      // Mark as synced today on success or partial success
      if (status === 'success' || status === 'partial') {
        this.lastSyncedDate = new Date().toISOString().split('T')[0];
      }

      // Create sync log only after completion
      try {
        const syncDate = endTime.toISOString().split('T')[0];
        const syncTime = endTime.toTimeString().split(' ')[0];
        await this.models.inventorysynclog.create({
          sync_date: syncDate,
          sync_time: syncTime,
          status,
          items_processed: results.success.length + results.errors.length + results.skipped,
          records_created: results.created,
          records_updated: results.updated,
          records_skipped: results.skipped,
          errors_count: results.errors.length,
          error_details: results.errors.length > 0 ? results.errors : null,
          duration_seconds: durationSeconds,
          started_at: startTime,
          completed_at: endTime,
          triggered_by: triggeredBy
        });
      } catch (_) {
        // swallow logging errors to not affect response
      }

      this.isRunning = false;
      return {
        success: status !== 'failed',
        status,
        results,
        duration: durationSeconds
      };

    } catch (error) {
      const endTime = new Date();
      const durationSeconds = Math.floor((endTime - startTime) / 1000);

      // Create sync log only after completion (failed)
      try {
        const syncDate = endTime.toISOString().split('T')[0];
        const syncTime = endTime.toTimeString().split(' ')[0];
        await this.models.inventorysynclog.create({
          sync_date: syncDate,
          sync_time: syncTime,
          status: 'failed',
          items_processed: 0,
          records_created: 0,
          records_updated: 0,
          records_skipped: 0,
          errors_count: 1,
          error_details: [{ error: error.message }],
          duration_seconds: durationSeconds,
          started_at: startTime,
          completed_at: endTime,
          triggered_by: triggeredBy
        });
      } catch (_) {
        // swallow logging errors to not affect response
      }

      this.isRunning = false;
      return {
        success: false,
        error: error.message,
        duration: durationSeconds
      };
    }
  }

  /**
   * Start the scheduled job (runs daily at 07:50)
   */
  start() {
    if (this.cronJob) {
      return;
    }

    // Schedule: Every day at 07:40
    // Cron format: minute hour day month dayOfWeek
    this.cronJob = cron.schedule('40 7 * * *', async () => {
      const alreadySynced = await this.hasSyncedToday();
      if (alreadySynced) {
        return;
      }
      await this.runSync('scheduled');
    }, {
      scheduled: true,
      timezone: "Africa/Lusaka"
    });
  }

  /**
   * Stop the scheduled job
   */
  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
  }

  /**
   * Manually trigger a sync
   * @returns {Promise<Object>}
   */
  async manualSync() {
    return await this.runSync('manual');
  }
}

module.exports = InventorySyncJob;