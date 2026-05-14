const cron = require('node-cron');
const axios = require('axios');
const { Op } = require('sequelize');

class SyncOutboxJob {
  constructor(models) {
    this.models = models;
    this.isRunning = false;
    this.cronJob = null;
    this.intervalCron = '*/1 * * * *';
    this.maxRetries = 10;
    this.baseDelayMinutes = 2;
    this.syncServerUrl = process.env.SYNC_SERVER_URL;
    this.syncServerToken = process.env.SYNC_SERVER_TOKEN;
  }

  start() {
    if (this.cronJob) return;

    this.cronJob = cron.schedule(this.intervalCron, async () => {
      try {
        await this.run();
      } catch (_) {}
    }, { scheduled: true, timezone: 'Africa/Lusaka' });
  }

  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
  }

  async run() {
    if (this.isRunning) return { skipped: true };
    if (!this.syncServerUrl) return { skipped: true, reason: 'SYNC_SERVER_URL not configured' };

    this.isRunning = true;

    try {
      const now = new Date();
      const rows = await this.models.sync_outbox.findAll({
        where: {
          status: ['pending', 'failed'],
          next_retry_at: { [Op.lte]: now }
        },
        order: [['id', 'ASC']],
        limit: 20
      });

      for (const row of rows) {
        await this.sendOne(row);
      }

      return { success: true, processed: rows.length };
    } catch (error) {
      return { success: false, error: error.message };
    } finally {
      this.isRunning = false;
    }
  }

  async sendOne(row) {
    try {
      await row.update({
        status: 'sending',
        last_attempt_at: new Date(),
        locked_at: new Date()
      });

      const response = await axios.post(
        `${this.syncServerUrl}/api/sync/events`,
        {
          event_type: row.event_type,
          aggregate_type: row.aggregate_type,
          aggregate_id: row.aggregate_id,
          store_id: row.store_id,
          user_id: row.user_id,
          receipt_number: row.receipt_number,
          idempotency_key: row.idempotency_key,
          payload: row.payload
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.syncServerToken}`
          },
          timeout: 30000
        }
      );

      await row.update({
        status: 'sent',
        sent_at: new Date(),
        response_payload: response.data,
        last_error: null,
        locked_at: null,
        next_retry_at: null
      });
    } catch (error) {
      const attemptCount = (row.attempt_count || 0) + 1;
      const terminal = attemptCount >= this.maxRetries;

      await row.update({
        status: terminal ? 'dead_letter' : 'failed',
        attempt_count: attemptCount,
        last_error: error.message,
        response_payload: error.response?.data || null,
        next_retry_at: terminal ? null : new Date(Date.now() + this.baseDelayMinutes * 60 * 1000),
        locked_at: null
      });
    }
  }
}

module.exports = SyncOutboxJob;