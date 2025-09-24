const express = require('express');
const { sale, saleitem, product, user, customer, discount, store } = require('../models');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');

const router = express.Router();

const SageShipment = require('../services/createSageShipment');
const AccountsReceivableBatch = require("../services/createSageArBatch");

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

// Day-end sync: create consolidated Sage batches for all sales on a specific day
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

        // Fetch sales for the day with necessary associations
        const salesForDay = await sale.findAll({
            where: {
                createdAt: { [Op.between]: [startOfDay, endOfDay] }
            },
            include: [
                { model: saleitem, as: 'items', include: [{ model: product }] },
                { model: user, as: 'cashier', include: [{ model: store }] },
                { model: customer, as: 'customer' },
                { model: discount, as: 'discount' },
            ],
            order: [['id', 'ASC']]
        });

        if (salesForDay.length === 0) {
            return res.json({
                message: `No sales found for ${dateString}`,
                summary: {
                    date: dateString,
                    totalSales: 0,
                    shipments: { success: 0, failed: 0 },
                    invoices: { success: 0, failed: 0 }
                }
            });
        }

        // Get user info from the first sale (assuming all sales are from the same store)
        const firstSale = salesForDay[0];
        const userInfo = firstSale.cashier;

        const results = {
            date: dateString,
            totalSales: salesForDay.length,
            shipment: null,
            invoice: null
        };

        // Create consolidated shipment batch if requested
        if (includeShipment) {
            console.log(`Creating consolidated shipment batch for ${salesForDay.length} sales`);
            results.shipment = await persistConsolidatedShipmentDataToSage(salesForDay, userInfo, dateString);
        }

        // Create consolidated invoice batch if requested
        if (includeInvoice) {
            console.log(`Creating consolidated invoice batch for ${salesForDay.length} sales`);
            results.invoice = await persistConsolidatedInvoiceDataToSage(salesForDay, userInfo, dateString);
        }

        // Calculate summary
        const summary = {
            date: dateString,
            totalSales: salesForDay.length,
            shipments: {
                success: results.shipment?.success ? 1 : 0,
                failed: results.shipment?.success ? 0 : (includeShipment ? 1 : 0),
                itemsProcessed: results.shipment?.itemsProcessed || 0
            },
            invoices: {
                success: results.invoice?.success ? 1 : 0,
                failed: results.invoice?.success ? 0 : (includeInvoice ? 1 : 0),
                invoicesProcessed: results.invoice?.invoicesProcessed || 0,
                batchTotal: results.invoice?.batchTotal || 0
            },
        };

        console.log(`Day-end sync completed for ${dateString}:`, summary);

        return res.json({
            message: 'Day-end sync complete - consolidated batches created',
            summary,
            results,
            consolidatedBatches: {
                shipment: results.shipment?.success ? {
                    created: true,
                    itemsProcessed: results.shipment.itemsProcessed,
                    salesProcessed: results.shipment.salesProcessed
                } : null,
                invoice: results.invoice?.success ? {
                    created: true,
                    batchNumber: results.invoice.batchNumber,
                    invoicesProcessed: results.invoice.invoicesProcessed,
                    batchTotal: results.invoice.batchTotal
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

// Legacy endpoint for backward compatibility - creates individual batches per sale
router.post('/day-end-sync-individual', auth, async (req, res) => {
    try {
        const { date, includeShipment = true, includeInvoice = true } = req.body || {};

        // Compute start and end of day for the provided date or today (local time)
        const baseDate = date ? new Date(date) : new Date();
        if (isNaN(baseDate.getTime())) {
            return res.status(400).json({ message: 'Invalid date. Use YYYY-MM-DD.' });
        }
        const startOfDay = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 0, 0, 0, 0);
        const endOfDay = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 23, 59, 59, 999);

        // Fetch sales for the day with necessary associations
        const salesForDay = await sale.findAll({
            where: {
                createdAt: { [Op.between]: [startOfDay, endOfDay] }
            },
            include: [
                { model: saleitem, as: 'items', include: [{ model: product }] },
                { model: user, as: 'cashier', include: [{ model: store }] },
                { model: customer, as: 'customer' },
                { model: discount, as: 'discount' },
            ],
            order: [['id', 'ASC']]
        });

        const results = [];
        for (const s of salesForDay) {
            // Prepare sale data and items in the shape expected by the original Sage services
            const saleData = {
                id: s.id,
                receipt_number: s.receipt_number,
                subtotal: Number(s.subtotal),
                discount_amount: Number(s.discount_amount || 0),
                tax_amount: Number(s.tax_amount || 0),
                total_amount: Number(s.total_amount),
                tax_rate: 16, // default used across system; adjust if stored per sale
                payment_method: s.payment_method,
                amount_paid: Number(s.amount_paid),
                change_amount: Number(s.change_amount || 0),
                notes: s.notes,
                customer: s.customer,
                discount: s.discount,
            };

            const saleItems = (s.items || []).map(it => ({
                product_id: it.product_id,
                quantity: Number(it.quantity),
                unit_price: Number(it.unit_price),
                total_price: Number(it.total_price),
                product: it.product || null,
            }));

            const entry = { saleId: s.id, receipt: s.receipt_number, shipment: null, invoice: null };

            // Use original methods for individual batches
            if (includeShipment) {
                const sageService = new SageShipment();
                entry.shipment = await sageService.createShipmentBatch(saleData, saleItems, s.cashier);
            }
            if (includeInvoice) {
                const arService = new AccountsReceivableBatch();
                entry.invoice = await arService.createSageArBatch(saleData, saleItems, s.cashier);
            }

            results.push(entry);
        }

        const summary = {
            date: startOfDay.toISOString().slice(0, 10),
            totalSales: salesForDay.length,
            shipments: {
                success: results.filter(r => r.shipment?.success).length,
                failed: results.filter(r => r.shipment && !r.shipment.success).length,
            },
            invoices: {
                success: results.filter(r => r.invoice?.success).length,
                failed: results.filter(r => r.invoice && !r.invoice.success).length,
            },
        };

        return res.json({
            message: 'Day-end sync complete - individual batches created',
            summary,
            results
        });
    } catch (err) {
        console.error('Individual day-end sync error:', err);
        return res.status(500).json({
            message: 'Failed to complete individual day-end sync',
            error: err.message
        });
    }
});

module.exports = router;