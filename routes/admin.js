const express = require('express');
const { sale, saleitem, product, user, customer, discount, store, creditnote, creditnoteitem,productinventory, dayend, sequelize } = require('../models');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const router = express.Router();
const authMiddleware = auth;

const SageShipment = require('../services/sale/createSageShipment');
const AccountsReceivableBatch = require("../services/sale/createSageArBatch");
const SageOrdersService = require('../services/sale/createSageOrder');
const ZraRetryJob = require('../jobs/zraRetryJob');

// Credit note Sage services (processed at day-end)
const SageShipmentReturn = require('../services/credit-note/createSageShipmentReturn');
const AccountsReceivableBatchReturn = require('../services/credit-note/createSageArBatchReturn');
const ZRAIntegrationServiceStockDisposal = require("../services/stock-disposal/zraEndPoints");
const SageInternalUsage = require("../services/stock-disposal/sageInternalUsages");
const logger = require("../utils/logger");

// ---------------- Admin User Management Endpoints ----------------
// List users (admin only)
router.get('/users', authMiddleware, async (req, res) => {
    const startedAt = new Date();
    try {
        if (!req.user || req.user.role !== 'admin') {
            logger.warn('admin_users_list_unauthorized', { userId: req.user?.id, role: req.user?.role });
            return res.status(403).json({ message: 'Only admins can view users' });
        }

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;
        const search = req.query.search || '';
        const role = req.query.role;
        const activeOnly = req.query.active_only === 'true';

        const whereClause = {};
        if (search) {
            whereClause[Op.or] = [
                { username: { [Op.like]: `%${search}%` } },
                { full_name: { [Op.like]: `%${search}%` } }
            ];
        }
        if (role) whereClause.role = role;
        if (activeOnly) whereClause.is_active = true;

        const { count, rows } = await user.findAndCountAll({
            where: whereClause,
            limit,
            offset,
            order: [['created_at', 'DESC']],
            attributes: { exclude: ['password_hash'] }
        });

        logger.info('admin_users_list_completed', {
            totalRecords: count,
            returnedRecords: rows.length,
            page,
            durationMs: Date.now() - startedAt.getTime()
        });

        // Return shape compatible with client decoder
        res.json({ users: rows, pagination: { current_page: page, total_pages: Math.ceil(count / limit), total_records: count, per_page: limit } });
    } catch (e) {
        logger.error('admin_users_list_error', { error: e.message, stack: e.stack });
        res.status(500).json({ message: 'Server error' });
    }
});

// Create user (admin only)
router.post('/users', authMiddleware, async (req, res) => {
    const startedAt = new Date();
    try {
        if (!req.user || req.user.role !== 'admin') {
            logger.warn('admin_user_create_unauthorized', { userId: req.user?.id, role: req.user?.role });
            return res.status(403).json({ message: 'Only admins can create users' });
        }

        const { username, full_name, password, role } = req.body || {};
        const store_id = req.user?.store_id || null;
        console.log(store_id)
        if (!username || !full_name || !password || !role) {
            return res.status(400).json({ message: 'username, full_name, password and role are required' });
        }
        if (!['admin', 'cashier'].includes(role)) {
            return res.status(400).json({ message: 'Invalid role' });
        }


        // Ensure unique username
        const existing = await user.findOne({ where: { username } });
        if (existing) {
            return res.status(409).json({ message: 'Username already exists' });
        }

        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        const created = await user.create({ username, full_name, role, password_hash,store_id , is_active: true });

        const safeUser = created.toJSON();
        delete safeUser.password_hash;

        logger.info('admin_user_create_completed', { createdUserId: created.id, durationMs: Date.now() - startedAt.getTime() });
        // Client accepts 201 or 200
        return res.status(201).json({ user: safeUser });
    } catch (e) {
        logger.error('admin_user_create_error', { error: e.message, stack: e.stack });
        res.status(500).json({ message: 'Server error' });
    }
});

// Day-end history between dates (admin only)
// GET /admin/day-end-history?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get('/day-end-history', authMiddleware, async (req, res) => {
    const startedAt = new Date();
    try {
        // Authz: admin only
        if (!req.user || req.user.role !== 'admin') {
            logger.warn('admin_day_end_history_unauthorized', { userId: req.user?.id, role: req.user?.role });
            return res.status(403).json({ message: 'Only admins can view day-end history' });
        }

        const start = (req.query.start || '').toString();
        const end = (req.query.end || '').toString();

        // Basic format validation YYYY-MM-DD
        const ymd = /^\d{4}-\d{2}-\d{2}$/;
        if (!ymd.test(start) || !ymd.test(end)) {
            return res.status(400).json({ message: 'start and end must be in YYYY-MM-DD format' });
        }

        // Ensure start <= end
        if (start > end) {
            return res.status(400).json({ message: 'start date must be before or equal to end date' });
        }

        // Build list of dates between start and end inclusive
        const toDate = (s) => {
            const [y, m, d] = s.split('-').map(Number);
            return new Date(y, m - 1, d);
        };
        const toYMD = (dt) => {
            const y = dt.getFullYear();
            const m = String(dt.getMonth() + 1).padStart(2, '0');
            const d = String(dt.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        };

        const startDate = toDate(start);
        const endDate = toDate(end);

        // Safety: invalid dates
        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            return res.status(400).json({ message: 'Invalid start or end date' });
        }

        // Fetch all stores to determine total
        const stores = await store.findAll();
        const totalStores = stores.length;

        // Preferred source: dayend table (success entries between dates)
        const successRows = await dayend.findAll({
            where: {
                status: 'success',
                date: { [Op.between]: [start, end] }
            },
            attributes: [
                'date',
                [sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('store_id'))), 'storeCount']
            ],
            group: ['date'],
            raw: true
        });

        let results = [];
        if (successRows && successRows.length > 0) {
            const countMap = successRows.reduce((acc, r) => { acc[r.date] = Number(r.storeCount); return acc; }, {});
            for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
                const dayStr = toYMD(d);
                const completedStores = countMap[dayStr] || 0;
                const completed = totalStores > 0 ? (completedStores === totalStores) : true;
                const message = `${completedStores}/${totalStores} stores completed`;
                results.push({ date: dayStr, completed, message });
            }
        } else {
            // Fallback to legacy logic using stores.last_day_end_date to avoid empty history
            const storeStatus = stores.map(s => {
                const raw = s.last_day_end_date;
                let ymdStr = null;
                if (!raw) {
                    ymdStr = null;
                } else if (typeof raw === 'string') {
                    ymdStr = raw;
                } else if (raw instanceof Date) {
                    ymdStr = raw.toISOString().split('T')[0];
                } else {
                    try { ymdStr = new Date(raw).toISOString().split('T')[0]; } catch (_) { ymdStr = null; }
                }
                return { id: s.id, last: ymdStr };
            });

            for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
                const dayStr = toYMD(d);
                const completedStores = storeStatus.filter(ss => ss.last && ss.last >= dayStr).length;
                const completed = totalStores > 0 ? (completedStores === totalStores) : true;
                const message = `${completedStores}/${totalStores} stores completed`;
                results.push({ date: dayStr, completed, message, source: 'legacy' });
            }
        }

        logger.info('admin_day_end_history_completed', {
            start,
            end,
            days: results.length,
            durationMs: Date.now() - startedAt.getTime()
        });

        // Return plain array to be tolerant with clients
        return res.json(results);
    } catch (e) {
        logger.error('admin_day_end_history_error', { error: e.message, stack: e.stack });
        return res.status(500).json({ message: 'Server error' });
    }
});

// Delete user (admin only) - soft delete by deactivating
router.delete('/users/archive/:id', authMiddleware, async (req, res) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            logger.warn('admin_user_archive_unauthorized', { userId: req.user?.id, role: req.user?.role });
            return res.status(403).json({ message: 'Only admins can delete users' });
        }

        const targetId = parseInt(req.params.id);
        if (Number.isNaN(targetId)) return res.status(400).json({ message: 'Invalid user id' });

        const found = await user.findByPk(targetId);
        if (!found) return res.status(404).json({ message: 'User not found' });

        if (req.user.id === targetId) {
            return res.status(400).json({ message: 'You cannot archive your own account' });
        }

        await user.update({ is_active: false }, { where: { id: targetId } });
        // 204 No Content is acceptable for client
        return res.status(204).send();
    } catch (e) {
        logger.error('admin_user_delete_error', { error: e.message, stack: e.stack });
        res.status(500).json({ message: 'Server error' });
    }
});
router.post('/users/unarchive/:id', authMiddleware, async (req, res) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            logger.warn('admin_user_unarchive_unauthorized', { userId: req.user?.id, role: req.user?.role });
            return res.status(403).json({ message: 'Only admins can delete users' });
        }

        const targetId = parseInt(req.params.id);
        if (Number.isNaN(targetId)) return res.status(400).json({ message: 'Invalid user id' });

        const found = await user.findByPk(targetId);
        if (!found) return res.status(404).json({ message: 'User not found' });

        if (req.user.id === targetId) {
            return res.status(400).json({ message: 'You cannot unarchive your own account' });
        }

        await user.update({ is_active: true }, { where: { id: targetId } });
        // 204 No Content is acceptable for client
        return res.status(204).send();
    } catch (e) {
        logger.error('admin_user_unarchive_error', { error: e.message, stack: e.stack });
        res.status(500).json({ message: 'Server error' });
    }
});
router.delete('/users/:id', authMiddleware, async (req, res) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            logger.warn('admin_user_delete_unauthorized', { userId: req.user?.id, role: req.user?.role });
            return res.status(403).json({ message: 'Only admins can delete users' });
        }

        const targetId = parseInt(req.params.id);
        if (Number.isNaN(targetId)) return res.status(400).json({ message: 'Invalid user id' });

        const found = await user.findByPk(targetId);
        if (!found) return res.status(404).json({ message: 'User not found' });

        if (req.user.id === targetId) {
            return res.status(400).json({ message: 'You cannot delete your own account' });
        }

        await user.destroy( { where: { id: targetId } });
        // 204 No Content is acceptable for client
        return res.status(204).send();
    } catch (e) {
        logger.error('admin_user_delete_error', { error: e.message, stack: e.stack });
        res.status(500).json({ message: 'Server error' });
    }
});

// Change user password (admin only)
router.patch('/users/:id/password', authMiddleware, async (req, res) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            logger.warn('admin_user_change_password_unauthorized', { userId: req.user?.id, role: req.user?.role });
            return res.status(403).json({ message: 'Only admins can change passwords' });
        }

        const targetId = parseInt(req.params.id);
        if (Number.isNaN(targetId)) return res.status(400).json({ message: 'Invalid user id' });

        const { password } = req.body || {};
        if (!password || String(password).length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters long' });
        }

        const found = await user.findByPk(targetId);
        if (!found) return res.status(404).json({ message: 'User not found' });

        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);
        await user.update({ password_hash }, { where: { id: targetId } });

        logger.info('admin_user_change_password_completed', { targetId });
        return res.status(200).json({ message: 'Password changed successfully' });
    } catch (e) {
        logger.error('admin_user_change_password_error', { error: e.message, stack: e.stack });
        res.status(500).json({ message: 'Server error' });
    }
});

/**
 * Creates Sage OE Orders for all sales of a day
 */
async function persistConsolidatedOrderDataToSage(salesForDay, user, date) {
    try {
        const sageService = new SageOrdersService();
        const salesDataArray = salesForDay.map(sale => ({
            items: (sale.items || []).map(item => ({
                product_id: item.product_id,
                quantity: Number(item.quantity),
                unit_price: Number(item.unit_price),
                total_price: Number(item.total_price),
                product: item.product || null,
                product_code: item.product?.product_code
            })),
            salesData: {
                id: sale.id,
                receipt_number: sale.receipt_number,
                subtotal: Number(sale.subtotal),
                discount_amount: Number(sale.discount_amount || 0),
                tax_amount: Number(sale.tax_amount || 0),
                total_amount: Number(sale.total_amount),
                tax_rate: 16,
                payment_method: sale.payment_method,
                amount_paid: Number(sale.amount_paid),
                change_amount: Number(sale.change_amount || 0),
                notes: sale.notes,
                customer: sale.customer,
                discount: sale.discount,
                currency: "ZMW"
            },
            receiptNumber: sale.receipt_number
        }));

        // Duplicate check
        const utcDate = new Date().toISOString();
        const orderDate = date ? new Date(date).toISOString() : utcDate;
        const storeLocation = user?.store?.store_location || '';
        if (storeLocation && salesDataArray.length > 0) {
            const description = `${storeLocation} POS Sales - ${orderDate}`;
            const filter = `OrderDescription eq '${description}'`;
            const encodedFilter = encodeURIComponent(filter);
            const url = `${process.env.SAGE_BASE_URL}/OE/OEOrders?%24filter=${encodedFilter}`;
            const username = process.env.SAGE_USERNAME || 'ADMIN';
            const password = process.env.SAGE_PASSWORD || 'Admin123!';
            const auth = Buffer.from(`${username}:${password}`, 'utf-8').toString('base64');

            try {
                const checkResponse = await axios.get(url, {
                    headers: {
                        'Accept': 'application/json',
                        'Authorization': `Basic ${auth}`,
                    }
                });
                if (checkResponse.data.value && checkResponse.data.value.length > 0) {
                    console.log(`Sage OE Order already exists for ${storeLocation} on ${orderDate}. Skipping creation.`);
                    return {
                        success: true,
                        status: 200,
                        message: 'Order already exists in Sage',
                        orderDetailsCount: salesDataArray.reduce((acc, s) => acc + (s.items?.length || 0), 0),
                        salesProcessed: salesDataArray.length
                    };
                }
            } catch (err) {
                console.error('Error checking existing Sage order in admin route:', err);
                // Continue with creation if check fails? Or fail?
                // Usually better to continue if it's just a check, but Sage might return error on duplicate anyway
            }
        }

        const sageResponse = await sageService.createConsolidatedOrder(salesDataArray, user, date);
        if (!sageResponse.success) {
            console.error('Sage OE consolidated Order creation failed:', sageResponse);
        }
        return sageResponse;
    } catch (error) {
        console.error('Error persisting orders to Sage (OE Orders):', error);
        return { success: false, error: 'Error occurred while communicating with Sage for OE Orders' };
    }
}



// Day-end sync route now delegates entirely to DayEndJob, which also records to dayends
router.post('/day-end-sync', auth, async (req, res) => {
    try {
        const { date } = req.body || {};
        const job = req.app.locals.dayEndJob;

        if (!job || typeof job.runOnce !== 'function') {
            return res.status(500).json({
                success: false,
                error: 'DayEndJob not initialized',
                message: 'Day-end sync service unavailable'
            });
        }

        const result = await job.runOnce('manual', date || null);
        const targetDate = result.date || date || new Date().toISOString().split('T')[0];

        // Case 1: Sync was skipped because already completed
        if (result.skipped) {
            const reason = result.reason || 'Day-end already completed';
            return res.status(200).json({
                success: false,
                message: `Day-end already completed for ${targetDate}`,
                error: reason,
                summary: {
                    date: targetDate,
                    totalSales: 0,
                    backendResult: {
                        status: "SKIPPED",
                        success: false,
                        error: reason
                    }
                },
                results: {
                    status: "SKIPPED",
                    success: false,
                    error: reason
                },
                consolidatedBatches: {
                    shipment: { success: 0, failed: 0, itemsProcessed: 0 },
                    invoice: { success: 0, failed: 0, invoicesProcessed: 0 }
                }
            });
        }

        // Case 2: No sales found anywhere for that date
        if (result.noSales) {
            const message = `No sales found for ${targetDate}; nothing to sync`;
            return res.status(200).json({
                success: true,
                message,
                summary: {
                    date: targetDate,
                    totalSales: 0,
                    storesProcessed: result.updated || 0,
                    backendResult: {
                        status: "NO_SALES",
                        success: true,
                        info: message
                    }
                },
                results: {
                    status: "NO_SALES",
                    success: true,
                    details: {
                        message,
                        processedStores: result.processed || 0,
                        storesWithSales: 0
                    }
                },
                consolidatedBatches: {
                    shipment: {
                        success: 0,
                        failed: 0,
                        itemsProcessed: 0
                    },
                    invoice: {
                        success: 0,
                        failed: 0,
                        invoicesProcessed: 0
                    }
                }
            });
        }

        // Case 3: Sync succeeded
        if (result.success) {
            return res.status(200).json({
                success: true,
                message: `Day-end sync completed for ${targetDate}`,
                summary: {
                    date: targetDate,
                    totalSales: result.salesProcessed || 0,
                    storesProcessed: result.updated || 0,
                    backendResult: {
                        status: "COMPLETED",
                        success: true
                    }
                },
                results: {
                    status: "COMPLETED",
                    success: true,
                    details: {
                        shipments: {
                            success: result.updated || 0,
                            failed: result.errors?.length || 0,
                            itemsProcessed: result.salesProcessed || 0
                        },
                        invoices: {
                            success: 0,
                            failed: 0,
                            invoicesProcessed: 0,
                            batchNumber: null,
                            batchTotal: 0
                        }
                    }
                },
                consolidatedBatches: {
                    shipment: {
                        success: result.updated || 0,
                        failed: result.errors?.length || 0,
                        itemsProcessed: result.salesProcessed || 0
                    },
                    invoice: {
                        success: 0,
                        failed: 0,
                        invoicesProcessed: 0
                    }
                }
            });
        }

        // Case 4: Sync failed with errors
        else {
            const errorMsg = result.errors && result.errors.length
                ? result.errors.map(e => `Store ${e.store_id}: ${e.error}`).join('; ')
                : (result.reason || 'Day-end sync failed');

            return res.status(200).json({
                success: false,
                message: `Day-end sync failed for ${targetDate}`,
                error: errorMsg,
                summary: {
                    date: targetDate,
                    totalSales: result.salesProcessed || 0,
                    storesProcessed: result.processed || 0,
                    storesFailed: result.errors?.length || 0,
                    backendResult: {
                        status: "FAILED",
                        success: false,
                        error: errorMsg
                    }
                },
                results: {
                    status: "FAILED",
                    success: false,
                    error: errorMsg,
                    details: {
                        errors: result.errors || []
                    }
                },
                consolidatedBatches: {
                    shipment: {
                        success: result.updated || 0,
                        failed: result.errors?.length || 0
                    },
                    invoice: {
                        success: 0,
                        failed: 0
                    }
                }
            });
        }
    } catch (err) {
        console.error('Day-end sync endpoint error:', err);
        return res.status(500).json({
            success: false,
            error: err.message,
            message: 'Internal server error during day-end sync',
            summary: {
                backendResult: {
                    status: "ERROR",
                    success: false,
                    error: err.message
                }
            }
        });
    }
});// Zero out all stock (admin only)
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
/**
 * Creates a consolidated shipment batch for all sales of a day

async function persistConsolidatedShipmentDataToSage(salesForDay, user, date) {
    try {
        const sageService = new SageShipment();

        // Prepare sales data in the format expected by the consolidated method
        const salesDataArray = salesForDay.map(sale => ({
            items: (sale.items || []).map(item => ({
                product_id: item.product_id,
                quantity: Number(item.quantity),
                unit_price: Number(item.unit_price),
                total_price: Number(item.total_price),
                product: item.product || null,
                product_code: item.product?.product_code
            })),
            receiptNumber: sale.receipt_number
        }));

        const sageResponse = await sageService.createConsolidatedShipmentBatch(salesDataArray, user, date);
        console.log(sageResponse)
        if (!sageResponse.success) {
            console.error('Consolidated Sage shipment creation failed:', sageResponse.error);
            return {
                success: false,
                error: sageResponse.error || 'Failed to create consolidated shipment in Sage system'
            };
        }

        return {
            success: true,
            data: sageResponse.data,
            itemsProcessed: sageResponse.itemsProcessed,
            salesProcessed: sageResponse.salesProcessed
        };
    } catch (error) {
        console.error('Error persisting consolidated data to Sage (shipment):', error);
        return {
            success: false,
            error: 'Error occurred while communicating with Sage system'
        };
    }
}

/**
 * Creates a consolidated AR batch for all sales of a day

async function persistConsolidatedInvoiceDataToSage(salesForDay, user, date) {
    try {
        const sageService = new AccountsReceivableBatch();

        // Prepare sales data in the format expected by the consolidated method
        const salesDataArray = salesForDay.map(sale => ({
            items: (sale.items || []).map(item => ({
                product_id: item.product_id,
                quantity: Number(item.quantity),
                unit_price: Number(item.unit_price),
                total_price: Number(item.total_price),
                product: item.product || null,
                product_code: item.product?.product_code
            })),
            salesData: {
                id: sale.id,
                receipt_number: sale.receipt_number,
                subtotal: Number(sale.subtotal),
                discount_amount: Number(sale.discount_amount || 0),
                tax_amount: Number(sale.tax_amount || 0),
                total_amount: Number(sale.total_amount),
                tax_rate: 16, // default used across system
                payment_method: sale.payment_method,
                amount_paid: Number(sale.amount_paid),
                change_amount: Number(sale.change_amount || 0),
                notes: sale.notes,
                customer: sale.customer,
                discount: sale.discount,
                currency: "ZMW"
            }
        }));

        const sageResponse = await sageService.createConsolidatedArBatch(salesDataArray, user, date);

        if (!sageResponse.success) {
            console.error('Consolidated Sage AR invoice creation failed:', sageResponse.error);
            return {
                success: false,
                error: sageResponse.error || 'Failed to create consolidated AR invoice in Sage system'
            };
        }

        return {
            success: true,
            data: sageResponse.data,
            batchNumber: sageResponse.batchNumber,
            invoicesProcessed: sageResponse.invoicesProcessed,
            batchTotal: sageResponse.batchTotal
        };
    } catch (error) {
        console.error('Error persisting consolidated data to Sage (invoice):', error);
        return {
            success: false,
            error: 'Error occurred while communicating with Sage system'
        };
    }
}

/**
 * Creates a consolidated shipment batch for all credit notes of a day

async function persistConsolidatedShipmentReturnDataToSage(creditNotesForDay, user, date) {
    try {
        const sageService = new SageShipmentReturn();

        // Prepare credit notes data for the consolidated method
        const creditNotesArray = creditNotesForDay.map(cn => ({
            items: (cn.items || []).map(item => ({
                product_id: item.product_id,
                quantity: Number(item.quantity),
                unit_price: Number(item.unit_price),
                total_price: Number(item.total_price),
                product: item.product || null,
                product_code: item.product?.product_code
            })),
            receiptNumber: cn.receipt_number
        }));

        const sageResponse = await sageService.createConsolidatedShipmentBatchReturn(creditNotesArray, user, date);
        if (!sageResponse.success) {
            console.error('Consolidated Sage shipment return creation failed:', sageResponse.error);
            return { success: false, error: sageResponse.error || 'Failed to create consolidated shipment return in Sage system' };
        }

        return {
            success: true,
            data: sageResponse.data,
            itemsProcessed: sageResponse.itemsProcessed,
            salesProcessed: sageResponse.salesProcessed
        };
    } catch (error) {
        console.error('Error persisting consolidated credit note shipment data to Sage:', error);
        return { success: false, error: 'Error occurred while communicating with Sage system' };
    }
}

/**
 * Creates a consolidated AR batch for all credit notes of a day

async function persistConsolidatedCreditNoteInvoiceDataToSage(creditNotesForDay, user, date) {
    try {
        const sageService = new AccountsReceivableBatchReturn();

        // Prepare credit notes data for the consolidated method
        const creditNotesArray = creditNotesForDay.map(cn => ({
            items: (cn.items || []).map(item => ({
                product_id: item.product_id,
                quantity: Number(item.quantity),
                unit_price: Number(item.unit_price),
                total_price: Number(item.total_price),
                product: item.product || null,
                product_code: item.product?.product_code
            })),
            salesData: {
                id: cn.id,
                receipt_number: cn.receipt_number,
                subtotal: Number(cn.subtotal),
                discount_amount: Number(cn.discount_amount || 0),
                tax_amount: Number(cn.tax_amount || 0),
                total_amount: Number(cn.total_amount),
                tax_rate: 16,
                payment_method: cn.payment_method,
                amount_paid: Number(cn.amount_paid),
                change_amount: Number(cn.change_amount || 0),
                notes: cn.notes,
                customer: cn.customer,
                discount: null,
                currency: "ZMW"
            }
        }));

        const sageResponse = await sageService.createConsolidatedArBatchReturn(creditNotesArray, user, date);
        if (!sageResponse.success) {
            console.error('Consolidated Sage AR credit note creation failed:', sageResponse.error);
            return { success: false, error: sageResponse.error || 'Failed to create consolidated AR credit note batch in Sage system' };
        }

        return {
            success: true,
            data: sageResponse.data,
            batchNumber: sageResponse.batchNumber,
            invoicesProcessed: sageResponse.invoicesProcessed,
            batchTotal: sageResponse.batchTotal
        };
    } catch (error) {
        console.error('Error persisting consolidated credit note invoice data to Sage:', error);
        return { success: false, error: 'Error occurred while communicating with Sage system' };
    }
}


 * Creates internal usage for disposed stock
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
module.exports = router;