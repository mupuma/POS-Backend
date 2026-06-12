const cron = require('node-cron');
const axios = require('axios');
const { Op } = require('sequelize');
const { enrichDayEndPayloadSales } = require('../services/sync/enrichDayEndPayload');

function resolveBranchId() {
  return String(process.env.ZRA_BHF_ID || '000').trim() || '000';
}

function resolveTerminalId() {
  return String(process.env.TERMINAL_ID || process.env.ZRA_TERMINAL_ID || '000').trim() || '000';
}

class SyncOutboxJob {
  constructor(models) {
    this.models = models;
    this.isRunning = false;
    this.cronJob = null;
    this.intervalCron = '*/1 * * * *';
    this.maxRetries = 100;
    this.baseDelayMinutes = 2;
    this.syncServerUrl = process.env.SYNC_SERVER_URL;
    this.syncServerToken = process.env.SYNC_SERVER_TOKEN;
  }

  shouldRetryForever(row) {
    return row.event_type === 'sale.created' || row.event_type === 'credit_note.created';
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
      // Two-step fetch to avoid MySQL filesort over the large `payload`/`response_payload`
      // JSON blobs (ER_OUT_OF_SORTMEMORY). First select only the light `id` column for the
      // ordered+limited scan, then load the full rows by PK.
      const candidates = await this.models.sync_outbox.findAll({
        attributes: ['id'],
        where: {
          status: ['pending', 'failed'],
          next_retry_at: { [Op.lte]: now }
        },
        order: [['id', 'ASC']],
        limit: 20,
        raw: true
      });

      const candidateIds = candidates.map((row) => row.id);
      let rows = [];
      if (candidateIds.length > 0) {
        rows = await this.models.sync_outbox.findAll({
          where: { id: { [Op.in]: candidateIds } }
        });
        rows.sort((left, right) => left.id - right.id);
      }

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

      let outboundPayload = {
        ...row.payload,
        branch_id: row.payload?.branch_id || resolveBranchId(),
        terminal_id: row.payload?.terminal_id || resolveTerminalId(),
      };

      if (row.event_type === 'day_end.ready') {
        outboundPayload = await enrichDayEndPayloadSales(this.models, outboundPayload);
      } else if (row.event_type === 'sale.created' || row.event_type === 'sale.updated') {
        outboundPayload.sale = {
          ...(row.payload?.sale || {}),
          branch_id: row.payload?.sale?.branch_id || row.payload?.branch_id || resolveBranchId(),
          terminal_id: row.payload?.sale?.terminal_id || row.payload?.terminal_id || resolveTerminalId(),
          zra_status: row.payload?.sale?.zra_status || null,
          zra_error: row.payload?.sale?.zra_error || null,
          receipt_printed: row.payload?.sale?.receipt_printed ?? null,
          qrcode_url: row.payload?.sale?.qrcode_url || null,
          qrfilepath: row.payload?.sale?.qrfilepath || null,
          receipt_no: row.payload?.sale?.receipt_no || null,
          sdcid: row.payload?.sale?.sdcid || null,
          receiptsig: row.payload?.sale?.receiptsig || null,
          intrldata: row.payload?.sale?.intrldata || null,
          vsdcrcpdate: row.payload?.sale?.vsdcrcpdate || null,
          invoice_no: row.payload?.sale?.invoice_no || null,
          invnumber: row.payload?.sale?.invnumber || null,
        };
      }

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
          payload: outboundPayload,
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
      const infiniteRetry = this.shouldRetryForever(row);
      const terminal = !infiniteRetry && attemptCount >= this.maxRetries;
      const nextRetry = terminal ? null : new Date(Date.now() + this.baseDelayMinutes * 60 * 1000);
      const status = terminal ? 'dead_letter' : 'failed';

      if (infiniteRetry && attemptCount > this.maxRetries) {
        console.warn(`SyncOutboxJob: still retrying high-priority event ${row.event_type} id=${row.id} after ${attemptCount} attempts`);
      }

      await row.update({
        status,
        attempt_count: attemptCount,
        last_error: error.message,
        response_payload: error.response?.data || null,
        next_retry_at: nextRetry,
        locked_at: null
      });
    }
  }
}

module.exports = SyncOutboxJob;