const cron = require('node-cron');
const ZRAIntegrationService = require('../services/sale/generateSmartInvoice');
const { buildSaleUpdatesFromZraResponse } = require('../services/sale/zraSaleResponse');
const CreditNoteZRAIntegrationService = require('../services/credit-note/generateSmartInvoiceCreditNote');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

async function generateQrCode(qrcodeUrl, receiptNo, saveDirectory) {
  if (!fs.existsSync(saveDirectory)) {
    fs.mkdirSync(saveDirectory, { recursive: true });
  }

  const fileName = `qrcode_${receiptNo}.png`;
  const filePath = path.resolve(saveDirectory, fileName);
  await QRCode.toFile(filePath, qrcodeUrl, { width: 150, margin: 2 });
  return filePath;
}

class ZraRetryJob {
  constructor(models) {
    this.models = models;
    this.isRunning = false;
    this.cronJob = null;
    this.intervalCron = '*/1 * * * *'; // every minute
    this.maxRetries = 3; // limit total retries to 3
    this.baseDelayMinutes = 2; // retry attempts scheduled 2 minutes after a failure
    this.zraService = new ZRAIntegrationService();
    this.creditNoteZraService = new CreditNoteZRAIntegrationService();
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

  async publishSaleStatusSync(saleInstance) {
    if (!this.models.sync_outbox) {
      return null;
    }

    const storeId = this.resolveSaleStoreId(saleInstance);
    if (!storeId) {
      console.warn(`ZraRetryJob: cannot queue central sync for sale ${saleInstance.id} without store id`);
      return null;
    }

    try {
      const payload = this.buildSaleSyncPayload(saleInstance);
      const existingOutbox = await this.models.sync_outbox.findOne({
        where: {
          event_type: 'sale.created',
          aggregate_type: 'sale',
          aggregate_id: String(saleInstance.id),
          store_id: storeId,
          status: { [this.models.Sequelize.Op.in]: ['pending', 'failed', 'dead_letter'] },
        },
      });

      if (existingOutbox) {
        return await existingOutbox.update({
          payload,
          status: 'pending',
          attempt_count: 0,
          next_retry_at: new Date(),
          last_error: null,
          response_payload: null,
        });
      }

      return await this.models.sync_outbox.create({
        event_type: 'sale.created',
        aggregate_type: 'sale',
        aggregate_id: String(saleInstance.id),
        store_id: storeId,
        user_id: saleInstance.user_id,
        receipt_number: saleInstance.receipt_number,
        idempotency_key: `sale.created:store-${storeId}:sale-${saleInstance.id}:zra-status:${Date.now()}`,
        payload,
        status: 'pending',
        attempt_count: 0,
        next_retry_at: new Date(),
      });
    } catch (error) {
      console.error('ZraRetryJob: failed to queue sale status sync:', error.message);
      return null;
    }
  }

  async run() {
    if (this.isRunning) return { skipped: true };
    this.isRunning = true;
    try {
      const now = new Date();
      const pending = await this.models.sale.findAll({
        where: {
          zra_status: ['pending'], // only pick records still pending retries
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

      const pendingCreditNotes = await this.models.creditnote.findAll({
        where: {
          zra_status: ['pending'],
          next_retry_at: { [this.models.sequelize.Op.lte]: now }
        },
        limit: 10,
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

      const salesData = await this.zraService.transformToZRASalesData(
        saleDataForZRA,
        items,
        user,
        saleInstance.invnumber || null
      );
      const response = await this.zraService.sendSalesData(salesData);

      if (response.success) {
        const zraResult = await buildSaleUpdatesFromZraResponse(saleInstance.invnumber, response);
        if (zraResult.success) {
          await saleInstance.update(zraResult.updates);
          await this.publishSaleStatusSync(saleInstance);
          return { success: true };
        }

        await this.applyBackoff(saleInstance, zraResult.error || 'Failed to apply ZRA response');
        return { success: false };
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
    const isTerminal = retries >= this.maxRetries;
    const nextRetry = isTerminal ? null : new Date(Date.now() + this.baseDelayMinutes * 60 * 1000);
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

  async retryCreditNote(creditNoteInstance) {
    try {
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
        product_id: item.product_id,
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
        total_price: Number(item.total_price),
        tax_exclusive_total: Number(item.total_price) / 1.16,
        product: item.product || null,
      }));

      const creditNoteData = {
        subtotal: Number(creditNoteInstance.subtotal || 0),
        discount_amount: Number(creditNoteInstance.discount_amount || 0),
        tax_amount: Number(creditNoteInstance.tax_amount || 0),
        total_amount: Number(creditNoteInstance.total_amount || 0),
        tax_rate: 16,
        payment_method: creditNoteInstance.payment_method,
        amount_paid: Number(creditNoteInstance.amount_paid || 0),
        change_amount: Number(creditNoteInstance.change_amount || 0),
        notes: creditNoteInstance.notes,
        customer: originalSale?.customer || creditNoteInstance.customer || null,
        discount: originalSale?.discount || null,
      };

      const user = creditNoteInstance.cashier || { store_id: null, id: creditNoteInstance.user_id };
      const originalInvoiceNo = originalSale?.invoice_no || originalSale?.receipt_no || originalSale?.receipt_number || String(originalSale?.id || creditNoteInstance.original_sale_id || creditNoteInstance.id);
      const reasonCode = creditNoteInstance.reason_code || '03';

      const salesData = await this.creditNoteZraService.transformToZRACreditNoteSalesData(
        creditNoteData,
        returnItems,
        user,
        reasonCode,
        originalInvoiceNo
      );

      const response = await this.creditNoteZraService.sendCreditNoteSalesData(salesData);

      if (response.success && response.data) {
        const d = response.data.data || response.data.resultData || response.data.result || response.data.responseData || response.data;
        let qrFilePath = creditNoteInstance.qrfilepath || null;

        if (d?.qrCodeUrl && d?.rcptNo) {
          try {
            qrFilePath = await generateQrCode(d.qrCodeUrl, d.rcptNo, './qrcodes');
          } catch (qrError) {
            console.error('QR generation failed for credit note retry:', qrError.message);
          }
        }

        await creditNoteInstance.update({
          invnumber: salesData?.cisInvcNo || d.invoiceNo || d.invNumber || d.invnumber || null,
          receipt_no: d.rcptNo || null,
          sdcid: d.sdcId || null,
          receiptsig: d.rcptSign || null,
          intrldata: d.intrlData || null,
          qrcode_url: d.qrCodeUrl || null,
          vsdcrcpdate: d.vsdcRcptPbctDate || null,
          invoice_no: (d.sdcId && d.rcptNo) ? (`CRN${String(d.sdcId).substring(3)}/${d.rcptNo}`) : creditNoteInstance.invoice_no,
          qrfilepath: qrFilePath,
          zra_status: 'sent',
          zra_error: null,
          last_retry_at: new Date(),
          next_retry_at: null,
        });

        return { success: true };
      }

      await this.applyCreditNoteBackoff(creditNoteInstance, response.error || 'Unknown ZRA error');
      return { success: false };
    } catch (err) {
      await this.applyCreditNoteBackoff(creditNoteInstance, err.message);
      return { success: false };
    }
  }

  async applyCreditNoteBackoff(creditNoteInstance, errorMessage) {
    const retries = (creditNoteInstance.retry_count || 0) + 1;
    const isTerminal = retries >= this.maxRetries;
    const nextRetry = isTerminal ? null : new Date(Date.now() + this.baseDelayMinutes * 60 * 1000);
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
