const express = require('express');
const router = express.Router();
const ZRAService = require('../services/zraService');
const { sale } = require('../models');
const { Op } = require('sequelize');

const zraService = new ZRAService();

// Test ZRA connection and endpoints
router.get('/test-connection', async (req, res) => {
    try {
        const result = await zraService.testConnection();
        res.json({
            success: result.success,
            message: result.success ? 'ZRA connection test completed' : 'ZRA connection test failed',
            data: result.data,
            endpoints: result.endpoints,
            config: { baseUrl: zraService.baseURL, timeout: zraService.timeout, enabled: process.env.ZRA_ENABLED === 'true' }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'ZRA connection test failed', error: error.message });
    }
});

// Manual ZRA integration for a sale
router.post('/process-sale/:saleId', async (req, res) => {
    const { saleId } = req.params;
    const { force = false } = req.body;
    let transaction;

    if (process.env.ZRA_ENABLED !== 'true' && !force) {
        return res.status(400).json({ success: false, message: 'ZRA integration disabled. Use force=true to override' });
    }

    try {
        transaction = await sale.sequelize.transaction();
        const saleData = await sale.findOne({
            where: { id: saleId },
            include: [{ association: 'saleitems', include: ['product'] }, 'customer', 'user'],
            transaction
        });

        if (!saleData) {
            await transaction.rollback();
            return res.status(404).json({ success: false, message: 'Sale not found' });
        }

        if (saleData.zra_processed && !force) {
            await transaction.rollback();
            return res.status(400).json({ success: false, message: 'Sale already processed by ZRA' });
        }

        const result = await zraService.processZRAIntegration(saleData, saleData.saleitems, saleData.user);

        const updateData = result.success
            ? {
                  zra_processed: true,
                  zra_processed_at: new Date(),
                  cis_invoice_no: result.invoiceNo || saleData.invoice_number,
                  zra_response: JSON.stringify(result),
                  zra_attempts: (saleData.zra_attempts || 0) + 1
              }
            : {
                  zra_processed: false,
                  zra_error: JSON.stringify(result.errors),
                  zra_attempts: (saleData.zra_attempts || 0) + 1,
                  zra_last_attempt: new Date()
              };

        await saleData.update(updateData, { transaction });
        await transaction.commit();

        res.json({
            success: result.success,
            message: result.success ? 'ZRA integration completed' : 'ZRA integration failed',
            data: result,
            saleId: saleData.id,
            invoiceNumber: saleData.invoice_number,
            cisInvoiceNo: saleData.cis_invoice_no || saleData.invoice_number,
            attempts: saleData.zra_attempts
        });
    } catch (error) {
        if (transaction) await transaction.rollback();
        res.status(500).json({ success: false, message: 'Failed to process sale with ZRA', error: error.message });
    }
});

// Get ZRA processing status for a sale
router.get('/sale-status/:saleId', async (req, res) => {
    try {
        const { saleId } = req.params;
        const saleData = await sale.findOne({
            where: { id: saleId },
            attributes: ['id', 'invoice_number', 'zra_processed', 'zra_processed_at', 'cis_invoice_no', 'zra_attempts', 'zra_error', 'zra_last_attempt', 'created_at']
        });

        if (!saleData) return res.status(404).json({ success: false, message: 'Sale not found' });

        let errorDetails = null;
        if (saleData.zra_error) {
            try { errorDetails = JSON.parse(saleData.zra_error); } catch { errorDetails = saleData.zra_error; }
        }

        res.json({
            success: true,
            data: {
                saleId: saleData.id,
                invoiceNumber: saleData.invoice_number,
                cisInvoiceNo: saleData.cis_invoice_no || saleData.invoice_number,
                zraProcessed: saleData.zra_processed,
                processedAt: saleData.zra_processed_at,
                attempts: saleData.zra_attempts || 0,
                lastAttempt: saleData.zra_last_attempt,
                saleDate: saleData.created_at,
                hasError: !!saleData.zra_error,
                error: errorDetails,
                status: saleData.zra_processed ? 'processed' : saleData.zra_attempts > 0 ? 'failed' : 'pending'
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to get ZRA status', error: error.message });
    }
});

// Retry failed ZRA integrations (optional)
router.post('/retry-failed', async (req, res) => {
    const { limit = 10, force = false } = req.body;
    if (process.env.ZRA_ENABLED !== 'true' && !force) {
        return res.status(400).json({ success: false, message: 'ZRA integration disabled. Use force=true to override' });
    }

    try {
        const failedSales = await sale.findAll({
            where: { zra_processed: false, zra_attempts: { [Op.lt]: 5 } },
            include: [{ association: 'saleitems', include: ['product'] }, 'customer', 'user'],
            limit: parseInt(limit),
            order: [['created_at', 'ASC']]
        });

        const results = [];
        for (const saleData of failedSales) {
            const transaction = await sale.sequelize.transaction();
            try {
                const result = await zraService.processZRAIntegration(saleData, saleData.saleitems, saleData.user);

                const updateData = result.success
                    ? { zra_processed: true, zra_processed_at: new Date(), cis_invoice_no: result.invoiceNo || saleData.invoice_number, zra_response: JSON.stringify(result), zra_attempts: (saleData.zra_attempts || 0) + 1 }
                    : { zra_error: JSON.stringify(result.errors), zra_attempts: (saleData.zra_attempts || 0) + 1, zra_last_attempt: new Date() };

                await saleData.update(updateData, { transaction });
                await transaction.commit();

                results.push({ saleId: saleData.id, invoiceNumber: saleData.invoice_number, cisInvoiceNo: saleData.cis_invoice_no || saleData.invoice_number, success: result.success, attempts: saleData.zra_attempts, error: result.errors });
            } catch (error) {
                if (transaction) await transaction.rollback();
                results.push({ saleId: saleData.id, invoiceNumber: saleData.invoice_number, success: false, error: error.message });
            }
        }

        res.json({ success: true, message: `Processed ${results.length} failed sales`, results });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to retry ZRA processing', error: error.message });
    }
});

module.exports = router;
