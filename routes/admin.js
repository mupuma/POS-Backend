const express = require('express');
const { sale, saleitem, product, user, customer, discount, store, creditnote, creditnoteitem, productinventory, sync_outbox } = require('../models');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');
const axios = require('axios');
const router = express.Router();
const authMiddleware = auth;

const ZraRetryJob = require('../jobs/zraRetryJob');

const ZRAIntegrationServiceStockDisposal = require("../services/stock-disposal/zraEndPoints");
const SageInternalUsage = require("../services/stock-disposal/sageInternalUsages");
const { createDayEndOutboxEvent, createCreditNoteBatchOutboxEvent } = require('../services/day-end/createDayEndOutboxEvent');
const { deleteProtectedLogs } = require('../services/protectedLogDeletion');
const { writeAuditLog } = require('../services/auditLogService');

function parseYmdDate(rawValue) {
    const match = String(rawValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
        return null;
    }

    const [, year, month, day] = match;
    const parsed = new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }

    if (parsed.getFullYear() !== Number(year) || parsed.getMonth() !== Number(month) - 1 || parsed.getDate() !== Number(day)) {
        return null;
    }

    return parsed;
}

function formatYmdDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatAggregateIdDate(aggregateId) {
    const value = String(aggregateId || '').padStart(8, '0');
    if (!/^\d{8}$/.test(value)) {
        return null;
    }

    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function buildDayEndHistoryMessage(outboxRow) {
    if (!outboxRow) {
        return 'Day-end not yet queued';
    }

    if (outboxRow.status === 'sent') {
        return null;
    }

    if (outboxRow.status === 'pending') {
        return 'Queued for sync';
    }

    if (outboxRow.status === 'sending') {
        return 'Sync in progress';
    }

    if (outboxRow.status === 'dead_letter') {
        return outboxRow.last_error || 'Sync failed after maximum retries';
    }

    if (outboxRow.status === 'failed') {
        return outboxRow.last_error || 'Last sync attempt failed';
    }

    return `Current status: ${outboxRow.status}`;
}

router.delete('/logs', authMiddleware, async (req, res) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ message: 'Only admins can delete POS log files' });
    }

    try {
        const result = deleteProtectedLogs({
            password: req.body?.developerPassword || req.headers['x-developer-password'],
            date: req.body?.date || req.query.date,
            category: req.body?.category || req.query.category,
            fileName: req.body?.fileName || req.query.fileName,
            all: req.body?.all === true || req.query.all === 'true',
        });

        await writeAuditLog(req.app.locals.models, {
            action: 'logs.delete',
            entityType: 'log_file',
            outcome: 'success',
            actor_user_id: req.user.id || null,
            actor_identifier: req.user.username || null,
            actor_name: req.user.full_name || null,
            actor_role: req.user.role || null,
            store_id: req.user.store_id || null,
            ip_address: req.ip || req.socket?.remoteAddress || null,
            user_agent: req.headers['user-agent'] || null,
            details: {
                deletedCount: result.deletedCount,
                deleted: result.deleted,
                logRoot: result.logRoot,
                date: req.body?.date || req.query.date || null,
                category: req.body?.category || req.query.category || null,
                fileName: req.body?.fileName || req.query.fileName || null,
                all: req.body?.all === true || req.query.all === 'true',
            },
        });

        return res.json({
            success: true,
            ...result,
        });
    } catch (error) {
        await writeAuditLog(req.app.locals.models, {
            action: 'logs.delete',
            entityType: 'log_file',
            outcome: 'failure',
            actor_user_id: req.user.id || null,
            actor_identifier: req.user.username || null,
            actor_name: req.user.full_name || null,
            actor_role: req.user.role || null,
            store_id: req.user.store_id || null,
            ip_address: req.ip || req.socket?.remoteAddress || null,
            user_agent: req.headers['user-agent'] || null,
            details: { reason: error.message },
        });

        const status = /password/i.test(error.message) ? 403 : 400;
        return res.status(status).json({ success: false, message: error.message });
    }
});

/**
 * Creates internal usage for disposed stock
 */
async function createInternalUsageForDisposal(disposalItems, user, usageAccount = '') {
    try {
        const sageService = new SageInternalUsage();

        // Generate a unique usage number for the disposal
        const timestamp = Date.now();
        const usageNumber = `DISPOSAL-${timestamp}`;

        // Prepare disposal data for internal usage
        const usageDataArray = [{
            items: disposalItems.map(item => ({
                product_id: item.product_id,
                quantity: Number(item.quantity),
                unit_cost: Number(item.unit_cost || item.product?.price || 0),
                total_price: Number(item.total_price),
                product: item.product || null,
                product_code: item.product?.product_code,
                product_name: item.product?.name
            })),
            usageNumber: usageNumber,
            employeeNumber: user?.employee_number || '',
            usageAccount: usageAccount || 'DISPOSAL'
        }];

        const sageResponse = await sageService.createConsolidatedInternalUsageBatch(usageDataArray, user);

        if (!sageResponse.success) {
            console.error('Internal usage creation for disposal failed:', sageResponse.error);
            return {
                success: false,
                error: sageResponse.error || 'Failed to create internal usage for disposal in Sage system'
            };
        }

        return {
            success: true,
            data: sageResponse.data,
            usageNumber: usageNumber,
            itemsProcessed: sageResponse.itemsProcessed,
            usagesProcessed: sageResponse.usagesProcessed
        };
    } catch (error) {
        console.error('Error creating internal usage for disposal:', error);
        return {
            success: false,
            error: 'Error occurred while creating internal usage for disposal'
        };
    }
}

// Day-end sync: process and display data from the last completed day-end date up to the selected date (default: today)
/*
router.post('/day-end-sync', auth, async (req, res) => {
    try {
        const { date, includeShipment = true, includeInvoice = true } = req.body || {};
        // ... OLD MULTI-FLOW DAY-END LOGIC (shipments, AR invoices, credit notes) ...
        // The original implementation has been commented out per requirement to only create OE Orders.
    } catch (err) {
        console.error('Day-end sync error:', err);
        return res.status(500).json({
            message: 'Failed to complete day-end sync',
            error: err.message
        });
    }
});
*/

// Queue a day-end event for the selected day instead of calling Sage inline
router.post('/day-end-sync', auth, async (req, res) => {
    try {
        const { date } = req.body || {};

        // Determine date (default: today)
        let dateString;
        if (date) {
            const match = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (!match) {
                return res.status(400).json({ message: 'Invalid date. Use YYYY-MM-DD.' });
            }

            const [ , year, month, day ] = match;
            const baseDate = new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);
            if (isNaN(baseDate.getTime())) {
                return res.status(400).json({ message: 'Invalid date. Use YYYY-MM-DD.' });
            }

            dateString = `${year}-${month}-${day}`;
        } else {
            const baseDate = new Date();
            if (isNaN(baseDate.getTime())) {
                return res.status(400).json({ message: 'Invalid date. Use YYYY-MM-DD.' });
            }

            const year = baseDate.getFullYear();
            const month = String(baseDate.getMonth() + 1).padStart(2, '0');
            const day = String(baseDate.getDate()).padStart(2, '0');
            dateString = `${year}-${month}-${day}`;
        }

        if (!dateString) {
            return res.status(400).json({ message: 'Invalid date. Use YYYY-MM-DD.' });
        }

        // Ensure user is scoped to a store
        const storeId = req.user?.store_id;
        if (!storeId) {
            return res.status(400).json({ message: 'Authenticated user is not assigned to a store.' });
        }

        const models = req.app.locals.models || require('../models');
        const queueResult = await createDayEndOutboxEvent(models, {
            storeId,
            userId: req.user.id,
            dateString,
        });

        // Credit notes are batched and posted to Sage exactly like sales: as a single
        // daily consolidated document, instead of one Sage document per credit note.
        const creditNoteResult = await createCreditNoteBatchOutboxEvent(models, {
            storeId,
            userId: req.user.id,
            dateString,
        });

        const salesQueued = Boolean(queueResult.queued);
        const creditNotesQueued = Boolean(creditNoteResult.queued);

        if (!salesQueued && !creditNotesQueued) {
            return res.status(200).json({
                message: `No sales or credit notes found on ${dateString} for store. Nothing queued.`,
                date: dateString,
                result: {
                    success: true,
                    queued: false,
                    salesCount: 0,
                    creditNotesCount: 0,
                }
            });
        }

        if (req.app.locals.syncOutboxJob && typeof req.app.locals.syncOutboxJob.run === 'function') {
            req.app.locals.syncOutboxJob.run().catch((error) => {
                console.error('Failed to trigger sync outbox job after day-end queue:', error.message);
            });
        }

        return res.json({
            message: `Day-end queued for ${dateString}`,
            date: dateString,
            totalSales: queueResult.payload?.sales_count || 0,
            totalCreditNotes: creditNoteResult.payload?.credit_notes_count || 0,
            result: {
                success: true,
                queued: true,
                sales: {
                    queued: salesQueued,
                    created: queueResult.created,
                    outboxId: queueResult.outboxId,
                    idempotencyKey: queueResult.idempotencyKey,
                },
                creditNotes: {
                    queued: creditNotesQueued,
                    created: creditNoteResult.created,
                    outboxId: creditNoteResult.outboxId,
                    idempotencyKey: creditNoteResult.idempotencyKey,
                },
                events: [
                    ...(queueResult.events || []),
                    ...(creditNoteResult.events || []),
                ],
            }
        });
    } catch (err) {
        console.error('Day-end queue error:', err);
        return res.status(500).json({
            message: 'Failed to queue day-end sync',
            error: err.message
        });
    }
});

router.get('/day-end-history', auth, async (req, res) => {
    try {
        const startDate = parseYmdDate(req.query.start);
        const endDate = parseYmdDate(req.query.end);

        if (!startDate || !endDate) {
            return res.status(400).json({ message: 'Invalid date range. Use start and end in YYYY-MM-DD format.' });
        }

        if (startDate > endDate) {
            return res.status(400).json({ message: 'Start date cannot be after end date.' });
        }

        if (!req.user?.store_id) {
            return res.status(400).json({ message: 'Authenticated user is not assigned to a store.' });
        }

        const startOfRange = new Date(startDate);
        const endOfRange = new Date(endDate);
        endOfRange.setHours(23, 59, 59, 999);

        const salesRows = await sale.findAll({
            attributes: ['id', 'createdAt'],
            where: {
                createdAt: { [Op.between]: [startOfRange, endOfRange] },
            },
            include: [{
                model: user,
                as: 'cashier',
                attributes: ['id', 'store_id'],
                where: { store_id: req.user.store_id },
                required: true,
            }],
            order: [['createdAt', 'ASC']],
        });

        // NOTE: We intentionally do NOT sort in SQL here. The `payload` column is a
        // large JSON/TEXT blob, and an ORDER BY forces MySQL's filesort to buffer the
        // full row (including payload) which can overflow sort_buffer_size and throw
        // ER_OUT_OF_SORTMEMORY (errno 1038). The result set is at most one row per day,
        // so we sort in JS below instead.
        const outboxRows = await sync_outbox.findAll({
            attributes: ['id', 'aggregate_id', 'payload', 'status', 'last_error', 'sent_at', 'updated_at'],
            where: {
                store_id: req.user.store_id,
                event_type: 'day_end.ready',
                aggregate_id: {
                    [Op.between]: [
                        Number(formatYmdDate(startDate).replace(/-/g, '')),
                        Number(formatYmdDate(endDate).replace(/-/g, '')),
                    ],
                },
            },
        });

        outboxRows.sort((left, right) => {
            const leftUpdated = new Date(left.updated_at).getTime();
            const rightUpdated = new Date(right.updated_at).getTime();
            if (rightUpdated !== leftUpdated) {
                return rightUpdated - leftUpdated;
            }
            return right.id - left.id;
        });

        const datesWithSales = new Set(
            salesRows.map((row) => formatYmdDate(new Date(row.createdAt)))
        );
        const outboxByDate = new Map();

        for (const row of outboxRows) {
            const rowDate = row.payload?.date || formatAggregateIdDate(row.aggregate_id);
            if (!rowDate || outboxByDate.has(rowDate)) {
                continue;
            }

            outboxByDate.set(rowDate, row);
        }

        const historyDates = Array.from(new Set([
            ...datesWithSales,
            ...outboxByDate.keys(),
        ])).sort((left, right) => right.localeCompare(left));

        const history = historyDates.map((dateString) => {
            const outboxRow = outboxByDate.get(dateString) || null;
            return {
                date: dateString,
                completed: outboxRow?.status === 'sent',
                message: buildDayEndHistoryMessage(outboxRow),
            };
        });

        return res.json(history);
    } catch (error) {
        console.error('Day-end history error:', error);
        return res.status(500).json({ message: 'Failed to load day-end history', error: error.message });
    }
});
// Zero out all stock (admin only)
router.post('/zero-stock', auth, async (req, res) => {
    try {
        // Check if user is admin
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can zero out stock' });
        }

        // Get the full user object for ZRA integration
        const fullUser = await user.findByPk(req.user.id);
        if (!fullUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Initialize ZRA service
        const zraService = new ZRAIntegrationServiceStockDisposal();

        // Get all products with inventory for the user's store
        const productsWithInventory = await productinventory.findAll({
            where: {
                store_id: req.user.store_id,
                stock_quantity: { [require('sequelize').Op.gt]: 0 } // Only products with stock > 0
            },
            include: [{
                model: product,
                as: 'product',
                attributes: ['id', 'name', 'product_code', 'product_class_code', 'price']
            }]
        });

        if (productsWithInventory.length === 0) {
            return res.status(200).json({
                success: true,
                message: 'No products with stock to zero out',
                zraResults: {}
            });
        }

        // Calculate total amount for disposal
        const totalAmount = productsWithInventory.reduce((sum, inventory) => {
            return sum + (inventory.product.price * inventory.stock_quantity);
        }, 0);

        const disposalData = {
            total_amount: totalAmount,
            tax_rate: 16 // Default VAT rate
        };

        // Format items for ZRA - treating current stock as quantities to dispose
        const disposalItems = productsWithInventory.map(inventory => ({
            product_id: inventory.product.id,
            product: inventory.product,
            quantity: inventory.stock_quantity,
            total_price: inventory.product.price * inventory.stock_quantity,
            tax_exclusive_total: null // Will be calculated in transform method
        }));

        // Transform data using the discarding method
        const stockItemsData = zraService.transformToZRAStockItemsDataDiscarding(
            disposalData,
            disposalItems,
            fullUser
        );

        // Create stock master data with zero remaining quantities
        const stockMasterData = zraService.transformToZRAStockMasterData(
            disposalItems,
            fullUser,
            0 // Remaining quantity after zeroing out
        );

        // Send data to ZRA and create internal usage for disposal
        const [stockItemsResult, stockMasterResult, internalUsageResult] = await Promise.all([
            zraService.sendStockItemsData(stockItemsData),
            zraService.sendStockMasterData(stockMasterData),
           // createInternalUsageForDisposal(disposalItems, fullUser, 'DISPOSAL')
        ]);

        // Check if ZRA calls were successful
        if (!stockItemsResult.success || !stockMasterResult.success) {
            return res.status(500).json({
                success: false,
                error: 'ZRA submission failed',
                results: {
                    stockItems: stockItemsResult,
                    stockMaster: stockMasterResult,
                    internalUsage: internalUsageResult
                }
            });
        }

        /* Check if internal usage was successful
        if (!internalUsageResult.success) {
            return res.status(500).json({
                success: false,
                error: 'Internal usage creation failed',
                results: {
                    stockItems: stockItemsResult,
                    stockMaster: stockMasterResult,
                    internalUsage: internalUsageResult
                }
            });
        }*/

        // Update local inventory to zero only if both ZRA submission and internal usage were successful
        await productinventory.update(
            { stock_quantity: 0 },
            {
                where: {
                    store_id: req.user.store_id,
                    stock_quantity: { [require('sequelize').Op.gt]: 0 }
                }
            }
        );

        return res.status(200).json({
            success: true,
            message: `Successfully zeroed out stock for ${productsWithInventory.length} products`,
            productsAffected: productsWithInventory.length,
           
            totalValueDisposed: totalAmount,
            zraResults: {
                stockItems: stockItemsResult,
                stockMaster: stockMasterResult
            }
        });

    } catch (error) {
        console.error('Zero stock error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to zero out stock',
            details: error.message
        });
    }
});
// Replenish stock (admin only)
router.post('/replenish-stock', auth, async (req, res) => {
    try {
        // Check if user is admin
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can replenish stock' });
        }

        // Step 1: Trigger Sage 300 inventory sync first
        console.log('Starting Sage 300 inventory sync before stock replenishment...');
        const job = req.app.locals.inventorySyncJob;
        if (!job || typeof job.manualSync !== 'function') {
            return res.status(500).json({ error: 'InventorySyncJob not initialized' });
        }

        const sageSync = await job.manualSync();
        if (!sageSync.success) {
            return res.status(500).json({
                success: false,
                error: 'Sage 300 inventory sync failed. Cannot proceed with stock replenishment.',
                sageSync: sageSync
            });
        }

        console.log('Sage 300 inventory sync completed successfully. Proceeding with ZRA stock sync...');

        // Get the full user object for ZRA integration
        const fullUser = await user.findByPk(req.user.id);
        if (!fullUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Initialize ZRA service
        const zraService = new ZRAIntegrationServiceStockDisposal();

        // Get all products with updated inventory after Sage sync
        const productsWithInventory = await productinventory.findAll({
            where: {
                store_id: req.user.store_id,
                stock_quantity: { [require('sequelize').Op.gt]: 0 } // Only products with stock > 0
            },
            include: [{
                model: product,
                as: 'product',
                where: { is_active: true },
                attributes: ['id', 'name', 'product_code', 'product_class_code', 'price']
            }]
        });

        if (productsWithInventory.length === 0) {
            return res.status(200).json({
                success: true,
                message: 'No products with stock to report for replenishment',
                sageSync: sageSync,
                zraResults: {}
            });
        }

        // Calculate total amount for replenishment
        const totalAmount = productsWithInventory.reduce((sum, inventory) => {
            return sum + (inventory.product.price * inventory.stock_quantity);
        }, 0);

        const mockSaleData = {
            total_amount: totalAmount,
            tax_rate: 16 // Default VAT rate
        };

        // Format items for ZRA - current stock quantities as replenishment
        const mockItems = productsWithInventory.map(inventory => ({
            product_id: inventory.product.id,
            product: inventory.product,
            quantity: inventory.stock_quantity,
            total_price: inventory.product.price * inventory.stock_quantity,
            tax_exclusive_total: null // Will be calculated in transform method
        }));

        // Transform data using the replenishing method
        const stockItemsData = zraService.transformToZRAStockItemsDataReplenishing(
            mockSaleData,
            mockItems,
            fullUser
        );

        // Create stock master data with current quantities
        const stockMasterData = zraService.transformToZRAStockMasterData(
            mockItems,
            fullUser,
            productsWithInventory[0]?.stock_quantity || 0 // Use first item's stock quantity
        );

        // Send data to ZRA
        const [stockItemsResult, stockMasterResult] = await Promise.all([
            zraService.sendStockItemsData(stockItemsData),
            zraService.sendStockMasterData(stockMasterData)
        ]);

        // Check if both ZRA calls were successful
        if (!stockItemsResult.success || !stockMasterResult.success) {
            return res.status(500).json({
                success: false,
                error: 'ZRA submission failed',
                sageSync: sageSync,
                results: {
                    stockItems: stockItemsResult,
                    stockMaster: stockMasterResult
                }
            });
        }

        return res.status(200).json({
            success: true,
            message: `Successfully completed Sage sync and reported replenishment for ${productsWithInventory.length} products`,
            productsAffected: productsWithInventory.length,
            totalValueReplenished: totalAmount,
            sageSync: sageSync,
            zraResults: {
                stockItems: stockItemsResult,
                stockMaster: stockMasterResult
            }
        });

    } catch (error) {
        console.error('Replenish stock error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to replenish stock',
            details: error.message
        });
    }
});

router.post('/initializer/selectInitInfo', async (req, res) => {
    try {
        const { tpin, bhfId, dvcSrlNo } = req.body;

        // Validate required fields
        if (!tpin || !bhfId || !dvcSrlNo) {
            return res.status(400).json({
                resultCd: '400',
                resultMsg: 'Missing required fields',
                resultDt: new Date().toISOString(),
                data: null
            });
        }

        // Basic format validation (kept minimal to avoid blocking valid upstream cases)
        if (typeof tpin !== 'string' || typeof bhfId !== 'string' || typeof dvcSrlNo !== 'string') {
            return res.status(400).json({
                resultCd: '400',
                resultMsg: 'Invalid field types: tpin, bhfId, and dvcSrlNo must be strings',
                resultDt: new Date().toISOString(),
                data: null
            });
        }

        const baseUrl = process.env.ZRA_BASE_URL
        const url = `${baseUrl}/initializer/selectInitInfo`;

        console.log('Proxying device initialization to ZRA:', { url, tpin, bhfId, dvcSrlNo });

        const response = await axios.post(
            url,
            { tpin, bhfId, dvcSrlNo },
            { headers: { 'Content-Type': 'application/json' } }
        );

        // Forward the upstream JSON exactly
        return res.status(200).json(response.data);
    } catch (error) {
        // If upstream returned an error response, relay its status and body
        if (error.response) {
            console.error('ZRA upstream error:', {
                status: error.response.status,
                data: error.response.data
            });
            return res.status(error.response.status).json(error.response.data);
        }

        // Network or unexpected error
        console.error('Device initialization error:', error.message);
        return res.status(500).json({
            resultCd: '500',
            resultMsg: 'Failed to initialize device',
            resultDt: new Date().toISOString(),
            data: null
        });
    }
});

// Legacy endpoint for backward compatibility - creates individual batches per sale

module.exports = router;
