const express = require('express');
const { sale, saleitem, product, user, customer, discount, store, productinventory } = require('../models');
const auth = require('../middleware/auth');
const { Op, sequelize, fn, col, literal } = require('sequelize');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { annotateSalesWithReturnState } = require('../services/sales/returnState');
const { clearDashboardCache } = require('../services/reports/dashboardStats');
const { buildActorFromUser, logRequestAudit } = require('../services/auditLogService');
const { buildSaleReconstructionDetails } = require('../services/sale/saleReconstruction');

const router = express.Router();

function getModels(req) {
    return req.app.locals.models || require('../models');
}

// Import the correct ZRA Integration Service
const ZRAIntegrationService = require('../services/sale/generateSmartInvoice'); // Adjust path as needed
const { buildSaleUpdatesFromZraResponse } = require('../services/sale/zraSaleResponse');
const { writeZraSalesResponseLog } = require('../services/sale/zraFullResponseLogger');
const { buildListQueryFilters } = require('../services/query/listFilters');
const { sortRows } = require('../services/query/inMemorySort');
// Deprecated random receipt generator (kept for reference)
// const generateReceiptNumber = () => {
//     const now = new Date();
//     const timestamp = now.getTime().toString().slice(-8);
//     return `RCP${timestamp}`;
// };

// Generate invoice number from SDC ID and receipt number
function generateInvoiceNumber(sdcid, receipt_no) {
    return "INV" + sdcid.substring(3) + "/" + receipt_no;
}

// Generate QR Code and save to file
async function generateQrCode(qrcode_url, receiptNo, saveDirectory) {
    try {
        // Ensure the save directory exists
        if (!fs.existsSync(saveDirectory)) {
            fs.mkdirSync(saveDirectory, { recursive: true });
        }

        // Sanitize receiptNo for filename
        const fileName = `qrcode_${receiptNo}.png`;
        const filePath = path.resolve(saveDirectory, fileName);

        // Generate QR code and save to file
        await QRCode.toFile(filePath, qrcode_url, {
            width: 150,
            margin: 2,
        });

        console.log(`QR code saved to ${filePath}`);
        return filePath;
    } catch (err) {
        console.error('Error generating QR code:', err);
        throw err;
    }
}

function buildSaleSyncPayload(saleRecord) {
    const storeId = saleRecord.store_id || saleRecord.cashier?.store_id || null;

    return {
        branch_id: String(process.env.ZRA_BHF_ID || '000').trim() || '000',
        terminal_id: String(process.env.TERMINAL_ID || process.env.ZRA_TERMINAL_ID || '000').trim() || '000',
        sale: {
            id: saleRecord.id,
            receipt_number: saleRecord.receipt_number,
            user_id: saleRecord.user_id,
            store_id: storeId,
            branch_id: String(process.env.ZRA_BHF_ID || '000').trim() || '000',
            terminal_id: String(process.env.TERMINAL_ID || process.env.ZRA_TERMINAL_ID || '000').trim() || '000',
            customer_id: saleRecord.customer_id || null,
            discount_id: saleRecord.discount_id || null,
            subtotal: Number(saleRecord.subtotal || 0),
            discount_amount: Number(saleRecord.discount_amount || 0),
            tax_amount: Number(saleRecord.tax_amount || 0),
            total_amount: Number(saleRecord.total_amount || 0),
            payment_method: saleRecord.payment_method,
            amount_paid: Number(saleRecord.amount_paid || 0),
            change_amount: Number(saleRecord.change_amount || 0),
            notes: saleRecord.notes || null,
            payments_breakdown: saleRecord.payments_breakdown || null,
            sale_date: saleRecord.sale_date || new Date().toISOString(),
            invoice_no: saleRecord.invoice_no || null,
            invnumber: saleRecord.invnumber || null,
            receipt_no: saleRecord.receipt_no || null,
            sdcid: saleRecord.sdcid || null,
            receiptsig: saleRecord.receiptsig || null,
            intrldata: saleRecord.intrldata || null,
            qrcode_url: saleRecord.qrcode_url || null,
            vsdcrcpdate: saleRecord.vsdcrcpdate || null,
            zra_status: saleRecord.zra_status || null,
            zra_error: saleRecord.zra_error || null,
            receipt_printed: saleRecord.receipt_printed ?? null,
        },
        items: (saleRecord.items || []).map(item => ({
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
            }
        })),
        customer: saleRecord.customer || null,
        discount: saleRecord.discount || null,
    };
}

function normalizeZraSalesData(salesResponse) {
    const { normalizeZraSalesData: normalize } = require('../services/sale/zraSaleResponse');
    return normalize(salesResponse);
}

// Sales are synced to the central server via the day-end batch only (not per-sale).
async function requeueSaleSyncEvent(saleRecord) {
    console.log('[sales] requeueSaleSyncEvent skipped — sale sync is deferred to day-end batch', {
        saleId: saleRecord?.id,
        receiptNumber: saleRecord?.receipt_number,
    });
    return null;
}

async function processInitialZraSubmission({
    saleId,
    cisInvoiceNo,
    saleDataForZRA,
    saleItems,
    submittingUser,
    timeoutMs,
    source = 'sales.background_initial_submission',
}) {
    const startedAt = Date.now();
    const zraService = new ZRAIntegrationService();
    try {
        console.log('[sales] ZRA submission started', { saleId, source });
        const salesData = await zraService.transformToZRASalesData(
            saleDataForZRA,
            saleItems,
            submittingUser,
            cisInvoiceNo
        );
        const salesResponse = await zraService.sendSalesData(salesData, { timeoutMs });

        if (!salesResponse.success) {
            const error = typeof salesResponse.error === 'string'
                ? salesResponse.error
                : JSON.stringify(salesResponse.error || 'Unknown ZRA error');
            writeZraSalesResponseLog({
                source,
                logKind: 'current',
                saleId,
                cisInvoiceNo,
                outcome: 'zra_sales_failed',
                error,
                fullResponse: salesResponse,
            });
            await sale.update({
                zra_error: error,
                next_retry_at: new Date(Date.now() + 30 * 1000),
            }, { where: { id: saleId } });
            console.error('[sales] ZRA submission failed', {
                saleId,
                durationMs: Date.now() - startedAt,
                error,
            });
            return { success: false, error };
        }

        const zraResult = await buildSaleUpdatesFromZraResponse(
            cisInvoiceNo,
            salesResponse
        );
        if (!zraResult.success) {
            writeZraSalesResponseLog({
                source,
                logKind: 'current',
                saleId,
                cisInvoiceNo,
                outcome: 'zra_sales_missing_required_data',
                error: zraResult.error,
                normalizedResponse: zraResult.saveSalesData || null,
                fullResponse: salesResponse,
            });
            await sale.update({
                zra_error: zraResult.error,
                next_retry_at: new Date(Date.now() + 30 * 1000),
            }, { where: { id: saleId } });
            return { success: false, error: zraResult.error };
        }

        writeZraSalesResponseLog({
            source,
            logKind: 'current',
            saleId,
            cisInvoiceNo,
            outcome: salesResponse.sdcRecovery?.found
                ? 'zra_sales_recovered_from_sdc_sqlite'
                : 'zra_sales_sent',
            normalizedResponse: zraResult.saveSalesData || null,
            fullResponse: salesResponse,
        });
        await sale.update(zraResult.updates, { where: { id: saleId } });
        console.log('[sales] ZRA submission completed', {
            saleId,
            source,
            durationMs: Date.now() - startedAt,
            qrReady: !!zraResult.updates.qrfilepath,
        });

        // ZRA stock endpoints must follow a successful sales registration,
        // but they must never delay the cashier or receipt response.
        void processStockEndpointsInBackground(
            saleId,
            saleDataForZRA,
            saleItems,
            submittingUser,
            zraService
        );
        return { success: true, updates: zraResult.updates, recovered: !!salesResponse.sdcRecovery?.found };
    } catch (error) {
        const message = error?.message || String(error);
        writeZraSalesResponseLog({
            source,
            logKind: 'current',
            saleId,
            cisInvoiceNo,
            outcome: 'zra_sales_exception',
            error: message,
            fullResponse: error,
        });
        console.error('[sales] ZRA integration error', {
            saleId,
            source,
            durationMs: Date.now() - startedAt,
            error: message,
        });
        try {
            await sale.update({
                zra_error: message,
                next_retry_at: new Date(Date.now() + 30 * 1000),
            }, { where: { id: saleId } });
        } catch (updateError) {
            console.error('[sales] could not persist ZRA error', {
                saleId,
                error: updateError?.message || String(updateError),
            });
        }
        return { success: false, error: message };
    }
}

// Create new sale



router.post('/', auth, async (req, res) => {
    const requestStartedAt = Date.now();
    const t = await sale.sequelize.transaction();
    let committed = false;

    try {
        console.log(req.body)
        const {
            items, // [{ product_id, quantity, unit_price }]
            customer_id,
            discount_id,
            payment_method,
            amount_paid,
            payments, // optional: { cash: number, card: number, mobile_money: number }
            tax_rate = 16, // percentage
            notes
        } = req.body;

        const models = getModels(req);

        // Validate items
        if (!items || items.length === 0) {
            await t.rollback();
            await logRequestAudit(models, req, {
                action: 'sale.create',
                outcome: 'failure',
                entityType: 'sale',
                ...buildActorFromUser(req.user),
                details: { reason: 'Sale must have at least one item' },
            });
            return res.status(400).json({ message: 'Sale must have at least one item' });
        }

        // Validate user has store_id
        if (!req.user.store_id) {
            await t.rollback();
            await logRequestAudit(models, req, {
                action: 'sale.create',
                outcome: 'failure',
                entityType: 'sale',
                ...buildActorFromUser(req.user),
                details: { reason: 'User must be associated with a store' },
            });
            return res.status(400).json({ message: 'User must be associated with a store' });
        }

        // Calculate totals
        let subtotal = 0;
        const saleItems = [];

        // Fetch the catalog and store inventory in two queries instead of two
        // sequential queries per cart line. This keeps local checkout latency
        // predictable as basket size grows.
        const requestedProductIds = [...new Set(items.map(item => item.product_id))];
        const productRows = await product.findAll({
            where: { id: { [Op.in]: requestedProductIds } },
            transaction: t,
        });
        const inventoryRows = await productinventory.findAll({
            where: {
                product_id: { [Op.in]: requestedProductIds },
                store_id: req.user.store_id,
            },
            transaction: t,
        });
        const productsById = new Map(productRows.map(row => [String(row.id), row]));
        const inventoryByProductId = new Map(
            inventoryRows.map(row => [String(row.product_id), row])
        );

        // Validate and calculate each item - also fetch product details for ZRA
        for (const item of items) {
            const productData = productsById.get(String(item.product_id));

            if (!productData) {
                await t.rollback();
                await logRequestAudit(models, req, {
                    action: 'sale.create',
                    outcome: 'failure',
                    entityType: 'sale',
                    ...buildActorFromUser(req.user),
                    details: { reason: `Product with ID ${item.product_id} not found` },
                });
                return res.status(400).json({ message: `Product with ID ${item.product_id} not found` });
            }

            // Check stock from productinventory for the user's store
            const inventory = inventoryByProductId.get(String(item.product_id));

            // const availableQty = inventory ? inventory.stock_quantity : 0;

            // if (availableQty < item.quantity) {
            //     await t.rollback();
            //     await logRequestAudit(models, req, {
            //         action: 'sale.create',
            //         outcome: 'failure',
            //         entityType: 'sale',
            //         ...buildActorFromUser(req.user),
            //         details: {
            //             reason: `Insufficient stock for ${productData.name}`,
            //             product_id: item.product_id,
            //             requested_quantity: item.quantity,
            //             available_quantity: availableQty,
            //         },
            //     });
            //     return res.status(400).json({
            //         message: `Insufficient stock for ${productData.name}. Available: ${availableQty}`
            //     });
            // }

            // Determine effective price: store override if present, else product price (assumed tax-inclusive)
            const effectiveUnitPrice = inventory && inventory.price_override != null
                ? Number(inventory.price_override)
                : Number(productData.price);

            // If client didn't send unit_price, default to effective per-store price (tax-inclusive)
            const unit_price_inclusive = (item.unit_price == null || item.unit_price === '')
                ? effectiveUnitPrice
                : Number(item.unit_price);

            // Derive tax-exclusive values from tax-inclusive unit price
            const taxMultiplier = 1 + (Number(tax_rate) / 100);
            const unit_price_exclusive = unit_price_inclusive / taxMultiplier;

            const tax_exclusive_total = item.quantity * unit_price_exclusive;
            const tax_inclusive_total = item.quantity * unit_price_inclusive;

            subtotal += tax_exclusive_total; // Subtotal remains tax-exclusive for tax calculations

            // Include product data for ZRA integration and store inclusive for display/DB
            saleItems.push({
                product_id: item.product_id,
                quantity: item.quantity,
                unit_price: unit_price_inclusive, // Tax-inclusive unit price for display/storage
                total_price: tax_inclusive_total, // Tax-inclusive total for display/storage
                tax_exclusive_total: tax_exclusive_total, // Provide tax-exclusive total for integrations
                product: productData // Include full product data
            });
        }

        // Apply discount
        let discount_amount = 0;
        let discountData = null;
        if (discount_id) {
            discountData = await discount.findByPk(discount_id, { transaction: t });
            if (discountData && discountData.is_active) {
                if (discountData.type === 'percentage') {
                    discount_amount = (subtotal * discountData.value) / 100;
                } else {
                    discount_amount = discountData.value;
                }
            }
        }

        // Calculate tax and total
        const tax_amount = Math.round(((subtotal - discount_amount) * tax_rate) / 100 * 100) / 100;
        const total_amount = Math.round((subtotal - discount_amount + tax_amount) * 100) / 100;

        // Handle payments breakdown (mixed payments)
        const normalizeNum = (n) => {
            const v = Number(n);
            return isNaN(v) ? 0 : Math.max(0, v);
        };
        let payments_breakdown_obj = null;
        let effective_payment_method = payment_method;
        let effective_amount_paid = Number(amount_paid || 0);

        if (payments && typeof payments === 'object') {
            const bd = {
                cash: normalizeNum(payments.cash),
                card: normalizeNum(payments.card),
                mobile_money: normalizeNum(payments.mobile_money)
            };
            // Remove zero entries
            const entries = Object.entries(bd).filter(([k, v]) => v > 0);
            if (entries.length > 0) {
                payments_breakdown_obj = Object.fromEntries(entries);
                const sum = entries.reduce((s, [, v]) => s + v, 0);
                effective_amount_paid = Math.round(sum * 100) / 100;
                effective_payment_method = entries.length > 1 ? 'mixed' : entries[0][0];
            }
        }

        const change_amount = Math.round((effective_amount_paid - total_amount) * 100) / 100;



        if (change_amount < 0) {
            await t.rollback();
            await logRequestAudit(models, req, {
                action: 'sale.create',
                outcome: 'failure',
                entityType: 'sale',
                ...buildActorFromUser(req.user),
                details: {
                    reason: 'Insufficient payment amount',
                    total_amount,
                    amount_paid: effective_amount_paid,
                },
            });
            return res.status(400).json({ message: 'Insufficient payment amount' });
        }

        // Get customer data for ZRA
        let customerData = null;
        if (customer_id) {
            customerData = await customer.findByPk(customer_id, { transaction: t });
        }

        // Prepare sale data for ZRA integration
        const saleDataForZRA = {
            subtotal,
            discount_amount,
            tax_amount,
            total_amount,
            tax_rate,
            payment_method: effective_payment_method,
            amount_paid: effective_amount_paid,
            change_amount,
            notes: notes || null,
            payments_breakdown: payments_breakdown_obj,
            customer: customerData,
            discount: discountData,
        };

        // Initialize ZRA Integration Service (submission happens after local save)
        const zraService = new ZRAIntegrationService();

        console.log('Saving sale locally before ZRA submission...');

        // Helper to safely limit string lengths to avoid DB truncation errors
        const limitStr = (v, n) => (v == null ? null : String(v).slice(0, n));

        // Reserve receipt + CIS invoice numbers inside the transaction
        const { receiptNumber, cisInvoiceNo } =
            await zraService.generateSaleNumbers(req.user.store_id, t);

        // Create sale locally first so ZRA success can never be orphaned from our DB
        const newSale = await sale.create({
            receipt_number: receiptNumber,
            user_id: req.user.id,
            customer_id: customer_id || null,
            subtotal,
            discount_id: discount_id || null,
            discount_amount,
            tax_amount,
            total_amount,
            payment_method: effective_payment_method,
            amount_paid: effective_amount_paid,
            change_amount,
            notes: notes || null,
            payments_breakdown: payments_breakdown_obj,
            invnumber: limitStr(cisInvoiceNo, 50),
            receipt_no: null,
            sdcid: null,
            receiptsig: null,
            intrldata: null,
            qrcode_url: null,
            vsdcrcpdate: null,
            invoice_no: null,
            qrfilepath: null,
            zra_status: 'pending',
            zra_error: null,
            retry_count: 0,
            next_retry_at: new Date(Date.now() + 30 * 1000),
            last_retry_at: null,
        }, { transaction: t });

        console.log('Sale created successfully:', newSale.id);

        // Create all lines in one DB round trip, then apply local stock changes.
        await saleitem.bulkCreate(saleItems.map(item => ({
                sale_id: newSale.id,
                product_id: item.product_id,
                quantity: item.quantity,
                unit_price: item.unit_price,
                total_price: item.total_price
            })), { transaction: t });

        for (const item of saleItems) {
            // Update product stock
            await productinventory.update(
                {
                    stock_quantity: literal(`stock_quantity - ${item.quantity}`)
                },
                {
                    where: { product_id: item.product_id, store_id: req.user.store_id },
                    transaction: t
                }
            );

        }

        // Central sync is deferred to the day-end batch (`day_end.ready`), not per-sale.
        await t.commit();
        committed = true;
        clearDashboardCache(req.user.store_id);
        console.log('Transaction committed successfully');

        // The local transaction is still the safety boundary, but the first
        // cashier flow should attempt ZRA/SIDB immediately so receipt fields
        // are available without waiting for the retry job.
        const immediateZraResult = await processInitialZraSubmission({
            saleId: newSale.id,
            cisInvoiceNo,
            saleDataForZRA,
            saleItems,
            submittingUser: req.user,
            timeoutMs: Number(process.env.ZRA_INITIAL_SALES_TIMEOUT_MS || process.env.ZRA_SALES_TIMEOUT_MS || 8000),
            source: 'sales.initial_submission',
        });
        await newSale.reload();

        // Build the response from values already committed in this request.
        // Re-querying every association here adds latency and is unnecessary;
        // GET /sales/:id supplies the subsequently enriched ZRA fields.
        const salePlain = newSale.get({ plain: true });
        salePlain.items = saleItems.map(item => ({
            sale_id: newSale.id,
            product_id: item.product_id,
            quantity: item.quantity,
            unit_price: item.unit_price,
            total_price: item.total_price,
            product: item.product?.get
                ? item.product.get({ plain: true })
                : item.product,
        }));
        salePlain.cashier = {
            id: req.user.id,
            full_name: req.user.full_name,
        };
        salePlain.customer = customerData?.get
            ? customerData.get({ plain: true })
            : customerData;
        salePlain.discount = discountData?.get
            ? discountData.get({ plain: true })
            : discountData;
        salePlain.vsdc = {
            sdcId: salePlain.sdcid || salePlain.sdc_id || null,
            rcptNo: salePlain.receipt_no || salePlain.rcptNo || null,
            receiptSig: salePlain.receiptsig || salePlain.receipt_sig || null,
            intrlData: salePlain.intrldata || salePlain.intrlData || null,
            qrCodeUrl: salePlain.qrcode_url || salePlain.qrCodeUrl || null,
            vsdcRcpDate: salePlain.vsdcrcpdate || salePlain.vsdc_rcp_date || null
        };

        const auditEvent = {
            action: 'sale.create',
            outcome: 'success',
            entityType: 'sale',
            ...buildActorFromUser(req.user),
            target_identifier: receiptNumber,
            target_name: receiptNumber,
            details: {
                sale_id: newSale.id,
                receipt_number: receiptNumber,
                cis_invoice_no: cisInvoiceNo,
                total_amount,
                subtotal,
                tax_amount,
                discount_amount,
                payment_method: effective_payment_method,
                payments_breakdown: payments_breakdown_obj,
                item_count: saleItems.length,
                items: saleItems.map((item) => ({
                    product_id: item.product_id,
                    name: item.product?.name || null,
                    quantity: item.quantity,
                    unit_price: item.unit_price,
                    total_price: item.total_price,
                })),
                zra_status: salePlain.zra_status || 'pending',
                zra_error: salePlain.zra_error || null,
                receipt_no: salePlain.receipt_no || null,
                invoice_no: salePlain.invoice_no || null,
                immediate_zra_success: !!immediateZraResult?.success,
                recovered_from_sidb: !!immediateZraResult?.recovered,
            },
        };
        setImmediate(() => {
            logRequestAudit(models, req, auditEvent).catch(error => {
                console.error('[sales] sale audit write failed', {
                    saleId: newSale.id,
                    error: error?.message || String(error),
                });
            });
        });

        const processingTimeMs = Date.now() - requestStartedAt;
        res.setHeader('Server-Timing', `sale;dur=${processingTimeMs}`);
        res.status(201).json({
            message: salePlain.zra_status === 'sent'
                ? 'Sale completed and ZRA receipt data captured.'
                : 'Sale completed locally. ZRA registration is queued for retry.',
            sale: salePlain,
            processing_time_ms: processingTimeMs,
            zra_integration: {
                success: salePlain.zra_status === 'sent',
                queued: salePlain.zra_status !== 'sent',
                recovered_from_sidb: !!immediateZraResult?.recovered,
                sales_endpoint: {
                    success: salePlain.zra_status === 'sent',
                    message: salePlain.zra_status === 'sent'
                        ? 'Sales data submitted successfully to ZRA'
                        : 'ZRA submission did not return receipt data in the first flow; retry remains queued'
                }
            }
        });
        console.log('[sales] cashier response sent', {
            saleId: newSale.id,
            processingTimeMs,
            withinSixSecondTarget: processingTimeMs <= 6000,
        });

    } catch (error) {
        if (!committed) {
            await t.rollback();
        }
        console.error('Sale creation error:', error);

        const reconstructionDetails = buildSaleReconstructionDetails({
            items: saleItems || [],
            subtotal,
            tax_amount,
            total_amount,
            discount_amount,
            payment_method: effective_payment_method,
            amount_paid: effective_amount_paid,
            change_amount,
        });

        await logRequestAudit(getModels(req), req, {
            action: 'sale.create',
            outcome: 'failure',
            entityType: 'sale',
            ...buildActorFromUser(req.user),
            details: {
                reason: error.message,
                error_name: error.name || null,
                committed,
                reconstruction: reconstructionDetails,
            },
        });

        // Check if this is a ZRA-related error
        if (error.message && error.message.includes('ZRA')) {
            return res.status(500).json({
                message: 'ZRA integration error',
                error: error.message
            });
        }

        // Check for specific error types
        if (error.name === 'SequelizeValidationError') {
            return res.status(400).json({
                message: 'Validation error',
                errors: error.errors.map(e => e.message)
            });
        }

        if (error.name === 'SequelizeForeignKeyConstraintError') {
            return res.status(400).json({
                message: 'Invalid reference to related data'
            });
        }

        res.status(500).json({
            message: 'Server error',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * Process stock endpoints in background and create notifications if they fail
 * @param {number} saleId
 * @param {object} saleData
 * @param {array} items
 * @param {object} user
 * @param {ZRAIntegrationService} zraService
 */
async function processStockEndpointsInBackground(saleId, saleData, items, user, zraService) {
    const NotificationService = require('../services/NotificationService');
    const notificationService = new NotificationService();

    try {
        console.log('Processing stock endpoints in background for sale:', saleId);

        // Transform data for stock endpoints
        const stockItemsData = zraService.transformToZRAStockItemsData(saleData, items, user);
        const stockMasterData = await zraService.transformToZRAStockMasterData(items, user);

        // Process stock items endpoint
        const stockItemsResponse = await zraService.sendStockItemsData(stockItemsData);

        if (!stockItemsResponse.success) {
            console.error('Stock Items endpoint failed:', stockItemsResponse.error);

            await notificationService.createNotification({
                type: 'ZRA_STOCK_ITEMS_FAILED',
                title: 'ZRA Stock Items Update Failed',
                message: `Failed to update stock items in ZRA for sale #${saleId}. Error: ${stockItemsResponse.error}`,
                severity: 'warning',
                user_id: user.id,
                metadata: {
                    sale_id: saleId,
                    endpoint: 'saveStockItems',
                    error: stockItemsResponse.error
                }
            });
        } else {
            console.log('Stock Items endpoint successful for sale:', saleId);
        }

        // Process stock master endpoint
        const stockMasterResponse = await zraService.sendStockMasterData(stockMasterData);

        if (!stockMasterResponse.success) {
            console.error('Stock Master endpoint failed:', stockMasterResponse.error);

            await notificationService.createNotification({
                type: 'ZRA_STOCK_MASTER_FAILED',
                title: 'ZRA Stock Master Update Failed',
                message: `Failed to update stock master in ZRA for sale #${saleId}. Error: ${stockMasterResponse.error}`,
                severity: 'warning',
                user_id: user.id,
                metadata: {
                    sale_id: saleId,
                    endpoint: 'saveStockMaster',
                    error: stockMasterResponse.error
                }
            });
        } else {
            console.log('Stock Master endpoint successful for sale:', saleId);
        }

        // Create success notification if both stock endpoints succeeded
        if (stockItemsResponse.success && stockMasterResponse.success) {
            await notificationService.createNotification({
                type: 'ZRA_INTEGRATION_COMPLETE',
                title: 'ZRA Integration Complete',
                message: `All ZRA endpoints processed successfully for sale #${saleId}`,
                severity: 'success',
                user_id: user.id,
                metadata: {
                    sale_id: saleId,
                    all_endpoints_success: true
                }
            });
        }

    } catch (error) {
        console.error('Error in background stock processing:', error);

        await notificationService.createNotification({
            type: 'ZRA_BACKGROUND_ERROR',
            title: 'ZRA Background Processing Error',
            message: `An error occurred while processing ZRA stock endpoints for sale #${saleId}. Error: ${error.message}`,
            severity: 'error',
            user_id: user.id,
            metadata: {
                sale_id: saleId,
                error: error.message
            }
        });
    }
}

// Get all sales with pagination
router.get('/', auth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const filterStoreId = req.user.store_id;

        const whereClause = buildListQueryFilters(req, {
            dateField: 'sale_date',
            amountField: 'total_amount',
            searchFields: ['receipt_number', 'receipt_no', 'invoice_no', 'invnumber'],
        });

        const include = [
            { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
            { model: customer, as: 'customer' },
            { model: discount, as: 'discount' },
            { model: saleitem, as: 'items', include: [{ model: product, as: 'product' }] }
        ];

        console.log('[sales] list request', { page, limit, offset, store: filterStoreId, filters: whereClause });
        const { count, rows } = await sale.findAndCountAll({
            where: whereClause,
            limit,
            offset,
            order: [['sale_date', 'DESC']],
            include
        });
        console.log('[sales] db returned', { count, rowsReturned: rows.length, sampleFirst: rows[0] ? rows[0].sale_date : null });
        let sales = await annotateSalesWithReturnState(rows);
        console.log('[sales] after annotation, active count:', sales.filter(s => !s.is_fully_returned).length);

        // Normalize/augment each sale with a convenience `vsdc` object so clients
        // have the VSDC-related fields in one place (sdc id, rcpt no, sig, intrl, qr url, date)
        sales = sales.map(s => ({
            ...s,
            vsdc: {
                sdcId: s.sdcid || s.sdc_id || null,
                rcptNo: s.receipt_no || s.rcptNo || null,
                receiptSig: s.receiptsig || s.receipt_sig || null,
                intrlData: s.intrldata || s.intrlData || null,
                qrCodeUrl: s.qrcode_url || s.qrCodeUrl || null,
                vsdcRcpDate: s.vsdcrcpdate || s.vsdc_rcp_date || null
            }
        }));

        res.json({
            sales,
            pagination: {
                current_page: page,
                total_pages: Math.ceil(count / limit),
                total_records: count,
                per_page: limit
            }
        });

    } catch (error) {
        console.error('Get sales error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get sale by ID (for receipt generation)
router.get('/:id', auth, async (req, res) => {
    try {
        const saleData = await sale.findByPk(req.params.id, {
            include: [
                {
                    model: saleitem,
                    as: 'items',
                    include: [{ model: product, as: 'product' }]
                },
                { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'] },
                { model: customer, as: 'customer' },
                { model: discount, as: 'discount' }
            ]
        });
        if (!saleData) {
            return res.status(404).json({ message: 'Sale not found' });
        }
        // Users can only access sales for their own store (applies to cashiers and admins)
        if (req.user && (req.user.role === 'cashier' || req.user.role === 'admin')) {
            const cashierStoreId = saleData.cashier && saleData.cashier.store_id;
            if (!cashierStoreId || cashierStoreId !== req.user.store_id) {
                return res.status(403).json({ message: 'Access denied' });
            }
        }

        // Include convenience `vsdc` object on the returned sale
        const saleResponse = saleData && saleData.get ? saleData.get({ plain: true }) : (saleData || {});
        saleResponse.vsdc = {
            sdcId: saleResponse.sdcid || saleResponse.sdc_id || null,
            rcptNo: saleResponse.receipt_no || saleResponse.rcptNo || null,
            receiptSig: saleResponse.receiptsig || saleResponse.receipt_sig || null,
            intrlData: saleResponse.intrldata || saleResponse.intrlData || null,
            qrCodeUrl: saleResponse.qrcode_url || saleResponse.qrCodeUrl || null,
            vsdcRcpDate: saleResponse.vsdcrcpdate || saleResponse.vsdc_rcp_date || null
        };

        res.json({ sale: saleResponse });

    } catch (error) {
        console.error('Get sale by ID error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Mark a sale as receipt printed (idempotent)
router.post('/:id/mark-printed', auth, async (req, res) => {
    try {
        const id = req.params.id;
        const saleData = await sale.findByPk(id, {
            include: [
                { model: user, as: 'cashier', attributes: ['id', 'store_id'] }
            ]
        });
        if (!saleData) {
            return res.status(404).json({ message: 'Sale not found' });
        }
        // Enforce store access: cashiers/admins can only modify within their store
        if (req.user && (req.user.role === 'cashier' || req.user.role === 'admin')) {
            const cashierStoreId = saleData.cashier && saleData.cashier.store_id;
            if (!cashierStoreId || cashierStoreId !== req.user.store_id) {
                return res.status(403).json({ message: 'Access denied' });
            }
        }

        const wasPrinted = !!saleData.receipt_printed;
        if (!wasPrinted) {
            saleData.receipt_printed = true;
            await saleData.save();
        }
        return res.json({
            sale: saleData,
            updated: !wasPrinted,
            message: wasPrinted ? 'Already marked as printed' : 'Marked as printed'
        });
    } catch (error) {
        console.error('Mark printed error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get sales by date range
router.get('/report/date-range', auth, async (req, res) => {
    try {
        const { start_date, end_date } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        // Validate date format
        const startDate = new Date(start_date);
        const endDate = new Date(end_date);

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            return res.status(400).json({ message: 'Invalid date format' });
        }

        const filterStoreId = req.user.store_id;

        const include = [
            { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
            { model: customer, as: 'customer' }
        ];

        // Unbounded date-range scan: sort in JS to avoid a filesort over the large
        // sale TEXT/JSON columns (notes, zra_error, payments_breakdown).
        const sales = await sale.findAll({
            where: {
                sale_date: {
                    [Op.between]: [startDate, endDate]
                }
            },
            include
        });
        sortRows(sales, [['sale_date', 'DESC']]);

        const activeSales = (await annotateSalesWithReturnState(sales)).filter(s => !s.is_fully_returned);

        // Calculate summary
        const summary = {
            total_sales: activeSales.length,
            total_revenue: activeSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0),
            total_discounts: activeSales.reduce((sum, s) => sum + parseFloat(s.discount_amount || 0), 0),
            payment_methods: {}
        };

        // Group by payment method (allocate by payments_breakdown when available)
        activeSales.forEach(s => {
            const bd = s.payments_breakdown;
            if (bd && typeof bd === 'object') {
                Object.entries(bd).forEach(([method, amt]) => {
                    const key = method || 'unknown';
                    summary.payment_methods[key] = (summary.payment_methods[key] || 0) + Number(amt || 0);
                });
            } else {
                const method = s.payment_method || 'unknown';
                summary.payment_methods[method] = (summary.payment_methods[method] || 0) + parseFloat(s.total_amount || 0);
            }
        });

        res.json({
            sales: activeSales,
            summary,
            date_range: {
                start_date: start_date,
                end_date: end_date
            }
        });

    } catch (error) {
        console.error('Date range report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get daily sales summary
router.get('/report/daily', auth, async (req, res) => {
    try {
        const today = new Date();
        const startOfDay = new Date(today.setHours(0, 0, 0, 0));
        const endOfDay = new Date(today.setHours(23, 59, 59, 999));

        const isAdmin = req.user && req.user.role === 'admin';
        const filterStoreId = isAdmin ? (parseInt(req.query.store_id) || null) : req.user.store_id;
        const include = [
            { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) }
        ];

        const todaySales = await sale.findAll({
            where: {
                sale_date: {
                    [Op.between]: [startOfDay, endOfDay]
                }
            },
            include
        });

        const activeTodaySales = (await annotateSalesWithReturnState(todaySales)).filter(s => !s.is_fully_returned);

        const summary = {
            date: startOfDay.toDateString(),
            total_sales: activeTodaySales.length,
            total_revenue: activeTodaySales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0),
            total_discounts: activeTodaySales.reduce((sum, s) => sum + parseFloat(s.discount_amount || 0), 0),
            cash_sales: activeTodaySales.filter(s => s.payment_method === 'cash').length,
            card_sales: activeTodaySales.filter(s => s.payment_method === 'card').length,
            mobile_sales: activeTodaySales.filter(s => s.payment_method === 'mobile_money').length,
            payment_summary: (() => {
                const totals = { cash: 0, card: 0, mobile_money: 0 };
                activeTodaySales.forEach(s => {
                    const bd = s.payments_breakdown;
                    if (bd && typeof bd === 'object') {
                        Object.entries(bd).forEach(([method, amt]) => {
                            if (totals.hasOwnProperty(method)) {
                                totals[method] += Number(amt || 0);
                            }
                        });
                    } else if (totals.hasOwnProperty(s.payment_method)) {
                        totals[s.payment_method] += Number(s.total_amount || 0);
                    }
                });
                return totals;
            })()
        };

        res.json({ summary });

    } catch (error) {
        console.error('Daily report error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get dashboard statistics
router.get('/dashboard/stats', auth, async (req, res) => {
    try {
        const { computeDashboardStats } = require('../services/reports/dashboardStats');
        const data = await computeDashboardStats(req);
        res.json({ success: true, data, timestamp: new Date().toISOString() });
    } catch (error) {
        console.error('Dashboard stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load dashboard statistics',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// Get dashboard statistics with date filter (optional)
router.get('/dashboard/stats/:period', auth, async (req, res) => {
    try {
        const { period } = req.params; // 'today', 'week', 'month', 'year'

        let startDate, endDate;
        const now = new Date();

        switch (period) {
            case 'today':
                startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000 - 1);
                break;
            case 'week':
                startDate = new Date(now);
                startDate.setDate(now.getDate() - now.getDay());
                startDate.setHours(0, 0, 0, 0);
                endDate = new Date();
                break;
            case 'month':
                startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                endDate = new Date();
                break;
            case 'year':
                startDate = new Date(now.getFullYear(), 0, 1);
                endDate = new Date();
                break;
            default:
                return res.status(400).json({
                    success: false,
                    message: 'Invalid period. Use: today, week, month, or year'
                });
        }

        // Get sales for the specified period
        const filterStoreId = req.user.store_id;
        const include = [
            { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'], ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {}) },
            {
                model: saleitem,
                as: 'items',
                include: [{
                    model: product,
                    as: 'product',
                    attributes: ['name']
                }]
            }
        ];
        const periodSales = await sale.findAll({
            where: {
                sale_date: {
                    [Op.between]: [startDate, endDate]
                }
            },
            include
        });

        const activePeriodSales = (await annotateSalesWithReturnState(periodSales)).filter(s => !s.is_fully_returned);

        // Calculate statistics for the period
        const totalSales = activePeriodSales.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);
        const totalTransactions = activePeriodSales.length;
        const averageTransaction = totalTransactions > 0 ? totalSales / totalTransactions : 0;

        // Payment method breakdown
        const paymentMethods = {
            cash: 0,
            card: 0,
            mobile_money: 0
        };

        activePeriodSales.forEach(s => {
            const bd = s.payments_breakdown;
            if (bd && typeof bd === 'object') {
                Object.entries(bd).forEach(([method, amt]) => {
                    if (paymentMethods.hasOwnProperty(method)) {
                        paymentMethods[method] += Number(amt || 0);
                    }
                });
            } else if (paymentMethods.hasOwnProperty(s.payment_method)) {
                paymentMethods[s.payment_method] += parseFloat(s.total_amount || 0);
            }
        });

        res.json({
            success: true,
            period: period,
            date_range: {
                start: startDate.toISOString(),
                end: endDate.toISOString()
            },
            data: {
                totalSales,
                totalTransactions,
                averageTransaction,
                paymentMethods
            }
        });

    } catch (error) {
        console.error('Period stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load period statistics',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

router.patch('/:saleId/reprocess', auth, async (req, res) => {
    const saleId = Number(req.params.saleId);
    if (Number.isNaN(saleId)) {
        return res.status(400).json({ message: 'Invalid sale ID' });
    }

    console.log('[sales] reprocess request', {
        saleId,
        body: req.body,
        userId: req.user?.id,
        storeId: req.user?.store_id,
    });

    const allowedFields = [
        'invnumber', 'receipt_no', 'sdcid', 'receiptsig', 'intrldata', 'qrcode_url', 'vsdcrcpdate',
        'invoice_no', 'zra_status', 'zra_error', 'receipt_printed'
    ];

    const updates = {};
    for (const field of allowedFields) {
        if (Object.prototype.hasOwnProperty.call(req.body, field)) {
            updates[field] = req.body[field];
        }
    }

    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ message: 'No sale fields provided to update' });
    }

    if (updates.zra_status && !['pending', 'sent', 'failed'].includes(updates.zra_status)) {
        return res.status(400).json({ message: 'Invalid zra_status value' });
    }

    try {
        const saleRecord = await sale.findByPk(saleId, {
            include: [
                { model: saleitem, as: 'items', include: [{ model: product, as: 'product' }] },
                { model: user, as: 'cashier', attributes: ['id', 'store_id'] },
                { model: customer, as: 'customer' },
                { model: discount, as: 'discount' }
            ]
        });

        if (!saleRecord) {
            return res.status(404).json({ message: 'Sale not found' });
        }

        if (saleRecord.cashier.store_id !== req.user.store_id) {
            return res.status(403).json({ message: 'Access denied: sale does not belong to your store' });
        }

        await saleRecord.update(updates);
        let retryTriggered = false;
        if (updates.zra_status === 'pending') {
            await saleRecord.update({
                retry_count: 0,
                next_retry_at: new Date(),
                last_retry_at: null,
            });
            const zraRetryJob = req.app.locals.zraRetryJob;
            if (zraRetryJob) {
                retryTriggered = true;
                setImmediate(() => {
                    zraRetryJob.run().catch(error => {
                        console.error('[sales] manual ZRA retry failed:', error);
                    });
                });
            }
        }
        await requeueSaleSyncEvent(saleRecord);

        console.log('[sales] sale reprocess completed', {
            saleId,
            updatedFields: updates,
        });

        return res.status(200).json({
            message: 'Sale updated locally. Central sync will occur in the next day-end batch.',
            sale: saleRecord,
            retry_triggered: retryTriggered,
            next_retry_at: saleRecord.next_retry_at?.toISOString?.() || saleRecord.next_retry_at,
        });
    } catch (error) {
        console.error('Sale reprocess update failed:', error.message);
        return res.status(500).json({ message: 'Failed to reprocess sale', error: error.message });
    }
});

module.exports = router;
