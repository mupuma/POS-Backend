const express = require('express');
const { sale, saleitem, product, user, customer, discount, store, creditnote, creditnoteitem,productinventory } = require('../models');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');

const router = express.Router();

const SageShipment = require('../services/sale/createSageShipment');
const AccountsReceivableBatch = require("../services/sale/createSageArBatch");

// Credit note Sage services (processed at day-end)
const SageShipmentReturn = require('../services/credit-note/createSageShipmentReturn');
const AccountsReceivableBatchReturn = require('../services/credit-note/createSageArBatchReturn');
const ZRAIntegrationServiceStockDisposal = require("../services/stock-disposal/zraEndPoints");

/**
 * Creates a consolidated shipment batch for all sales of a day
 */
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
 */
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
 */
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
 */
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

// Day-end sync: create consolidated Sage batches for all sales on a specific day (and credit notes)
router.post('/day-end-sync', auth, async (req, res) => {
    try {
        const { date, includeShipment = true, includeInvoice = true } = req.body || {};

        // Compute start and end of day for the provided date or today (local time)
        const baseDate = date ? new Date(date) : new Date();
        if (isNaN(baseDate.getTime())) {
            return res.status(400).json({ message: 'Invalid date. Use YYYY-MM-DD.' });
        }
        const startOfDay = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 0, 0, 0, 0);
        const endOfDay = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 23, 59, 59, 999);
        const dateString = startOfDay.toISOString().slice(0, 10);

        console.log(`Starting day-end sync for ${dateString}`);

        // Ensure user is scoped to a store
        const storeId = req.user?.store_id;
        if (!storeId) {
            return res.status(400).json({ message: 'Authenticated user is not assigned to a store.' });
        }

        // Fetch sales for the day restricted to the user’s store
        const salesForDay = await sale.findAll({
            where: {
                createdAt: { [Op.between]: [startOfDay, endOfDay] }
            },
            include: [
                { model: saleitem, as: 'items', include: [{ model: product }] },
                { model: user, as: 'cashier', where: { store_id: storeId }, required: true, include: [{ model: store }] },
                { model: customer, as: 'customer' },
                { model: discount, as: 'discount' },
            ],
            order: [['id', 'ASC']]
        });

        // Fetch credit notes for the day restricted to the user’s store
        const creditNotesForDay = await creditnote.findAll({
            where: {
                createdAt: { [Op.between]: [startOfDay, endOfDay] }
            },
            include: [
                { model: creditnoteitem, as: 'items', include: [{ model: product }] },
                { model: user, as: 'cashier', where: { store_id: storeId }, required: true, include: [{ model: store }] },
                { model: customer, as: 'customer' }
            ],
            order: [['id', 'ASC']]
        });

        if (salesForDay.length === 0 && creditNotesForDay.length === 0) {
            return res.json({
                message: `No sales or credit notes found for ${dateString}`,
                summary: {
                    date: dateString,
                    totalSales: 0,
                    totalCreditNotes: 0,
                    shipments: { success: 0, failed: 0 },
                    invoices: { success: 0, failed: 0 },
                    creditNotesShipments: { success: 0, failed: 0 },
                    creditNotesInvoices: { success: 0, failed: 0 }
                }
            });
        }

        // Determine the store to apply the day-end flag
        let targetStore = await store.findByPk(storeId);
        if (!targetStore) {
            return res.status(400).json({ message: 'Unable to determine store for day-end.' });
        }

        // Check if day-end already completed for this date
        if (targetStore.last_day_end_date && targetStore.last_day_end_date.toString() === dateString) {
            return res.status(409).json({ message: `Day-end already completed for ${dateString}` });
        }

        // Get user info from the first available document (sale or credit note)
        const firstSale = salesForDay[0];
        const firstCN = creditNotesForDay[0];
        const userInfo = (firstSale?.cashier) || (firstCN?.cashier);

        const results = {
            date: dateString,
            totalSales: salesForDay.length,
            totalCreditNotes: creditNotesForDay.length,
            shipment: { sales: null, creditNotes: null },
            invoice: { sales: null, creditNotes: null }
        };

        // Create consolidated shipment batches if requested
        if (includeShipment) {
            if (salesForDay.length > 0) {
                console.log(`Creating consolidated shipment batch for ${salesForDay.length} sales`);
                results.shipment.sales = await persistConsolidatedShipmentDataToSage(salesForDay, userInfo, dateString);
            } else {
                results.shipment.sales = { success: true, skipped: true, reason: 'no-sales' };
            }

            if (creditNotesForDay.length > 0) {
                console.log(`Creating consolidated shipment return batch for ${creditNotesForDay.length} credit notes`);
                results.shipment.creditNotes = await persistConsolidatedShipmentReturnDataToSage(creditNotesForDay, userInfo, dateString);
            } else {
                results.shipment.creditNotes = { success: true, skipped: true, reason: 'no-credit-notes' };
            }
        }

        // Create consolidated invoice batches if requested
        if (includeInvoice) {
            if (salesForDay.length > 0) {
                console.log(`Creating consolidated invoice batch for ${salesForDay.length} sales`);
                results.invoice.sales = await persistConsolidatedInvoiceDataToSage(salesForDay, userInfo, dateString);
            } else {
                results.invoice.sales = { success: true, skipped: true, reason: 'no-sales' };
            }

            if (creditNotesForDay.length > 0) {
                console.log(`Creating consolidated AR credit note batch for ${creditNotesForDay.length} credit notes`);
                results.invoice.creditNotes = await persistConsolidatedCreditNoteInvoiceDataToSage(creditNotesForDay, userInfo, dateString);
            } else {
                results.invoice.creditNotes = { success: true, skipped: true, reason: 'no-credit-notes' };
            }
        }

        // On success, set the last_day_end_date on the store (only if all requested ops succeeded)
        const shipmentOk = includeShipment ? (!!results.shipment.sales?.success && !!results.shipment.creditNotes?.success) : true;
        const invoiceOk = includeInvoice ? (!!results.invoice.sales?.success && !!results.invoice.creditNotes?.success) : true;
        if (shipmentOk && invoiceOk) {
            try {
                await store.update({ last_day_end_date: dateString }, { where: { id: targetStore.id } });
            } catch (e) {
                console.warn('Warning: Failed to update last_day_end_date:', e.message);
            }
        }

        // Calculate summary (preserve existing keys, add credit note keys)
        const summary = {
            date: dateString,
            totalSales: salesForDay.length,
            totalCreditNotes: creditNotesForDay.length,
            shipments: {
                success: results.shipment.sales?.success ? 1 : 0,
                failed: results.shipment.sales?.success ? 0 : (includeShipment ? 1 : 0),
                itemsProcessed: results.shipment.sales?.itemsProcessed || 0
            },
            invoices: {
                success: results.invoice.sales?.success ? 1 : 0,
                failed: results.invoice.sales?.success ? 0 : (includeInvoice ? 1 : 0),
                invoicesProcessed: results.invoice.sales?.invoicesProcessed || 0,
                batchTotal: results.invoice.sales?.batchTotal || 0
            },
            creditNotesShipments: {
                success: results.shipment.creditNotes?.success ? 1 : 0,
                failed: results.shipment.creditNotes?.success ? 0 : (includeShipment ? 1 : 0),
                itemsProcessed: results.shipment.creditNotes?.itemsProcessed || 0
            },
            creditNotesInvoices: {
                success: results.invoice.creditNotes?.success ? 1 : 0,
                failed: results.invoice.creditNotes?.success ? 0 : (includeInvoice ? 1 : 0),
                invoicesProcessed: results.invoice.creditNotes?.invoicesProcessed || 0,
                batchTotal: results.invoice.creditNotes?.batchTotal || 0
            }
        };

        console.log(`Day-end sync completed for ${dateString}:`, summary);

        return res.json({
            message: 'Day-end sync complete - consolidated batches created',
            summary,
            results,
            consolidatedBatches: {
                shipment: results.shipment.sales?.success ? {
                    created: true,
                    itemsProcessed: results.shipment.sales.itemsProcessed,
                    salesProcessed: results.shipment.sales.salesProcessed
                } : null,
                invoice: results.invoice.sales?.success ? {
                    created: true,
                    batchNumber: results.invoice.sales.batchNumber,
                    invoicesProcessed: results.invoice.sales.invoicesProcessed,
                    batchTotal: results.invoice.sales.batchTotal
                } : null,
                creditNoteShipment: results.shipment.creditNotes?.success ? {
                    created: true,
                    itemsProcessed: results.shipment.creditNotes.itemsProcessed,
                    salesProcessed: results.shipment.creditNotes.salesProcessed
                } : null,
                creditNoteInvoice: results.invoice.creditNotes?.success ? {
                    created: true,
                    batchNumber: results.invoice.creditNotes.batchNumber,
                    invoicesProcessed: results.invoice.creditNotes.invoicesProcessed,
                    batchTotal: results.invoice.creditNotes.batchTotal
                } : null
            }
        });
    } catch (err) {
        console.error('Day-end sync error:', err);
        return res.status(500).json({
            message: 'Failed to complete day-end sync',
            error: err.message
        });
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
                results: {
                    stockItems: stockItemsResult,
                    stockMaster: stockMasterResult
                }
            });
        }

        // Update local inventory to zero only if ZRA submission was successful
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


// Legacy endpoint for backward compatibility - creates individual batches per sale

module.exports = router;