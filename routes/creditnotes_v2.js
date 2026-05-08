const express = require('express');
const { sale, creditnote, creditnoteitem, product, user, customer, store, productinventory } = require('../models');
const auth = require('../middleware/auth');
const { Op, literal } = require('sequelize');
const logger = require('../utils/logger');

const ZRAIntegrationService = require('../services/credit-note/generateSmartInvoiceCreditNote');
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

const router = express.Router();
const siteId = process.env.SITE_ID || 'unknown-site';

// In-memory lock set to prevent duplicate credit note processing for the same sale in concurrent requests
const activeCreditNoteReturns = new Set();

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

        logger.info('qrcode_generated', {
            siteId,
            receiptNo,
            filePath
        });

        return filePath;
    } catch (err) {
        logger.error('qrcode_generation_error', {
            siteId,
            receiptNo,
            error: err.message,
            stack: err.stack
        });
        throw err;
    }
}

// Create credit note (return) - positive amounts; CRN prefix identifies CN
router.post('/:saleId/return', auth, async (req, res) => {
    const startedAt = new Date();
    const t = await creditnote.sequelize.transaction();

    const { saleId } = req.params;
    const lockKey = `return:${saleId}`;

    logger.info('credit_note_creation_started', {
        siteId,
        saleId,
        userId: req.user?.id,
        storeId: req.user?.store_id,
        startedAt
    });

    // Prevent concurrent processing of the same saleId in this process
    if (activeCreditNoteReturns.has(lockKey)) {
        await t.rollback();
        logger.warn('credit_note_duplicate_processing', {
            siteId,
            saleId,
            userId: req.user?.id,
            lockKey
        });
        return res.status(409).json({ message: 'A credit note for this sale is already being processed. Please wait and try again.' });
    }
    activeCreditNoteReturns.add(lockKey);

    try {
        const { items, reason, reason_code, reason_label, approver_user_id } = req.body;

        logger.info('credit_note_request_details', {
            siteId,
            saleId,
            userId: req.user?.id,
            itemsCount: items?.length,
            reasonCode: reason_code,
            approverId: approver_user_id
        });

        if (!items || items.length === 0) {
            await t.rollback();
            logger.warn('credit_note_no_items', {
                siteId,
                saleId,
                userId: req.user?.id
            });
            return res.status(400).json({ message: 'Return must have at least one item' });
        }

        if (!req.user.store_id) {
            await t.rollback();
            logger.warn('credit_note_no_store', {
                siteId,
                saleId,
                userId: req.user?.id
            });
            return res.status(400).json({ message: 'User must be associated with a store' });
        }

        // Load original sale for validation/context
        const originalSale = await sale.findByPk(saleId, {
            include: [
                { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'] },
                { model: customer, as: 'customer' },
                {
                    model: require('../models').saleitem,
                    as: 'items',
                    include: [{ model: product, as: 'product' }]
                }
            ],
            transaction: t
        });

        if (!originalSale) {
            await t.rollback();
            logger.warn('credit_note_sale_not_found', {
                siteId,
                saleId,
                userId: req.user?.id
            });
            return res.status(404).json({ message: 'Original sale not found' });
        }

        logger.info('credit_note_original_sale_loaded', {
            siteId,
            saleId,
            receiptNumber: originalSale.receipt_number,
            totalAmount: originalSale.total_amount,
            originalStoreId: originalSale.cashier?.store_id
        });

        if (originalSale.cashier && originalSale.cashier.store_id !== req.user.store_id) {
            await t.rollback();
            logger.warn('credit_note_store_mismatch', {
                siteId,
                saleId,
                userStoreId: req.user.store_id,
                saleStoreId: originalSale.cashier.store_id
            });
            return res.status(403).json({ message: 'Access denied: Sale does not belong to your store' });
        }

        // Idempotency check
        const existingCN = await creditnote.findOne({ where: { receipt_number: `CN-${originalSale.receipt_number}` }, transaction: t });
        if (existingCN) {
            await t.rollback();
            logger.info('credit_note_already_exists', {
                siteId,
                saleId,
                creditNoteId: existingCN.id,
                receiptNumber: existingCN.receipt_number
            });

            const fullCN = await creditnote.findByPk(existingCN.id, {
                include: [
                    { model: creditnoteitem, as: 'items', include: [{ model: product, as: 'product' }] },
                    { model: user, as: 'cashier', attributes: ['id', 'full_name'], include: [{ model: store, as: 'store', attributes: ['store_location', 'store_mobile_no'] }] },
                    { model: user, as: 'approver', attributes: ['id', 'full_name'] },
                    { model: customer, as: 'customer' }
                ]
            });
            return res.status(200).json({ message: 'Credit note already exists for this sale. Returning existing record.', creditNote: fullCN });
        }

        // Prepare return items and totals
        const tax_rate = 16;
        let subtotal = 0;
        const returnItems = [];

        for (const item of items) {
            const originalItem = originalSale.items.find(si => si.product_id === item.product_id);
            if (!originalItem) {
                await t.rollback();
                logger.warn('credit_note_invalid_product', {
                    siteId,
                    saleId,
                    productId: item.product_id,
                    productName: item.product_name
                });
                return res.status(400).json({ message: `Product ${item.product_name || item.product_id} was not in the original sale` });
            }
            if (item.quantity > originalItem.quantity) {
                await t.rollback();
                logger.warn('credit_note_quantity_exceeded', {
                    siteId,
                    saleId,
                    productId: item.product_id,
                    returnQuantity: item.quantity,
                    originalQuantity: originalItem.quantity
                });
                return res.status(400).json({ message: `Return quantity for ${item.product_name || item.product_id} exceeds original quantity` });
            }

            const productData = await product.findByPk(item.product_id, { transaction: t });
            if (!productData) {
                await t.rollback();
                logger.warn('credit_note_product_not_found', {
                    siteId,
                    saleId,
                    productId: item.product_id
                });
                return res.status(400).json({ message: `Product with ID ${item.product_id} not found` });
            }

            const unit_price_inclusive = Number(item.unit_price);
            const taxMultiplier = 1 + (Number(tax_rate) / 100);
            const unit_price_exclusive = unit_price_inclusive / taxMultiplier;

            const tax_exclusive_total = item.quantity * unit_price_exclusive;
            const tax_inclusive_total = item.quantity * unit_price_inclusive;

            subtotal += tax_exclusive_total;

            returnItems.push({
                product_id: item.product_id,
                quantity: item.quantity,
                unit_price: unit_price_inclusive,
                total_price: tax_inclusive_total,
                tax_exclusive_total,
                product: productData
            });
        }

        const discount_amount = 0;
        const tax_amount = (subtotal * tax_rate) / 100;
        const total_amount = subtotal + tax_amount;

        logger.info('credit_note_totals_calculated', {
            siteId,
            saleId,
            subtotal,
            taxAmount: tax_amount,
            totalAmount: total_amount,
            itemsCount: returnItems.length
        });

        const creditNoteData = {
            subtotal,
            discount_amount,
            tax_amount,
            total_amount,
            tax_rate,
            payment_method: originalSale.payment_method,
            amount_paid: total_amount,
            change_amount: 0,
            notes: reason || reason_label || 'Credit Note',
            customer: originalSale.customer,
            discount: null
        };

        // ZRA (immediate)
        logger.info('credit_note_zra_submission_started', {
            siteId,
            saleId,
            totalAmount: total_amount,
            reasonCode: reason_code || '03'
        });

        const zraService = new ZRAIntegrationService();
        const salesData = await zraService.transformToZRACreditNoteSalesData(
            creditNoteData,
            returnItems,
            req.user,
            reason_code || '03',
            originalSale.receipt_no,
            originalSale.sdcid
        );
        const salesResponse = await zraService.sendCreditNoteSalesData(salesData);

        if (!salesResponse.success) {
            await t.rollback();
            logger.error('credit_note_zra_failed', {
                siteId,
                saleId,
                error: salesResponse.error,
                totalAmount: total_amount
            });
            return res.status(500).json({
                message: 'Failed to process credit note with ZRA system',
                zra_errors: [salesResponse.error]
            });
        }

        const saveSalesData = salesResponse.data.data;
        if (!saveSalesData) {
            await t.rollback();
            logger.error('credit_note_zra_no_data', {
                siteId,
                saleId
            });
            return res.status(500).json({ message: 'No data received from ZRA credit note endpoint' });
        }

        logger.info('credit_note_zra_success', {
            siteId,
            saleId,
            rcptNo: saveSalesData.rcptNo,
            sdcId: saveSalesData.sdcId,
            invoiceNo: saveSalesData.invoiceNo
        });

        let qrFilePath = null;
        if (saveSalesData.qrCodeUrl && saveSalesData.rcptNo) {
            try {
                qrFilePath = await generateQrCode(
                    saveSalesData.qrCodeUrl,
                    saveSalesData.rcptNo,
                    "./qrcodes"
                );
            } catch (qrError) {
                logger.error('credit_note_qrcode_failed', {
                    siteId,
                    saleId,
                    rcptNo: saveSalesData.rcptNo,
                    error: qrError.message
                });
                // Don't fail the entire transaction for QR code generation
            }
        }

        // Persist Credit Note document
        const cn = await creditnote.create({
            receipt_number: `CN-${originalSale.receipt_number}`,
            user_id: req.user.id,
            approver_user_id: approver_user_id || req.user.id,
            customer_id: originalSale.customer_id || null,
            subtotal,
            discount_amount,
            tax_amount,
            total_amount,
            payment_method: originalSale.payment_method,
            amount_paid: total_amount,
            change_amount: 0,
            credit_note_date: new Date(),
            notes: `Credit Note for Sale #${originalSale.id} - ${reason || reason_label || 'Return'}`,
            invnumber: (salesData && salesData.cisInvcNo) || saveSalesData.invoiceNo || saveSalesData.invNumber || saveSalesData.invnumber || null,
            receipt_no: saveSalesData.rcptNo || null,
            sdcid: saveSalesData.sdcId || null,
            receiptsig: saveSalesData.rcptSign || null,
            intrldata: saveSalesData.intrlData || null,
            qrcode_url: saveSalesData.qrCodeUrl || null,
            vsdcrcpdate: saveSalesData.vsdcRcptPbctDate || null,
            invoice_no: (saveSalesData.sdcId && saveSalesData.rcptNo) ? `CRN${saveSalesData.sdcId.substring(3)}/${saveSalesData.rcptNo}` : null,
            qrfilepath: qrFilePath,
            original_sale_id: originalSale.id,
            reason: reason || reason_label || 'Return',
        }, { transaction: t });

        logger.info('credit_note_persisted', {
            siteId,
            saleId,
            creditNoteId: cn.id,
            receiptNumber: cn.receipt_number
        });

        // Store items and update stock
        for (const item of returnItems) {
            await creditnoteitem.create({
                credit_note_id: cn.id,
                product_id: item.product_id,
                quantity: item.quantity,
                unit_price: item.unit_price,
                total_price: item.total_price
            }, { transaction: t });

            await productinventory.update(
                { stock_quantity: literal(`stock_quantity + ${item.quantity}`) },
                { where: { product_id: item.product_id, store_id: req.user.store_id }, transaction: t }
            );
        }

        await t.commit();

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('credit_note_completed', {
            siteId,
            saleId,
            creditNoteId: cn.id,
            receiptNumber: cn.receipt_number,
            totalAmount: total_amount,
            itemsCount: returnItems.length,
            durationMs
        });

        // Fire-and-forget: send ZRA stock items adjustment
        try {
            const stockItemsData = zraService.transformToZRACreditNoteStockItemsData(creditNoteData, returnItems, req.user);
            logger.info('credit_note_stock_items_background_started', {
                siteId,
                creditNoteId: cn.id
            });

            zraService.sendCreditNoteStockItemsData(stockItemsData)
                .then(resp => {
                    if (!resp.success) {
                        logger.error('credit_note_stock_items_background_failed', {
                            siteId,
                            creditNoteId: cn.id,
                            error: resp.error
                        });
                    } else {
                        logger.info('credit_note_stock_items_background_success', {
                            siteId,
                            creditNoteId: cn.id
                        });
                    }
                })
                .catch(err => {
                    logger.error('credit_note_stock_items_background_error', {
                        siteId,
                        creditNoteId: cn.id,
                        error: err?.message || err
                    });
                });
        } catch (bgErr) {
            logger.error('credit_note_stock_items_init_failed', {
                siteId,
                creditNoteId: cn.id,
                error: bgErr?.message || bgErr
            });
        }

        const fullCN = await creditnote.findByPk(cn.id, {
            include: [
                { model: creditnoteitem, as: 'items', include: [{ model: product, as: 'product' }] },
                { model: user, as: 'cashier', attributes: ['id', 'full_name'], include: [{ model: store, as: 'store', attributes: ['store_location', 'store_mobile_no'] }] },
                { model: user, as: 'approver', attributes: ['id', 'full_name'] },
                { model: customer, as: 'customer' }
            ]
        });

        return res.status(201).json({
            message: 'Credit note created successfully',
            creditNote: fullCN,
            originalSale: {
                id: originalSale.id,
                receipt_number: originalSale.receipt_number,
                total_amount: originalSale.total_amount
            },
            zra_integration: { success: true }
        });

    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('credit_note_error', {
            siteId,
            saleId,
            userId: req.user?.id,
            error: error.message,
            stack: error.stack,
            errorName: error.name,
            durationMs
        });

        if (t) {
            try {
                await t.rollback();
            } catch (rbErr) {
                logger.error('credit_note_rollback_error', {
                    siteId,
                    saleId,
                    error: rbErr.message
                });
            }
        }

        return res.status(500).json({
            message: 'Server error',
            error: error.message,
            details: {
                name: error.name,
                errors: error.errors,
                sql: error.sql,
                parent: error.parent && { code: error.parent.code, message: error.parent.sqlMessage || error.parent.message }
            }
        });
    } finally {
        activeCreditNoteReturns.delete(lockKey);
    }
});

// Mark a credit note as receipt printed
router.post('/:id/mark-printed', auth, async (req, res) => {
    const startedAt = new Date();

    try {
        const id = req.params.id;

        logger.info('credit_note_mark_printed_started', {
            siteId,
            creditNoteId: id,
            userId: req.user?.id,
            startedAt
        });

        const cn = await creditnote.findByPk(id, {
            include: [
                { model: user, as: 'cashier', attributes: ['id', 'store_id'] }
            ]
        });

        if (!cn) {
            logger.warn('credit_note_mark_printed_not_found', {
                siteId,
                creditNoteId: id,
                userId: req.user?.id
            });
            return res.status(404).json({ message: 'Credit note not found' });
        }

        // Enforce store access
        if (req.user && (req.user.role === 'cashier' || req.user.role === 'admin')) {
            const cashierStoreId = cn.cashier && cn.cashier.store_id;
            if (!cashierStoreId || cashierStoreId !== req.user.store_id) {
                logger.warn('credit_note_mark_printed_unauthorized', {
                    siteId,
                    creditNoteId: id,
                    userId: req.user?.id,
                    userStoreId: req.user.store_id,
                    cnStoreId: cashierStoreId
                });
                return res.status(403).json({ message: 'Access denied' });
            }
        }

        const wasPrinted = !!cn.receipt_printed;
        if (!wasPrinted) {
            cn.receipt_printed = true;
            await cn.save();
        }

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('credit_note_mark_printed_completed', {
            siteId,
            creditNoteId: id,
            userId: req.user?.id,
            wasPrinted,
            durationMs
        });

        return res.json({
            creditNote: cn,
            updated: !wasPrinted,
            message: wasPrinted ? 'Already marked as printed' : 'Marked as printed'
        });
    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('credit_note_mark_printed_error', {
            siteId,
            creditNoteId: req.params.id,
            userId: req.user?.id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/', auth, async (req, res) => {
    const startedAt = new Date();

    try {
        const page        = parseInt(req.query.page)   || 1;
        const limit       = parseInt(req.query.limit)  || 20;
        const offset      = (page - 1) * limit;
        const filterStoreId = req.user.store_id;

        // Search / filter params
        const receipt_no  = req.query.q?.trim()              || null;
        const start_date  = req.query.start_date             || null;
        const end_date    = req.query.end_date               || null;
        const start_time  = req.query.start_time             || null; // "HH:MM"
        const end_time    = req.query.end_time               || null; // "HH:MM"
        const min_amount  = parseFloat(req.query.min_amount) || null;
        const max_amount  = parseFloat(req.query.max_amount) || null;

        logger.info('credit_notes_list_started', {
            siteId,
            userId: req.user?.id,
            storeId: filterStoreId,
            page,
            limit,
            receipt_no,
            start_date,
            end_date,
            start_time,
            end_time,
            min_amount,
            max_amount,
            startedAt
        });

        const where = {};

        // ── Date + time range ───────────────────────────────────────────────
        if (start_date || end_date) {
            if (start_date && end_date && new Date(end_date) < new Date(start_date)) {
                return res.status(400).json({ message: 'End date cannot be before start date' });
            }

            where.credit_note_date = {};

            if (start_date) {
                const startDateTime = start_time
                    ? new Date(`${new Date(start_date).toISOString().split('T')[0]}T${start_time}:00.000Z`)
                    : new Date(start_date);
                where.credit_note_date[Op.gte] = startDateTime;
            }

            if (end_date) {
                const endDateTime = end_time
                    ? new Date(`${new Date(end_date).toISOString().split('T')[0]}T${end_time}:59.999Z`)
                    : new Date(end_date);
                where.credit_note_date[Op.lte] = endDateTime;
            }
        } else if (start_time || end_time) {
            // Time only — anchor to today
            const todayStr = new Date().toISOString().split('T')[0];
            where.credit_note_date = {};
            if (start_time) where.credit_note_date[Op.gte] = new Date(`${todayStr}T${start_time}:00.000Z`);
            if (end_time)   where.credit_note_date[Op.lte] = new Date(`${todayStr}T${end_time}:59.999Z`);
        }

        // ── Amount range ────────────────────────────────────────────────────
        if (min_amount !== null || max_amount !== null) {
            where.total_amount = {};
            if (min_amount !== null) where.total_amount[Op.gte] = min_amount;
            if (max_amount !== null) where.total_amount[Op.lte] = max_amount;
        }

        // ── Free-text search ────────────────────────────────────────────────
        if (receipt_no) {
            const searchTerms = `%${receipt_no}%`;
            where[Op.or] = [
                { receipt_number: { [Op.like]: searchTerms } },
                { receipt_no:     { [Op.like]: searchTerms } },
                { reason:         { [Op.like]: searchTerms } },
                { reason_label:   { [Op.like]: searchTerms } },
                { reason_code:    { [Op.like]: searchTerms } },
                literal(`cashier.full_name LIKE ${sequelize.escape(searchTerms)}`),
                literal(`cashier.username  LIKE ${sequelize.escape(searchTerms)}`),
                literal(`EXISTS (
                    SELECT 1 FROM credit_note_items cni
                    JOIN products p ON cni.product_id = p.id
                    WHERE cni.credit_note_id = \`creditnote\`.\`id\`
                      AND (p.name LIKE ${sequelize.escape(searchTerms)}
                        OR p.sku  LIKE ${sequelize.escape(searchTerms)})
                )`)
            ];
        }

        // ── Associations ────────────────────────────────────────────────────
        const userInclude = {
            model: user,
            as: 'cashier',
            attributes: ['id', 'full_name', 'store_id', 'username'],
            ...(filterStoreId ? { where: { store_id: filterStoreId }, required: true } : {})
        };

        const include = [
            userInclude,
            { model: customer, as: 'customer' },
            { model: creditnoteitem, as: 'items', include: [{ model: product, as: 'product' }] },
        ];

        // ── Query ───────────────────────────────────────────────────────────
        const { count, rows } = await creditnote.findAndCountAll({
            where,
            limit,
            offset,
            order: [['credit_note_date', 'DESC']],
            include,
            distinct: true
        });

        // ── Attach original receipt numbers ─────────────────────────────────
        const originalSaleIds = Array.from(
            new Set(rows.map(cn => cn.original_sale_id).filter(id => id != null))
        );

        let salesMap = {};
        if (originalSaleIds.length > 0) {
            const salesList = await sale.findAll({
                where: { id: originalSaleIds },
                attributes: ['id', 'receipt_no', 'receipt_number']
            });
            salesMap = salesList.reduce((acc, s) => {
                acc[s.id] = s.receipt_no ?? s.receipt_number ?? null;
                return acc;
            }, {});
        }

        const creditNotes = rows.map(cn => {
            const json = cn.toJSON();
            json.original_receipt_no = json.original_sale_id
                ? salesMap[json.original_sale_id] || null
                : null;
            return json;
        });

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('credit_notes_list_completed', {
            siteId,
            userId: req.user?.id,
            storeId: filterStoreId,
            totalRecords: count,
            returnedRecords: creditNotes.length,
            page,
            durationMs
        });

        res.json({
            creditNotes,
            pagination: {
                current_page:  page,
                total_pages:   Math.ceil(count / limit),
                total_records: count,
                per_page:      limit
            }
        });

    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('credit_notes_list_error', {
            siteId,
            userId: req.user?.id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});
// Get credit note by id
router.get('/:id', auth, async (req, res) => {
    const startedAt = new Date();

    try {
        const id = req.params.id;

        logger.info('credit_note_get_started', {
            siteId,
            creditNoteId: id,
            userId: req.user?.id,
            startedAt
        });

        const cn = await creditnote.findByPk(id, {
            include: [
                { model: creditnoteitem, as: 'items', include: [{ model: product, as: 'product' }] },
                { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'] },
                { model: customer, as: 'customer' }
            ]
        });

        if (!cn) {
            logger.warn('credit_note_get_not_found', {
                siteId,
                creditNoteId: id,
                userId: req.user?.id
            });
            return res.status(404).json({ message: 'Credit note not found' });
        }

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('credit_note_get_completed', {
            siteId,
            creditNoteId: id,
            userId: req.user?.id,
            receiptNumber: cn.receipt_number,
            durationMs
        });

        res.json({ creditNote: cn });
    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('credit_note_get_error', {
            siteId,
            creditNoteId: req.params.id,
            userId: req.user?.id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;