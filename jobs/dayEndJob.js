const cron = require('node-cron');
const { Op } = require('sequelize');
const SageOrdersService = require('../services/sale/createSageOrder');
const SageCreditNotesService = require('../services/credit-note/sageOrderCreditNotes');
const {get} = require("axios");

/**
 * DayEndJob
 * - At 20:00 local time (Africa/Lusaka by default), checks if day-end has been completed for each store
 * - If not, performs a day-end sync and updates last_day_end_date
 */
class DayEndJob {
  constructor(models) {
    this.models = models;
    this.isRunning = false;
    this.cronJob = null;
    this.schedule = process.env.DAY_END_CRON || '0 20 * * *';
    this.timezone = process.env.TZ || 'Africa/Lusaka';
  }
async checkExistingOrder(storeLocation, orderDate) {
  const description = `${storeLocation} POS Sales - ${orderDate}`;
  const filter = `OrderDescription eq '${description}'`;
  const encodedFilter = encodeURIComponent(filter);

  const url = `${process.env.SAGE_BASE_URL}/OE/OEOrders?%24filter=${encodedFilter}`;
  const username = process.env.SAGE_USERNAME || 'ADMIN';
    const password = process.env.SAGE_PASSWORD || 'Admin123!';

    const auth = `${username}:${password}`;
    const encodedAuth = Buffer.from(auth, 'utf-8').toString('base64');
    const authorization = `Basic ${encodedAuth}`;
  try {
    const response = await get(url, {
      headers: {
        'Accept': 'application/json',
        'Authorization': authorization, // Use the same auth logic as POST
      }
    });
    // If response.data.value contains items, an order already exists
    return response.data.value && response.data.value.length > 0;
  } catch (error) {
    console.error('Error checking existing Sage order:', error);
    return false;
  }
}
  async performDayEndSync(storeInstance, todayStr) {
    const baseDate = todayStr ? new Date(todayStr) : new Date();
    if (isNaN(baseDate.getTime())) {
      throw new Error('Invalid date for day-end sync');
    }

    const startOfDay = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 23, 59, 59, 999);

    const { sale, saleitem, product, user, store, customer, discount, dayend, creditnote, creditnoteitem } = this.models;

    const storeId = storeInstance?.id || storeInstance?.store_id;
    if (!storeId) {
      throw new Error('Store not specified for day-end sync');
    }

    // Load all sales for day
    const salesForDay = await sale.findAll({
      where: { createdAt: { [Op.between]: [startOfDay, endOfDay] } },
      include: [
        { model: saleitem, as: 'items', include: [{ model: product }] },
        { model: user, as: 'cashier', where: { store_id: storeId }, required: true, include: [{ model: store }] },
        { model: customer, as: 'customer' },
        { model: discount, as: 'discount' },
      ],
      order: [['id', 'ASC']]
    });

    // Load all credit notes for day
    const creditNotesForDay = await creditnote.findAll({
      where: { createdAt: { [Op.between]: [startOfDay, endOfDay] } },
      include: [
        { model: creditnoteitem, as: 'items', include: [{ model: product }] },
        { model: user, as: 'cashier', where: { store_id: storeId }, required: true, include: [{ model: store }] },
        { model: customer, as: 'customer' },
      ],
      order: [['id', 'ASC']]
    });

    if ((!salesForDay || salesForDay.length === 0) && (!creditNotesForDay || creditNotesForDay.length === 0)) {
      // Mark this store as "no sales" so the job can return a specific state
      return {
        ok: true,
        noSales: true,
        detail: {
          message: 'No sales or credit notes for the day; nothing to create',
          storeId,
          date: todayStr,
          ordersAttempted: 0,
          ordersSucceeded: 0,
          salesProcessed: 0
        }
      };
    }

    const userInfoForDay = (salesForDay[0] || creditNotesForDay[0])?.cashier || null;

    const sageCreditNoteService = new SageCreditNotesService();

    const sageService = new SageOrdersService();
    const salesDataArray = salesForDay.map(saleRow => ({
      items: (saleRow.items || []).map(item => ({
        product_id: item.product_id,
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
        total_price: Number(item.total_price),
        product: item.product || null,
        product_code: item.product?.product_code
      })),
      salesData: {
        id: saleRow.id,
        receipt_number: saleRow.receipt_number,
        subtotal: Number(saleRow.subtotal),
        discount_amount: Number(saleRow.discount_amount || 0),
        tax_amount: Number(saleRow.tax_amount || 0),
        total_amount: Number(saleRow.total_amount),
        tax_rate: 16,
        payment_method: saleRow.payment_method,
        amount_paid: Number(saleRow.amount_paid),
        change_amount: Number(saleRow.change_amount || 0),
        notes: saleRow.notes,
        customer: saleRow.customer,
        discount: saleRow.discount,
        currency: 'ZMW'
      },
      receiptNumber: saleRow.receipt_number
    }));

    // Check if order already exists in Sage
    const utcDate = new Date().toISOString();
    const orderDate = todayStr ? new Date(todayStr).toISOString() : utcDate;
    const storeLocation = userInfoForDay?.store?.store_location || '';

    if (storeLocation && salesForDay.length > 0) {
      const exists = await this.checkExistingOrder(storeLocation, orderDate);
      if (exists) {
        console.log(`Sage OE Order already exists for ${storeLocation} on ${orderDate}. Skipping creation.`);
        // If it already exists, we can consider the OE part successful for the purpose of this job
        return {
          ok: true,
          detail: {
            storeId,
            date: todayStr,
            ordersAttempted: salesDataArray.length,
            ordersSucceeded: salesDataArray.length, // Already in Sage
            salesProcessed: salesDataArray.length,
            creditNotesProcessed: creditNotesForDay.length,
            sage: {
              status: 200,
              message: 'Order already exists in Sage',
              creditNoteStatus: 'skipped'
            }
          }
        };
      }
    }

    const sageResponse = await sageService.createConsolidatedOrder(salesDataArray, userInfoForDay, todayStr);

    if (!sageResponse || !sageResponse.success) {
      const errMsg = 'Day-end OE Order creation failed' + (sageResponse?.error ? `: ${sageResponse.error}` : '');
      console.log(errMsg, sageResponse);
      throw new Error(errMsg);
    }

    // Process credit notes
    let creditNoteResults = null;
    if (creditNotesForDay.length > 0) {
      const returnsDataArray = creditNotesForDay.map(cn => ({
        items: (cn.items || []).map(item => ({
          product_id: item.product_id,
          quantity: Number(item.quantity),
          unit_price: Number(item.unit_price),
          total_price: Number(item.total_price),
          product: item.product || null,
          formatted_product_code: item.product?.product_code
        })),
        total_amount: Number(cn.total_amount),
        customer: cn.customer,
        reference: cn.receipt_number,
        orderNumber: cn.invoice_no // Optional: if we have the original invoice/order number
      }));

      creditNoteResults = await sageCreditNoteService.createBatchCreditNotes(returnsDataArray, userInfoForDay, todayStr);

      if (!creditNoteResults || !creditNoteResults.success) {
        const errMsg = 'Day-end Credit Note creation failed' + (creditNoteResults?.error ? `: ${creditNoteResults.error}` : '');
      console.log(errMsg, creditNoteResults);
        // We might want to decide if we fail the whole job or just log it
        // For now, let's fail to ensure data consistency
        throw new Error(errMsg);
      }
    }

    return {
      ok: true,
      detail: {
        storeId,
        date: todayStr,
        ordersAttempted: salesDataArray.length,
        ordersSucceeded: salesDataArray.length,
        salesProcessed: salesDataArray.length,
        creditNotesProcessed: creditNotesForDay.length,
        sage: { 
          status: sageResponse.status,
          creditNoteStatus: creditNoteResults?.success ? 'success' : 'skipped'
        }
      }
    };
  }

async runOnce(triggeredBy = 'scheduled', forDate = null) {
  if (this.isRunning) {
    return { skipped: true, reason: 'Day-end job already running. Please wait.' };
  }

  this.isRunning = true;
  const startedAt = new Date();

  // Resolve target date string (YYYY-MM-DD)
  let targetDateStr;
  if (forDate instanceof Date) {
    if (isNaN(forDate.getTime())) {
      this.isRunning = false;
      return { skipped: true, reason: 'Invalid date provided' };
    }
    targetDateStr = forDate.toISOString().split('T')[0];
  } else if (typeof forDate === 'string' && forDate.trim()) {
    const d = new Date(forDate);
    if (isNaN(d.getTime())) {
      this.isRunning = false;
      return { skipped: true, reason: 'Invalid date provided' };
    }
    targetDateStr = d.toISOString().split('T')[0];
  } else {
    targetDateStr = new Date().toISOString().split('T')[0];
  }

  const results = { processed: 0, updated: 0, skipped: 0, salesProcessed: 0, errors: [] };
  let storesWithNoSales = 0;

  try {
    const stores = await this.models.store.findAll();

    if (!stores || stores.length === 0) {
      return { skipped: true, reason: 'No stores configured in system' };
    }

    for (const store of stores) {
      results.processed += 1;

      // Use the dayend table as the single source of truth for duplicate prevention.
      // Block if a successful or currently running day-end exists for this store and date.
      try {
        if (this.models.dayend) {
          const existingDayEnd = await this.models.dayend.findOne({
            where: { store_id: store.id, date: targetDateStr, status: ['success', 'running'] }
          });

          if (existingDayEnd) {
            results.skipped += 1;
            continue;
          }
        }
      } catch (_) {}

      try {
        let dayEndRec = null;
        const now = new Date();

        if (this.models.dayend) {
          dayEndRec = await this.models.dayend.findOne({
            where: { store_id: store.id, date: targetDateStr }
          });

          if (!dayEndRec) {
            dayEndRec = await this.models.dayend.create({
              store_id: store.id,
              date: targetDateStr,
              status: 'running',
              started_at: now,
              triggered_by: triggeredBy
            });
          } else {
            await dayEndRec.update({
              status: 'running',
              started_at: now,
              error_message: null,
              orders_attempted: null,
              orders_succeeded: null,
              triggered_by: triggeredBy
            });
          }
        }

        const r = await this.performDayEndSync(store, targetDateStr);

        if (r && r.ok) {
          if (r.noSales || (r.detail?.salesProcessed || 0) === 0) {
            storesWithNoSales += 1;
          }

          if (dayEndRec) {
            const finishedAt = new Date();
            const durationSeconds = Math.floor((finishedAt - now) / 1000);
            await dayEndRec.update({
              status: 'success',
              finished_at: finishedAt,
              duration_seconds: durationSeconds,
              orders_attempted: r.detail?.ordersAttempted ?? null,
              orders_succeeded: r.detail?.ordersSucceeded ?? null
            });
          } else if (this.models.dayend) {
            const finishedAt = new Date();
            const durationSeconds = Math.floor((finishedAt - now) / 1000);
            await this.models.dayend.create({
              store_id: store.id,
              date: targetDateStr,
              status: 'success',
              started_at: now,
              finished_at: finishedAt,
              duration_seconds: durationSeconds,
              triggered_by: triggeredBy,
              orders_attempted: r.detail?.ordersAttempted ?? null,
              orders_succeeded: r.detail?.ordersSucceeded ?? null
            });
          }

          results.updated += 1;
          results.salesProcessed += (r.detail?.salesProcessed || 0);
        } else {
          if (dayEndRec) {
            const finishedAt = new Date();
            const durationSeconds = Math.floor((finishedAt - now) / 1000);
            await dayEndRec.update({
              status: 'failed',
              finished_at: finishedAt,
              duration_seconds: durationSeconds,
              error_message: 'Day-end sync returned non-ok'
            });
          }
          results.errors.push({ store_id: store.id, error: 'Day-end sync returned non-ok' });
        }
      } catch (err) {
        try {
          if (this.models.dayend) {
            const rec = await this.models.dayend.findOne({
              where: { store_id: store.id, date: targetDateStr }
            });
            const finishedAt = new Date();
            const recStartedAt = rec?.started_at || finishedAt;
            const durationSeconds = Math.floor((finishedAt - recStartedAt) / 1000);

            if (rec) {
              await rec.update({
                status: 'failed',
                finished_at: finishedAt,
                duration_seconds: durationSeconds,
                error_message: err.message
              });
            } else {
              await this.models.dayend.create({
                store_id: store.id,
                date: targetDateStr,
                status: 'failed',
                started_at: finishedAt,
                finished_at: finishedAt,
                duration_seconds: 0,
                triggered_by: triggeredBy,
                error_message: err.message
              });
            }
          }
        } catch (_) {}
        results.errors.push({ store_id: store.id, error: err.message });
      }
    }

    const finishedAt = new Date();
    const durationSeconds = Math.floor((finishedAt - startedAt) / 1000);

    if (results.skipped === stores.length && results.updated === 0 && results.errors.length === 0) {
      return {
        skipped: true,
        reason: `Day-end already completed for ${targetDateStr}`,
        date: targetDateStr,
        ...results
      };
    }

    const processedStores = results.processed - results.skipped;
    const noSales = processedStores > 0 &&
      storesWithNoSales === processedStores &&
      results.salesProcessed === 0 &&
      results.errors.length === 0;

    return {
      success: results.errors.length === 0,
      noSales,
      triggeredBy,
      date: targetDateStr,
      durationSeconds,
      ...results
    };
  } finally {
    this.isRunning = false;
  }
}
  start() {
    if (this.cronJob) return;

    this.cronJob = cron.schedule(this.schedule, async () => {
      try {
        await this.runOnce('scheduled');
      } catch (e) {
        console.error('DayEndJob scheduled run failed:', e.message);
      }
    }, {
      scheduled: true,
      timezone: this.timezone
    });
  }

  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
  }
}

module.exports = DayEndJob;