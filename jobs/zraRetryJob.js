const cron = require('node-cron');
const ZRAIntegrationService = require('../services/sale/generateSmartInvoice');

class ZraRetryJob {
  constructor(models) {
    this.models = models;
    this.isRunning = false;
    this.cronJob = null;
    this.intervalCron = '*/1 * * * *'; // every minute
    this.maxRetries = 3;
    this.baseDelayMinutes = 1; // fixed retry every minute
    this.zraService = new ZRAIntegrationService();
  }

  start() {
    if (this.cronJob) return;
    this.cronJob = cron.schedule(this.intervalCron, async () => {
      try {
        await this.run();
      } catch (e) {
        // swallow errors
      }
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
    this.isRunning = true;
    try {
      const now = new Date();
      const pending = await this.models.sale.findAll({
        where: {
          zra_status: ['pending', 'failed'],
          next_retry_at: { [this.models.sequelize.Op.lte]: now }
        },
        limit: 10,
        include: [
          { model: this.models.saleitem, as: 'items', include: [{ model: this.models.product, as: 'product' }] },
          { model: this.models.user, as: 'cashier' }
        ]
      });

      for (const s of pending) {
        await this.retryOne(s);
      }

      this.isRunning = false;
      return { success: true, processed: pending.length };
    } catch (err) {
      this.isRunning = false;
      return { success: false, error: err.message };
    }
  }

  async retryOne(saleInstance) {
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
        discount: saleInstance.discount || null,
      };

      const user = saleInstance.cashier || { store_id: null, id: saleInstance.user_id };

      const salesData = await this.zraService.transformToZRASalesData(saleDataForZRA, items, user);
      const response = await this.zraService.sendSalesData(salesData);

      if (response.success && response.data && response.data.data) {
        const d = response.data.data;
        const updates = {
          invnumber: salesData?.cisInvcNo || d.invoiceNo || d.invNumber || d.invnumber || null,
          receipt_no: d.rcptNo || null,
          sdcid: d.sdcId || null,
          receiptsig: d.rcptSign || null,
          intrldata: d.intrlData || null,
          qrcode_url: d.qrCodeUrl || null,
          vsdcrcpdate: d.vsdcRcptPbctDate || null,
          invoice_no: (d.sdcId && d.rcptNo) ? ("INV" + String(d.sdcId).substring(3) + "/" + d.rcptNo) : saleInstance.invoice_no,
          zra_status: 'sent',
          zra_error: null,
          last_retry_at: new Date(),
          next_retry_at: null
        };
        await saleInstance.update(updates);
        return { success: true };
      } else {
        await this.applyBackoff(saleInstance, response.error || 'Unknown ZRA error');
        return { success: false };
      }
    } catch (err) {
      await this.applyBackoff(saleInstance, err.message);
      return { success: false };
    }
  }

  async applyBackoff(saleInstance, errorMessage) {
    const retries = (saleInstance.retry_count || 0) + 1;
    const nextRetry = new Date(Date.now() + 1 * 60 * 1000); // always retry every minute
    const status = retries >= this.maxRetries ? 'failed' : 'pending';
    await saleInstance.update({
      retry_count: retries,
      last_retry_at: new Date(),
      next_retry_at: nextRetry,
      zra_status: status,
      zra_error: errorMessage?.toString().slice(0, 1000)
    });
  }
}

module.exports = ZraRetryJob;
