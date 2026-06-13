const express = require('express');
const { sale, creditnote, creditnoteitem, product, user, customer, store, productinventory } = require('../models');
const auth = require('../middleware/auth');
const { Op, literal } = require('sequelize');
const { buildActorFromUser, logRequestAudit } = require('../services/auditLogService');
const { buildListQueryFilters } = require('../services/query/listFilters');
const { submitCreditNoteToZra } = require('../services/credit-note/zraCreditNoteSubmission');
const {
    applyCreditNoteZraResult,
    logCreditNotePersistence,
} = require('../services/credit-note/persistCreditNote');

const router = express.Router();
const CREDIT_NOTE_INCLUDES = [
    { model: creditnoteitem, as: 'items', include: [{ model: product, as: 'product' }] },
    {
        model: user,
        as: 'cashier',
        attributes: ['id', 'full_name'],
        include: [{ model: store, as: 'store', attributes: ['store_location', 'store_mobile_no'] }],
    },
    { model: user, as: 'approver', attributes: ['id', 'full_name'] },
    { model: customer, as: 'customer' },
];

async function loadCreditNoteById(creditNoteId) {
    return creditnote.findByPk(creditNoteId, { include: CREDIT_NOTE_INCLUDES });
}
// In-memory lock set to prevent duplicate credit note processing for the same sale in concurrent requests
const activeCreditNoteReturns = new Set();

function getModels(req) {
    return req.app.locals.models || require('../models');
}

// Create credit note (return) - positive amounts; CRN prefix identifies CN

router.post('/:saleId/return', auth, async (req, res) => {
    const t = await creditnote.sequelize.transaction();

    const { saleId } = req.params;
    const lockKey = `return:${saleId}`;

    // Prevent concurrent processing of the same saleId in this process
    if (activeCreditNoteReturns.has(lockKey)) {
        await t.rollback();
        return res.status(409).json({ message: 'A credit note for this sale is already being processed. Please wait and try again.' });
    }
    activeCreditNoteReturns.add(lockKey);

    try {
        const { items, reason, reason_code, reason_label, approver_user_id } = req.body;

        if (!items || items.length === 0) {
            await t.rollback();
            return res.status(400).json({ message: 'Return must have at least one item' });
        }

        if (!req.user.store_id) {
            await t.rollback();
            return res.status(400).json({ message: 'User must be associated with a store' });
        }

        // Load original sale for validation/context
        const originalSale = await sale.findByPk(saleId, {
            include: [
                { 
                    model: user, 
                    as: 'cashier', 
                    attributes: ['id', 'full_name', 'store_id'] 
                },
                { 
                    model: customer, 
                    as: 'customer',
                    attributes: ['id', 'name', 'tpin', 'phone', 'email', 'legal_name'] // Explicitly include TPIN
                },
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
            return res.status(404).json({ message: 'Original sale not found' });
        }

        if (originalSale.cashier && originalSale.cashier.store_id !== req.user.store_id) {
            await t.rollback();
            return res.status(403).json({ message: 'Access denied: Sale does not belong to your store' });
        }

        // Validate customer and TPIN for ZRA requirements
        if (!originalSale.customer) {
            await t.rollback();
            return res.status(400).json({ 
                message: 'Cannot process return: Original sale has no customer associated. Customer information is required for ZRA fiscalisation.' 
            });
        }

        if (!originalSale.customer.tpin) {
            await t.rollback();
            return res.status(422).json({ 
                message: 'Cannot process return: Customer does not have a TPIN registered. TPIN is required for ZRA fiscalisation of credit notes.',
                customer: {
                    id: originalSale.customer.id,
                    name: originalSale.customer.name,
                    has_tpin: false
                },
                resolution: 'Please update the customer record with a valid TPIN before processing this return.'
            });
        }

        // Validate original sale is fiscalised with ZRA
        if (!originalSale.sdcid || !originalSale.receipt_no) {
            await t.rollback();
            return res.status(422).json({
                message: 'Cannot process return: the original sale is not fiscalised with ZRA yet (missing SDC id / receipt number).',
                originalSale: {
                    id: originalSale.id,
                    receipt_number: originalSale.receipt_number,
                    zra_status: originalSale.zra_status,
                    sdcid: originalSale.sdcid,
                    receipt_no: originalSale.receipt_no,
                },
            });
        }

        // Idempotency check: if a credit note for this sale already exists, return it.
        const existingCN = await creditnote.findOne({ 
            where: { receipt_number: `CN-${originalSale.receipt_number}` }, 
            transaction: t 
        });
        
        if (existingCN) {
            await t.rollback();
            let fullCN = await loadCreditNoteById(existingCN.id);

            if (fullCN.zra_status !== 'sent' || !fullCN.sdcid || !fullCN.receipt_no) {
                const existingReturnItems = (fullCN.items || []).map((item) => ({
                    product_id: item.product_id,
                    quantity: Number(item.quantity),
                    unit_price: Number(item.unit_price),
                    total_price: Number(item.total_price),
                    tax_exclusive_total: Number(item.total_price) / 1.16,
                    product: item.product || null,
                }));

                const zraResult = await submitCreditNoteToZra({
                    creditNoteInstance: fullCN,
                    originalSale,
                    returnItems: existingReturnItems,
                    user: req.user,
                    reasonCode: reason_code || '03',
                    custTpin: originalSale.customer.tpin, // Pass TPIN explicitly
                });

                const models = getModels(req);
                const persisted = await applyCreditNoteZraResult(models, fullCN.id, zraResult);
                fullCN = await loadCreditNoteById(fullCN.id);

                await logCreditNotePersistence(models, req, {
                    creditNoteInstance: fullCN,
                    originalSale,
                    outcome: fullCN.zra_status === 'sent' ? 'success' : 'failure',
                    reason: fullCN.zra_error,
                    actor: buildActorFromUser(req.user),
                });
            }

            return res.status(200).json({
                message: fullCN.zra_status === 'sent'
                    ? 'Credit note already exists for this sale.'
                    : 'Credit note already exists for this sale. ZRA fiscalisation is still pending.',
                creditNote: fullCN,
                zra_integration: {
                    success: fullCN.zra_status === 'sent',
                    queued: fullCN.zra_status !== 'sent',
                    status: fullCN.zra_status,
                    error: fullCN.zra_error,
                },
            });
        }

        // Prepare return items and totals
        const tax_rate = 16;
        let subtotal = 0;
        const returnItems = [];

        for (const item of items) {
            const originalItem = originalSale.items.find(si => si.product_id === item.product_id);
            if (!originalItem) {
                await t.rollback();
                return res.status(400).json({ message: `Product ${item.product_name || item.product_id} was not in the original sale` });
            }
            if (item.quantity > originalItem.quantity) {
                await t.rollback();
                return res.status(400).json({ message: `Return quantity for ${item.product_name || item.product_id} exceeds original quantity` });
            }

            const productData = await product.findByPk(item.product_id, { transaction: t });
            if (!productData) {
                await t.rollback();
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

        // Persist Credit Note document
        const cn = await creditnote.create({
            receipt_number: `CN-${originalSale.receipt_number}`,
            user_id: req.user.id,
            approver_user_id: approver_user_id || req.user.id,
            customer_id: originalSale.customer_id, // Use the ID, not TPIN
            subtotal,
            discount_amount,
            tax_amount,
            total_amount,
            payment_method: originalSale.payment_method,
            amount_paid: total_amount,
            change_amount: 0,
            credit_note_date: new Date(),
            notes: `Credit Note for Sale #${originalSale.id} - ${reason || reason_label || 'Return'}`,
            invnumber: null,
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
            next_retry_at: new Date(),
            last_retry_at: null,
            original_sale_id: originalSale.id,
            reason: reason || reason_label || 'Return',
        }, { transaction: t });

        // Store items and update stock (add back)
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

        const creditNoteReference = cn.receipt_number;

        // Commit transaction before external API calls
        await t.commit();

        const models = getModels(req);
        let fullCN = await loadCreditNoteById(cn.id);

        let zraFailed = true;
        let zraError = null;

        try {
            const zraResult = await submitCreditNoteToZra({
                creditNoteInstance: fullCN,
                originalSale,
                returnItems,
                user: req.user,
                reasonCode: reason_code || '03',
                customerTPIN: originalSale.customer.tpin, // Pass TPIN explicitly
                customerData: {
                    name: originalSale.customer.name,
                    legal_name: originalSale.customer.legal_name,
                    tpin: originalSale.customer.tpin,
                    phone: originalSale.customer.phone,
                    email: originalSale.customer.email,
                }
            });

            const persisted = await applyCreditNoteZraResult(models, cn.id, zraResult);
            zraFailed = persisted.zraFailed;
            zraError = persisted.zraError;
            fullCN = await loadCreditNoteById(cn.id);
        } catch (zraIntegrationError) {
            zraError = zraIntegrationError.message || String(zraIntegrationError);
            console.error('Credit note ZRA/persistence failed:', zraIntegrationError);
            fullCN = await loadCreditNoteById(cn.id);

            if (fullCN.zra_status !== 'sent') {
                await applyCreditNoteZraResult(models, cn.id, {
                    success: false,
                    error: zraError,
                });
                fullCN = await loadCreditNoteById(cn.id);

                const zraRetryJob = req.app.locals.zraRetryJob;
                if (zraRetryJob) {
                    zraRetryJob.run().catch((retryError) => {
                        console.error('Immediate credit note ZRA retry failed:', retryError.message);
                    });
                }
            }

            zraFailed = fullCN.zra_status !== 'sent';
        }

        await logCreditNotePersistence(models, req, {
            creditNoteInstance: fullCN,
            originalSale,
            outcome: zraFailed ? 'failure' : 'success',
            reason: zraError,
            actor: buildActorFromUser(req.user),
        });

        return res.status(201).json({
            message: zraFailed
                ? 'Credit note saved (ZRA pending). Sage posting will occur in the daily credit-note batch.'
                : 'Credit note created and fiscalised with ZRA. Sage posting will occur in the daily credit-note batch.',
            creditNote: fullCN,
            originalSale: {
                id: originalSale.id,
                receipt_number: originalSale.receipt_number,
                total_amount: originalSale.total_amount
            },
            customer_info: {
                name: originalSale.customer.name,
                tpin: originalSale.customer.tpin,
                has_valid_tpin: !!originalSale.customer.tpin
            },
            zra_integration: {
                success: !zraFailed,
                queued: zraFailed,
                status: zraFailed ? 'pending' : 'sent',
                error: zraError,
            },
            sage_integration: {
                queued: true,
                status: 'pending',
                batched: true,
                reference: creditNoteReference,
            },
        });

    } catch (error) {
        console.error('Credit note transaction failed:', error);
        await logRequestAudit(getModels(req), req, {
            action: 'credit_note.create',
            outcome: 'failure',
            entityType: 'credit_note',
            ...buildActorFromUser(req.user),
            target_identifier: req.params.saleId,
            details: {
                saleId: Number(req.params.saleId),
                message: error.message,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
            },
        });
        
        if (t) {
            try { await t.rollback(); } catch (rbErr) { console.error('Rollback failed:', rbErr); }
        }
        
        return res.status(500).json({
            message: 'Server error',
            error: error.message,
            ...(process.env.NODE_ENV === 'development' && {
                details: {
                    name: error.name,
                    errors: error.errors,
                    sql: error.sql,
                    parent: error.parent && { code: error.parent.code, message: error.parent.sqlMessage || error.parent.message }
                }
            })
        });
    } finally {
        // Release per-sale lock
        activeCreditNoteReturns.delete(lockKey);
    }
});

// Mark a credit note as receipt printed (idempotent)
router.post('/:id/mark-printed', auth, async (req, res) => {
    try {
        const id = req.params.id;
        const cn = await creditnote.findByPk(id, {
            include: [
                { model: user, as: 'cashier', attributes: ['id', 'store_id'] }
            ]
        });
        if (!cn) {
            return res.status(404).json({ message: 'Credit note not found' });
        }
        // Enforce store access: cashiers/admins can only modify within their store
        if (req.user && (req.user.role === 'cashier' || req.user.role === 'admin')) {
            const cashierStoreId = cn.cashier && cn.cashier.store_id;
            if (!cashierStoreId || cashierStoreId !== req.user.store_id) {
                return res.status(403).json({ message: 'Access denied' });
            }
        }

        const wasPrinted = !!cn.receipt_printed;
        if (!wasPrinted) {
            cn.receipt_printed = true;
            await cn.save();
        }
        return res.json({
            creditNote: cn,
            updated: !wasPrinted,
            message: wasPrinted ? 'Already marked as printed' : 'Marked as printed'
        });
    } catch (error) {
        console.error('Mark printed (credit note) error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// List credit notes
router.get('/', auth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const filterStoreId = req.user.store_id;

        const whereClause = buildListQueryFilters(req, {
            dateField: 'credit_note_date',
            amountField: 'total_amount',
            searchFields: ['receipt_number', 'receipt_no', 'invoice_no', 'invnumber'],
        });

        // Build the user include object properly
        const userInclude = {
            model: user,
            as: 'cashier',
            attributes: ['id', 'full_name', 'store_id']
        };

        // Add store filtering if user has a store_id
        if (filterStoreId) {
            userInclude.where = { store_id: filterStoreId };
            userInclude.required = true;
        }

        const include = [
            userInclude,
            { model: customer, as: 'customer' },
            {
                model: sale,
                as: 'originalSale',
                attributes: ['id', 'receipt_number', 'receipt_no', 'invoice_no', 'total_amount', 'sale_date'],
            },
            { model: creditnoteitem, as: 'items', include: [{ model: product, as: 'product' }] }
        ];

        const { count, rows } = await creditnote.findAndCountAll({
            where: whereClause,
            limit,
            offset,
            order: [['credit_note_date', 'DESC']],
            include
        });

        const creditNotes = rows.map((row) => {
            const plain = row.get ? row.get({ plain: true }) : row;
            return {
                ...plain,
                original_receipt_no: plain.originalSale?.receipt_number || null,
                original_receipt_number: plain.originalSale?.receipt_number || null,
            };
        });

        res.json({
            creditNotes,
            pagination: {
                current_page: page,
                total_pages: Math.ceil(count / limit),
                total_records: count,
                per_page: limit
            }
        });
    } catch (error) {
        console.error('Error fetching credit notes:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// Get credit note by id
router.get('/:id', auth, async (req, res) => {
    try {
        const cn = await creditnote.findByPk(req.params.id, {
            include: [
                { model: creditnoteitem, as: 'items', include: [{ model: product, as: 'product' }] },
                { model: user, as: 'cashier', attributes: ['id', 'full_name', 'store_id'] },
                { model: customer, as: 'customer' }
            ]
        });

        if (!cn) return res.status(404).json({ message: 'Credit note not found' });

        res.json({ creditNote: cn });
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;
