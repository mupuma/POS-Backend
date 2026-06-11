const cron = require('node-cron');
const { createDayEndOutboxEvent, createCreditNoteBatchOutboxEvent } = require('../services/day-end/createDayEndOutboxEvent');

/**
 * DayEndJob
 * - At 20:00 local time (Africa/Lusaka by default), checks if day-end has been completed for each store
 * - If not, queues a day-end sync event and updates last_day_end_date
 */
class DayEndJob {
  /**
   * @param {object} models - Sequelize models (from ./models)
   */
  constructor(models) {
    this.models = models;
    this.isRunning = false;
    this.cronJob = null;

    // Cron schedule can be overridden via env (e.g., "0 20 * * *" for 20:00)
    this.schedule = process.env.DAY_END_CRON || '0 20 * * *';
    this.timezone = process.env.TZ || 'Africa/Lusaka';
  }

  /**
   * Core day-end routine for a single store
    * Queues a single idempotent outbox event for the store/day pair.
   * Should be idempotent for a given (store, date)
   * @param {object} storeInstance
   * @param {string} todayStr - YYYY-MM-DD
   */
  async performDayEndSync(storeInstance, todayStr) {
    const result = await createDayEndOutboxEvent(this.models, {
      storeId: storeInstance.id,
      userId: null,
      dateString: todayStr,
    });

    if (!result.success) {
      return { ok: false, error: 'Failed to queue day-end event' };
    }

    // Queue the day's credit notes as a single consolidated Sage batch, mirroring sales.
    const creditNoteResult = await createCreditNoteBatchOutboxEvent(this.models, {
      storeId: storeInstance.id,
      userId: null,
      dateString: todayStr,
    });

    if (!result.queued && !creditNoteResult.queued) {
      return { ok: true, queued: false, reason: 'No sales or credit notes for this store/day' };
    }

    return {
      ok: true,
      queued: true,
      outboxId: result.outboxId,
      creditNoteOutboxId: creditNoteResult.outboxId,
      events: [
        ...(result.events || []),
        ...(creditNoteResult.events || []),
      ],
    };
  }

  /**
   * Run day-end check for all stores and perform sync if required
   * @param {string} triggeredBy - 'scheduled' | 'manual'
   */
  async runOnce(triggeredBy = 'scheduled') {
    if (this.isRunning) {
      return { skipped: true, reason: 'DayEndJob already running' };
    }

    this.isRunning = true;
    const startedAt = new Date();
    const todayStr = new Date().toISOString().split('T')[0];

    const results = { processed: 0, updated: 0, skipped: 0, errors: [] };

    try {
      const stores = await this.models.store.findAll();
      for (const store of stores) {
        results.processed += 1;
        const lastDate = store.last_day_end_date
          ? (typeof store.last_day_end_date === 'string'
              ? store.last_day_end_date
              : store.last_day_end_date.toISOString().split('T')[0])
          : null;
        if (lastDate === todayStr) {
          results.skipped += 1;
          continue; // already done for today
        }

        try {
          const r = await this.performDayEndSync(store, todayStr);
          if (r && r.ok) {
            // Update last_day_end_date only after successful sync
            await store.update({ last_day_end_date: todayStr });
            results.updated += 1;
          } else {
            results.errors.push({ store_id: store.id, error: 'Day-end sync returned non-ok' });
          }
        } catch (err) {
          results.errors.push({ store_id: store.id, error: err.message });
        }
      }

      const finishedAt = new Date();
      const durationSeconds = Math.floor((finishedAt - startedAt) / 1000);
      return { success: results.errors.length === 0, triggeredBy, durationSeconds, ...results };
    } finally {
      this.isRunning = false;
    }
  }

  /** Start scheduled cron */
  start() {
    if (this.cronJob) return;

    this.cronJob = cron.schedule(this.schedule, async () => {
      try {
        await this.runOnce('scheduled');
      } catch (e) {
        // Never throw from scheduler
        console.error('DayEndJob scheduled run failed:', e.message);
      }
    }, {
      scheduled: true,
      timezone: this.timezone
    });
  }

  /** Stop scheduled cron */
  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
  }

  /** Manual trigger */
  async manualRun() {
    return this.runOnce('manual');
  }
}

module.exports = DayEndJob;
