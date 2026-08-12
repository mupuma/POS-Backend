const cron = require('node-cron');
const { Op } = require('sequelize');
const ZRAIntegrationService = require('../services/sale/generateSmartInvoice');
const { buildSaleUpdatesFromZraResponse, requiresComplianceRefresh } = require('../services/sale/zraSaleResponse');
const { writeZraSalesResponseLog } = require('../services/sale/zraFullResponseLogger');
const { submitCreditNoteToZra } = require('../services/credit-note/zraCreditNoteSubmission');
const {
  applyCreditNoteZraResult,
  logCreditNoteEvent,
  buildCreditNoteAuditDetails,
} = require('../services/credit-note/persistCreditNote');

class ZraRetryJob {
  constructor(models) {
    this.models = models;
    this.isRunning = false;
    this.cronJob = null;
    this.intervalCron = process.env.ZRA_RETRY_CRON || '*/15 * * * * *';
    // Zero means unlimited. Compliance submissions must not silently become
    // terminal after an arbitrary number of transient failures.
    this.maxRetries = Number(process.env.ZRA_MAX_RETRIES || 0);
    this.baseDelaySeconds = Number(process.env.ZRA_RETRY_BASE_DELAY_SECONDS || 30);
    this.maxDelayMinutes = Number(process.env.ZRA_RETRY_MAX_DELAY_MINUTES || 15);
    this.retryTimeoutMs = Number(process.env.ZRA_RETRY_TIMEOUT_MS || 30000);
    this.batchSize = Number(process.env.ZRA_RETRY_BATCH_SIZE || 25);
    this.zraService = new ZRAIntegrationService();
  }

  start() {
    if (this.cronJob) return;
    this.cronJob = cron.schedule(this.intervalCron, async () => {
      try {
        await this.run();
      } catch (e) {
        console.error('[zra-retry] scheduled run failed:', e);
      }
    }, { scheduled: true, timezone: 'Africa/Lusaka' });
  }

  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
  }

  resolveSaleStoreId(saleInstance) {
    return saleInstance.store_id || saleInstance.cashier?.store_id || null;
  }

  buildSaleSyncPayload(saleInstance) {
    const branchId = String(process.env.ZRA_BHF_ID || '000').trim() || '000';
    const terminalId = String(process.env.TERMINAL_ID || process.env.ZRA_TERMINAL_ID || '000').trim() || '000';
    const storeId = this.resolveSaleStoreId(saleInstance);

    return {
      branch_id: branchId,
      terminal_id: terminalId,
      sale: {
        id: saleInstance.id,
        receipt_number: saleInstance.receipt_number,
        user_id: saleInstance.user_id,
        store_id: storeId,
        branch_id: branchId,
        terminal_id: terminalId,
        customer_id: saleInstance.customer_id || null,
        discount_id: saleInstance.discount_id || null,
        subtotal: Number(saleInstance.subtotal || 0),
        discount_amount: Number(saleInstance.discount_amount || 0),
        tax_amount: Number(saleInstance.tax_amount || 0),
        total_amount: Number(saleInstance.total_amount || 0),
        payment_method: saleInstance.payment_method,
        amount_paid: Number(saleInstance.amount_paid || 0),
        change_amount: Number(saleInstance.change_amount || 0),
        notes: saleInstance.notes || null,
        payments_breakdown: saleInstance.payments_breakdown || null,
        sale_date: saleInstance.sale_date || new Date().toISOString(),
        invoice_no: saleInstance.invoice_no || null,
        invnumber: saleInstance.invnumber || null,
        receipt_no: saleInstance.receipt_no || null,
        sdcid: saleInstance.sdcid || null,
        receiptsig: saleInstance.receiptsig || null,
        intrldata: saleInstance.intrldata || null,
        qrcode_url: saleInstance.qrcode_url || null,
        qrfilepath: saleInstance.qrfilepath || null,
        vsdcrcpdate: saleInstance.vsdcrcpdate || null,
        zra_status: saleInstance.zra_status || null,
        zra_error: saleInstance.zra_error || null,
        receipt_printed: saleInstance.receipt_printed ?? null,
      },
      items: (saleInstance.items || []).map((item) => ({
        product_id: item.product_id,
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
        total_price: Number(item.total_price),
        tax_exclusive_total: Number(item.tax_exclusive_total || 0),
        product: {
          id: item.product?.id || null,
          name: item.product?.name || null,
          product_code: item.product?.product_code || null,
          formatted_product_code: item.product?.formatted_product_code || null,
          price: Number(item.product?.price || 0),
        },
      })),
      customer: saleInstance.customer || null,
      discount: saleInstance.discount || null,
    };
  }

  // Sales sync to central server via day-end batch only — no per-sale outbox events.
  async publishSaleStatusSync() {
    return null;
  }

  async run() {
    if (this.isRunning) return { skipped: true };
    this.isRunning = true;
    try {
      const now = new Date();
      const pending = await this.models.sale.findAll({
        where: {
          [Op.and]: [
            {
              [Op.or]: [
                { zra_status: { [Op.in]: ['pending', 'failed'] } },
                {
                  zra_status: 'sent',
                  [Op.or]: [
                    { receipt_no: null },
                    { sdcid: null },
                    { receiptsig: null },
                    { intrldata: null },
                  ],
                },
              ],
            },
            {
              [Op.or]: [
                { next_retry_at: { [Op.lte]: now } },
                { next_retry_at: null },
              ],
            },
          ],
        },
        limit: this.batchSize,
        order: [['next_retry_at', 'ASC'], ['id', 'ASC']],
        include: [
          { model: this.models.saleitem, as: 'items', include: [{ model: this.models.product, as: 'product' }] },
          { model: this.models.user, as: 'cashier' },
          { model: this.models.customer, as: 'customer' },
          { model: this.models.discount, as: 'discount' },
        ]
      });

      for (const s of pending) {
        await this.retryOne(s);
      }

      const pendingCreditNotes = await this.models.creditnote.findAll({
        where: {
          zra_status: { [Op.in]: ['pending', 'failed'] },
          [Op.or]: [
            { next_retry_at: { [Op.lte]: now } },
            { next_retry_at: null },
          ],
        },
        limit: this.batchSize,
        order: [['next_retry_at', 'ASC'], ['id', 'ASC']],
        include: [
          { model: this.models.creditnoteitem, as: 'items', include: [{ model: this.models.product, as: 'product' }] },
          { model: this.models.user, as: 'cashier' },
          { model: this.models.user, as: 'approver' },
          { model: this.models.customer, as: 'customer' },
        ]
      });

      for (const creditNoteInstance of pendingCreditNotes) {
        await this.retryCreditNote(creditNoteInstance);
      }

      this.isRunning = false;
      return { success: true, processed: pending.length + pendingCreditNotes.length };
    } catch (err) {
      this.isRunning = false;
      console.error('[zra-retry] run failed:', err);
      return { success: false, error: err.message };
    }
  }

  async retryOne(saleInstance) {
    try {
      if (!await this.claim(saleInstance)) {
        return { success: true, skipped: true };
      }
      if (!requiresComplianceRefresh(saleInstance)) {
        await saleInstance.update({
          zra_status: 'sent',
          zra_error: null,
          next_retry_at: null,
        });
        return { success: true, skipped: true, reason: 'compliance-complete' };
      }
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

      const salesData = await this.zraService.transformToZRASalesData(
        saleDataForZRA,
        items,
        user,
        saleInstance.invnumber || null
      );
      const response = await this.zraService.sendSalesData(salesData, {
        timeoutMs: this.retryTimeoutMs,
        logKind: 'retry',
      });

      if (response.success) {
        const zraResult = await buildSaleUpdatesFromZraResponse(saleInstance.invnumber, response);
        if (zraResult.success) {
          writeZraSalesResponseLog({
            source: 'zra_retry.sales',
            logKind: 'retry',
            saleId: saleInstance.id,
            receiptNumber: saleInstance.receipt_number,
            cisInvoiceNo: saleInstance.invnumber || null,
            outcome: response.sdcRecovery?.found
              ? 'zra_sales_recovered_from_sdc_sqlite'
              : 'zra_sales_sent',
            normalizedResponse: zraResult.saveSalesData || null,
            fullResponse: response,
          });
          await saleInstance.update(zraResult.updates);
          await this.publishSaleStatusSync(saleInstance);
          return { success: true };
        }

        writeZraSalesResponseLog({
          source: 'zra_retry.sales',
          logKind: 'retry',
          saleId: saleInstance.id,
          receiptNumber: saleInstance.receipt_number,
          cisInvoiceNo: saleInstance.invnumber || null,
          outcome: 'zra_sales_missing_required_data',
          error: zraResult.error,
          normalizedResponse: zraResult.saveSalesData || null,
          fullResponse: response,
        });
        await this.applyBackoff(saleInstance, zraResult.error || 'Failed to apply ZRA response');
        return { success: false };
      } else {
        writeZraSalesResponseLog({
          source: 'zra_retry.sales',
          logKind: 'retry',
          saleId: saleInstance.id,
          receiptNumber: saleInstance.receipt_number,
          cisInvoiceNo: saleInstance.invnumber || null,
          outcome: 'zra_sales_failed',
          error: response.error || 'Unknown ZRA error',
          fullResponse: response,
        });
        await this.applyBackoff(saleInstance, response.error || 'Unknown ZRA error');
        return { success: false };
      }
    } catch (err) {
      writeZraSalesResponseLog({
        source: 'zra_retry.sales',
        logKind: 'retry',
        saleId: saleInstance.id,
        receiptNumber: saleInstance.receipt_number,
        cisInvoiceNo: saleInstance.invnumber || null,
        outcome: 'zra_sales_exception',
        error: err.message,
        fullResponse: err,
      });
      await this.applyBackoff(saleInstance, err.message);
      return { success: false };
    }
  }

  async applyBackoff(saleInstance, errorMessage) {
    const retries = (saleInstance.retry_count || 0) + 1;
    const isTerminal = this.maxRetries > 0 && retries >= this.maxRetries;
    const nextRetry = isTerminal ? null : this.nextRetryDate(retries);
    const status = isTerminal ? 'failed' : 'pending';
    await saleInstance.update({
      retry_count: retries,
      last_retry_at: new Date(),
      next_retry_at: nextRetry,
      zra_status: status,
      zra_error: errorMessage?.toString().slice(0, 1000)
    });
    await this.publishSaleStatusSync(saleInstance);
  }

  nextRetryDate(retries) {
    const exponent = Math.min(Math.max(retries - 1, 0), 10);
    const delayMs = Math.min(
      this.baseDelaySeconds * (2 ** exponent) * 1000,
      this.maxDelayMinutes * 60 * 1000,
    );
    return new Date(Date.now() + delayMs);
  }

  async claim(instance) {
    const leaseMs = Math.max(this.retryTimeoutMs + 30000, 60000);
    const now = new Date();
    const [claimed] = await instance.constructor.update(
      {
        zra_status: 'pending',
        last_retry_at: now,
        next_retry_at: new Date(now.getTime() + leaseMs),
      },
      {
        where: {
          id: instance.id,
          [Op.and]: [
            {
              [Op.or]: [
                { zra_status: { [Op.in]: ['pending', 'failed'] } },
                {
                  zra_status: 'sent',
                  [Op.or]: [
                    { receipt_no: null },
                    { sdcid: null },
                    { receiptsig: null },
                    { intrldata: null },
                  ],
                },
              ],
            },
            {
              [Op.or]: [
                { next_retry_at: { [Op.lte]: now } },
                { next_retry_at: null },
              ],
            },
          ],
        },
      }
    );
    if (claimed === 0) return false;
    await instance.reload();
    return true;
  }

  async isMissingOriginalSaleZra(errorMessage) {
    return typeof errorMessage === 'string'
      && errorMessage.includes('Original sale is missing ZRA SDC id / receipt number');
  }

  async retryCreditNote(creditNoteInstance) {
    try {
      if (!await this.claim(creditNoteInstance)) {
        return { success: true, skipped: true };
      }
      const originalSaleId = creditNoteInstance.original_sale_id;
      const originalSale = originalSaleId
        ? await this.models.sale.findByPk(originalSaleId, {
            include: [
              { model: this.models.user, as: 'cashier' },
              { model: this.models.customer, as: 'customer' },
              { model: this.models.discount, as: 'discount' },
            ]
          })
        : null;

      const returnItems = (creditNoteInstance.items || []).map((item) => ({
        product_id: Number(item.product_id),
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
        total_price: Number(item.total_price),
        tax_exclusive_total: item.tax_exclusive_total != null
          ? Number(item.tax_exclusive_total)
          : Number(item.total_price) / 1.16,
        product: item.product || null,
      }));

      const user = creditNoteInstance.cashier || { store_id: null, id: creditNoteInstance.user_id };
      const reasonCode = creditNoteInstance.reason_code || '03';

      const result = await submitCreditNoteToZra({
        creditNoteInstance,
        originalSale,
        returnItems,
        user,
        reasonCode,
        timeoutMs: this.retryTimeoutMs,
      });

      if (result.success) {
        const persisted = await applyCreditNoteZraResult(this.models, creditNoteInstance.id, result);

        if (!persisted.zraFailed) {
          const reloaded = await this.models.creditnote.findByPk(creditNoteInstance.id, {
            include: [
              { model: this.models.creditnoteitem, as: 'items', include: [{ model: this.models.product, as: 'product' }] },
            ],
          });

          logCreditNoteEvent({
            action: 'credit_note.zra_retry',
            outcome: 'success',
            actor_user_id: user?.id || creditNoteInstance.user_id,
            actor_name: user?.full_name || null,
            store_id: user?.store_id || null,
            target_identifier: reloaded?.receipt_number,
            details: buildCreditNoteAuditDetails(reloaded, originalSale, { source: 'zra_retry_job' }),
          });

          return { success: true };
        }
      }

      if (result.pending && await this.isMissingOriginalSaleZra(result.error)) {
        const retries = (creditNoteInstance.retry_count || 0) + 1;
        await creditNoteInstance.update({
          retry_count: retries,
          zra_error: String(result.error).slice(0, 1000),
          zra_status: 'pending',
          last_retry_at: new Date(),
          next_retry_at: this.nextRetryDate(retries),
        });
        return { success: false };
      }

      const persisted = await applyCreditNoteZraResult(this.models, creditNoteInstance.id, result, { retryDelayMinutes: 2 });
      await this.applyCreditNoteBackoff(creditNoteInstance, persisted.zraError || 'ZRA did not return SDC data');
      return { success: false };
    } catch (err) {
      await this.applyCreditNoteBackoff(creditNoteInstance, err.message);
      return { success: false };
    }
  }

  async applyCreditNoteBackoff(creditNoteInstance, errorMessage) {
    const retries = (creditNoteInstance.retry_count || 0) + 1;
    const isTerminal = this.maxRetries > 0 && retries >= this.maxRetries;
    const nextRetry = isTerminal ? null : this.nextRetryDate(retries);
    const status = isTerminal ? 'failed' : 'pending';

    await creditNoteInstance.update({
      retry_count: retries,
      last_retry_at: new Date(),
      next_retry_at: nextRetry,
      zra_status: status,
      zra_error: errorMessage?.toString().slice(0, 1000),
    });
  }
}

module.exports = ZraRetryJob;
