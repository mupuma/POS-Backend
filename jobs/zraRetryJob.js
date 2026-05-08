const cron = require('node-cron');
const ZRAIntegrationService = require('../services/sale/generateSmartInvoice');
const logger = require('../utils/logger');

const siteId = process.env.SITE_ID || 'unknown-site';

class ZraRetryJob {
  constructor(models) {
    this.models = models;
    this.isRunning = false;
    this.cronJob = null;
    this.intervalCron = '*/1 * * * *'; // every minute
    this.maxRetries = 3; // limit total retries to 3
    this.baseDelayMinutes = 2; // retry attempts scheduled 2 minutes after a failure
    this.zraService = new ZRAIntegrationService();
  }

  start() {
    if (this.cronJob) return;

    logger.info('zra_retry_job_scheduled', {
      siteId,
      intervalCron: this.intervalCron,
      maxRetries: this.maxRetries,
      baseDelayMinutes: this.baseDelayMinutes
    });

    this.cronJob = cron.schedule(
      this.intervalCron,
      async () => {
        try {
          await this.run();
        } catch (e) {
          // swallow errors but log them
          logger.error('zra_retry_job_tick_error', {
            siteId,
            error: e.message,
            stack: e.stack
          });
        }
      },
      { scheduled: true, timezone: 'Africa/Lusaka' }
    );
  }

  stop() {
    if (this.cronJob) {
      logger.info('zra_retry_job_stopped', { siteId });
      this.cronJob.stop();
      this.cronJob = null;
    }
  }

  async run() {
    if (this.isRunning) {
      logger.info('zra_retry_job_skipped', {
        siteId,
        reason: 'already_running'
      });
      return { skipped: true };
    }

    this.isRunning = true;
    const startedAt = new Date();

    try {
      const now = new Date();
      const { Op } = this.models.Sequelize;

const pending = await this.models.sale.findAll({
  where: {
    zra_status: { [Op.in]: ['pending'] },
    next_retry_at: { [Op.lte]: now }
  },
  limit: 10,
  include: [
    {
      model: this.models.saleitem,
      as: 'items',
      include: [
        { model: this.models.product, as: 'product' }
      ]
    },
    { model: this.models.user, as: 'cashier' }
  ]
});


      logger.info('zra_retry_job_started', {
        siteId,
        pendingCount: pending.length,
        startedAt
      });

      for (const s of pending) {
        const attemptNo = (s.retry_count || 0) + 1;
        const result = await this.retryOne(s);

        logger.info('zra_retry_attempt_result', {
          siteId,
          saleId: s.id,
          invoiceNo: s.invoice_no,
          attemptNo,
          success: result.success === true
        });
      }

      const durationMs = Date.now() - startedAt.getTime();
      logger.info('zra_retry_job_finished', {
        siteId,
        processed: pending.length,
        durationMs
      });

      this.isRunning = false;
      return { success: true, processed: pending.length };
    } catch (err) {
      this.isRunning = false;
      const durationMs = Date.now() - startedAt.getTime();
      logger.error('zra_retry_job_failed', {
        siteId,
        error: err.message,
        stack: err.stack,
        durationMs
      });
      return { success: false, error: err.message };
    }
  }

  async retryOne(saleInstance) {
    const attemptNo = (saleInstance.retry_count || 0) + 1;

    try {
      const items = (saleInstance.items || []).map(i => ({
        product_id: i.product_id,
        quantity: Number(i.quantity),
        unit_price: Number(i.unit_price),
        total_price: Number(i.total_price),
        product: i.product || null
      }));

      const saleDataForZRA = {
        subtotal: Number(saleInstance.subtotal),
        discount_amount: Number(saleInstance.discount_amount || 0),
        tax_amount: Number(saleInstance.tax_amount || 0),
        total_amount: Number(saleInstance.total_amount),
        tax_rate: 16,
        payment_method: saleInstance.payment_method,
        amount_paid: Number(saleInstance.amount_paid),
        change_amount: Number(saleInstance.change_amount || 0),
        notes: saleInstance.notes,
        customer: saleInstance.customer || null,
        discount: saleInstance.discount || null
      };

      const user =
        saleInstance.cashier || { store_id: null, id: saleInstance.user_id };

      logger.info('zra_retry_attempt_started', {
        siteId,
        saleId: saleInstance.id,
        invoiceNo: saleInstance.invoice_no,
        attemptNo,
        storeId: user.store_id || null
      });

      const salesData = await this.zraService.transformToZRASalesData(
        saleDataForZRA,
        items,
        user
      );
      const response = await this.zraService.sendSalesData(salesData);

      if (response.success && response.data && response.data.data) {
        const d = response.data.data;
        const updates = {
          invnumber:
            salesData?.cisInvcNo ||
            d.invoiceNo ||
            d.invNumber ||
            d.invnumber ||
            null,
          receipt_no: d.rcptNo || null,
          sdcid: d.sdcId || null,
          receiptsig: d.rcptSign || null,
          intrldata: d.intrlData || null,
          qrcode_url: d.qrCodeUrl || null,
          vsdcrcpdate: d.vsdcRcptPbctDate || null,
          invoice_no:
            d.sdcId && d.rcptNo
              ? 'INV' + String(d.sdcId).substring(3) + '/' + d.rcptNo
              : saleInstance.invoice_no,
          zra_status: 'sent',
          zra_error: null,
          last_retry_at: new Date(),
          next_retry_at: null
        };
        await saleInstance.update(updates);

        logger.info('zra_retry_attempt_success', {
          siteId,
          saleId: saleInstance.id,
          invoiceNo: updates.invoice_no,
          attemptNo,
          cisInvcNo: salesData?.cisInvcNo || null
        });

        return { success: true };
      } else {
        const errorMsg = response.error || 'Unknown ZRA error';

        logger.warn('zra_retry_attempt_failed', {
          siteId,
          saleId: saleInstance.id,
          invoiceNo: saleInstance.invoice_no,
          attemptNo,
          error: errorMsg
        });

        await this.applyBackoff(saleInstance, errorMsg);
        return { success: false };
      }
    } catch (err) {
      logger.error('zra_retry_attempt_exception', {
        siteId,
        saleId: saleInstance.id,
        invoiceNo: saleInstance.invoice_no,
        attemptNo,
        error: err.message,
        stack: err.stack
      });

      await this.applyBackoff(saleInstance, err.message);
      return { success: false };
    }
  }

  async applyBackoff(saleInstance, errorMessage) {
    const currentRetries = saleInstance.retry_count || 0;
    const retries = currentRetries + 1;
    const isTerminal = retries >= this.maxRetries;
    const nextRetry = isTerminal
      ? null
      : new Date(Date.now() + this.baseDelayMinutes * 60 * 1000);
    const status = isTerminal ? 'failed' : 'pending';

    await saleInstance.update({
      retry_count: retries,
      last_retry_at: new Date(),
      next_retry_at: nextRetry,
      zra_status: status,
      zra_error: errorMessage?.toString().slice(0, 1000)
    });

    const logPayload = {
      siteId,
      saleId: saleInstance.id,
      invoiceNo: saleInstance.invoice_no,
      retries,
      status,
      isTerminal,
      nextRetryAt: nextRetry,
      error: errorMessage
    };

    if (isTerminal) {
      // important: sale has permanently failed to reach ZRA
      logger.error('zra_retry_terminal_failure', logPayload);
      // Optionally also send to central log endpoint (see section 2)
      if (typeof logger.sendToCentral === 'function') {
        logger.sendToCentral('error', 'zra_retry_terminal_failure', logPayload);
      }
    } else {
      logger.warn('zra_retry_backoff_scheduled', logPayload);
    }
  }
}

module.exports = ZraRetryJob;