const express = require('express');
const { sale, creditnote, creditnoteitem, product, user, customer, store, productinventory } = require('../models');
const auth = require('../middleware/auth');
const { Op, literal } = require('sequelize');
const { buildActorFromUser, logRequestAudit } = require('../services/auditLogService');
const { buildListQueryFilters } = require('../services/query/listFilters');
const { submitCreditNoteToZra } = require('../services/credit-note/zraCreditNoteSubmission');
const { clearDashboardCache } = require('../services/reports/dashboardStats');
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
                    attributes: ['id', 'name', 'tpin', 'phone', 'email', 'legal_name']
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

        // Handle Walk-in Customer (no customer or no TPIN)
        let customerTPIN = '1000000000'; // Default TPIN for walk-in customers
        let customerName = 'Walk-in Customer';
        let customerId = null;
        let customerData = null;

        if (!originalSale.customer) {
            // No customer associated - treat as walk-in
            console.log(`Sale ${saleId} has no customer, using Walk-in Customer default`);
            customerTPIN = '1000000000';
            customerName = 'Walk-in Customer';
            customerId = null;
            customerData = {
                name: 'Walk-in Customer',
                legal_name: 'Walk-in Customer',
                tpin: '1000000000',
                phone: null,
                email: null
            };
        } else if (!originalSale.customer.tpin || originalSale.customer.tpin === '') {
            // Customer exists but has no TPIN - treat as walk-in
            console.log(`Customer ${originalSale.customer.id} has no TPIN, using Walk-in Customer default`);
            customerTPIN = '1000000000';
            customerName = originalSale.customer.name || 'Walk-in Customer';
            customerId = originalSale.customer.id;
            customerData = {
                name: originalSale.customer.name || 'Walk-in Customer',
                legal_name: originalSale.customer.legal_name || 'Walk-in Customer',
                tpin: '1000000000',
                phone: originalSale.customer.phone,
                email: originalSale.customer.email,
            };
        } else {
            // Valid customer with TPIN
            customerTPIN = originalSale.customer.tpin;
            customerName = originalSale.customer.name;
            customerId = originalSale.customer.id;
            customerData = {
                name: originalSale.customer.name,
                legal_name: originalSale.customer.legal_name || originalSale.customer.name,
                tpin: originalSale.customer.tpin,
                phone: originalSale.customer.phone,
                email: originalSale.customer.email,
            };
        }

        // // Validate original sale is fiscalised with ZRA (required for credit note)
        // if (!originalSale.sdcid || !originalSale.receipt_no) {
        //     await t.rollback();
        //     return res.status(422).json({
        //         message: 'Cannot process return: the original sale is not fiscalised with ZRA yet (missing SDC id / receipt number).',
        //         originalSale: {
        //             id: originalSale.id,
        //             receipt_number: originalSale.receipt_number,
        //             zra_status: originalSale.zra_status,
        //             sdcid: originalSale.sdcid,
        //             receipt_no: originalSale.receipt_no,
        //         },
        //     });
        // }

        // Idempotency check: if a credit note for this sale already exists, return it.
        const existingCN = await creditnote.findOne({ 
            where: { receipt_number: `CN-${originalSale.receipt_number}` }, 
            transaction: t 
        });
        
        if (existingCN) {
            await t.rollback();
            
            // Check if already fiscalized
            if (existingCN.zra_status === 'sent' && existingCN.sdcid) {
                return res.status(200).json({
                    message: 'Credit note already exists and has been fiscalized with ZRA.',
                    creditNote: existingCN,
                    zra_integration: {
                        success: true,
                        status: 'sent',
                    },
                });
            }
            
            // Return existing pending credit note
            return res.status(200).json({
                message: 'Credit note already exists. ZRA fiscalisation is pending in the queue.',
                creditNote: existingCN,
                zra_integration: {
                    success: false,
                    queued: true,
                    status: existingCN.zra_status,
                    error: existingCN.zra_error,
                    next_retry_at: existingCN.next_retry_at,
                },
            });
        }

        // Prepare return items and totals
        const tax_rate = 16;
        let subtotal = 0;
        const returnItems = [];

        for (const item of items) {
            const requestedProductId = Number(item.product_id);
            const requestedQuantity = Number(item.quantity);
            const requestedUnitPrice = Number(item.unit_price);
            const originalItem = originalSale.items.find(si => Number(si.product_id) === requestedProductId);

            if (!originalItem) {
                await t.rollback();
                return res.status(400).json({ message: `Product ${item.product_name || item.product_id} was not in the original sale` });
            }
            if (requestedQuantity > Number(originalItem.quantity)) {
                await t.rollback();
                return res.status(400).json({ message: `Return quantity for ${item.product_name || item.product_id} exceeds original quantity` });
            }

            const productData = await product.findByPk(requestedProductId, { transaction: t });
            if (!productData) {
                await t.rollback();
                return res.status(400).json({ message: `Product with ID ${requestedProductId} not found` });
            }

            const unit_price_inclusive = Number.isFinite(requestedUnitPrice) ? requestedUnitPrice : 0;
            const taxMultiplier = 1 + (Number(tax_rate) / 100);
            const unit_price_exclusive = unit_price_inclusive / taxMultiplier;

            const tax_exclusive_total = requestedQuantity * unit_price_exclusive;
            const tax_inclusive_total = requestedQuantity * unit_price_inclusive;

            subtotal += tax_exclusive_total;

            returnItems.push({
                product_id: requestedProductId,
                quantity: requestedQuantity,
                unit_price: unit_price_inclusive,
                total_price: tax_inclusive_total,
                tax_exclusive_total,
                product: productData
            });
        }

        const discount_amount = 0;
        const tax_amount = (subtotal * tax_rate) / 100;
        const total_amount = subtotal + tax_amount;

        // If the original sale is missing ZRA refs, make this eligible immediately so the retry job can observe it.
        const nextRetryAt = originalSale.sdcid && originalSale.receipt_no
            ? new Date(Date.now() + 1 * 60 * 1000)
            : new Date();

        // Persist Credit Note document with queue status
        const cn = await creditnote.create({
            receipt_number: `CN-${originalSale.receipt_number}`,
            user_id: req.user.id,
            approver_user_id: approver_user_id || req.user.id,
            customer_id: customerId,
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
            zra_status: 'pending', // Will be processed by queue
            zra_error: null,
            retry_count: 0,
            next_retry_at: nextRetryAt,
            last_retry_at: null,
            original_sale_id: originalSale.id,
            reason: reason || reason_label || 'Return',
            reason_code: reason_code || '03',
        }, { transaction: t });

        // Store items and update stock (add back)
        for (const item of returnItems) {
            await creditnoteitem.create({
                credit_note_id: cn.id,
                product_id: item.product_id,
                category_id: item.product?.category_id || null,
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

        // Commit the transaction
        await t.commit();
        clearDashboardCache(req.user.store_id);

        // Load the full credit note with associations
        let fullCN = await loadCreditNoteById(cn.id);

        const models = getModels(req);
        const zraIntegration = {
            success: false,
            queued: true,
            status: 'pending',
            next_retry_at: nextRetryAt,
            message: 'Credit note has been queued for ZRA fiscalisation',
        };

        if (originalSale.sdcid && originalSale.receipt_no) {
            const zraResult = await submitCreditNoteToZra({
                creditNoteInstance: fullCN,
                originalSale,
                returnItems,
                user: { store_id: req.user.store_id, id: req.user.id },
                reasonCode: reason_code || '03',
            });

            if (zraResult.success) {
                await applyCreditNoteZraResult(models, fullCN.id, zraResult);
                fullCN = await loadCreditNoteById(cn.id);

                zraIntegration.success = true;
                zraIntegration.queued = false;
                zraIntegration.status = 'sent';
                zraIntegration.message = 'Credit note fiscalised with ZRA successfully';
                zraIntegration.receipt_no = fullCN.receipt_no;
                zraIntegration.sdcid = fullCN.sdcid;
                zraIntegration.next_retry_at = fullCN.next_retry_at;
            } else {
                await applyCreditNoteZraResult(models, fullCN.id, zraResult, { retryDelayMinutes: 2 });
                fullCN = await loadCreditNoteById(cn.id);

                zraIntegration.error = zraResult.error;
                zraIntegration.pendingReason = zraResult.pendingReason || null;
                zraIntegration.next_retry_at = fullCN.next_retry_at;
            }
        }

        // Trigger the retry job to process this credit note if queueing is still required
        const zraRetryJob = req.app.locals.zraRetryJob;
        if (zraRetryJob) {
            setImmediate(() => {
                zraRetryJob.run().catch(err => {
                    console.error('Failed to trigger ZRA retry job for credit note:', err);
                });
            });
        }

        // Log the credit note creation
        await logCreditNotePersistence(models, req, {
            creditNoteInstance: fullCN,
            originalSale,
            outcome: zraIntegration.success ? 'sent' : 'queued',
            reason: zraIntegration.success ? 'Fiscalised immediately' : 'Queued for ZRA processing',
            actor: buildActorFromUser(req.user),
        });

        return res.status(201).json({
            message: zraIntegration.success
                ? 'Credit note created and fiscalised successfully.'
                : 'Credit note created successfully and queued for ZRA fiscalisation.',
            creditNote: fullCN,
            originalSale: {
                id: originalSale.id,
                receipt_number: originalSale.receipt_number,
                total_amount: originalSale.total_amount,
            },
            customer_info: {
                name: customerName,
                tpin: customerTPIN,
                has_valid_tpin: true,
                is_walk_in: (!originalSale.customer || !originalSale.customer.tpin),
            },
            zra_integration: zraIntegration,
            sage_integration: {
                queued: true,
                status: 'pending',
                batched: true,
                reference: creditNoteReference,
            },
        });

    } catch (error) {
        console.error('Credit note transaction failed:', error);
        
        if (t) {
            try { await t.rollback(); } catch (rbErr) { console.error('Rollback failed:', rbErr); }
        }
        
        const models = getModels(req);
        await logRequestAudit(models, req, {
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


// Add to your credit notes routes file
router.post('/retry-failed', async (req, res) => {
    try {
        // // Check admin权限
        // if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
        //     return res.status(403).json({ message: 'Access denied. Admin role required.' });
        // }

        const { creditNoteIds, forceAll = false } = req.body;
        let updatedCount = 0;
        let skippedCount = 0;
        const results = [];

        let targetIds = [];
        
        if (forceAll) {
            // Get all failed/pending credit notes that haven't succeeded
            const failedNotes = await creditnote.findAll({
                where: {
                    zra_status: ['failed', 'pending'],
                    sdcid: null  // Only those not yet fiscalized
                },
                attributes: ['id']
            });
            targetIds = failedNotes.map(n => n.id);
        } else if (creditNoteIds && creditNoteIds.length > 0) {
            targetIds = creditNoteIds;
        } else {
            return res.status(400).json({ 
                message: 'Please provide creditNoteIds array or set forceAll=true' 
            });
        }

        for (const id of targetIds) {
            const cn = await creditnote.findByPk(id, {
                include: [
                    { model: customer, as: 'customer' },
                    { model: sale, as: 'originalSale', include: [{ model: customer, as: 'customer' }] }
                ]
            });

            if (!cn) {
                results.push({ id, status: 'skipped', reason: 'Credit note not found' });
                skippedCount++;
                continue;
            }

            // Check if already successful
            if (cn.zra_status === 'sent' && cn.sdcid) {
                results.push({ id, status: 'skipped', reason: 'Already fiscalized' });
                skippedCount++;
                continue;
            }

            // Validate customer TPIN
            const originalCustomer = cn.originalSale?.customer;
            const creditNoteCustomer = cn.customer;

            if (!originalCustomer?.tpin || originalCustomer.tpin === 'null' || originalCustomer.tpin === '') {
                results.push({ 
                    id, 
                    status: 'failed', 
                    reason: 'Original sale customer missing TPIN',
                    customer_id: originalCustomer?.id,
                    customer_name: originalCustomer?.name
                });
                continue;
            }

            // Reset the credit note for retry
            await cn.update({
                zra_status: 'pending',
                next_retry_at: new Date(),
                retry_count: 0,
                zra_error: null,
                last_retry_at: null
            });

            results.push({ 
                id, 
                status: 'reset', 
                receipt_number: cn.receipt_number,
                customer_tpin: originalCustomer.tpin
            });
            updatedCount++;
        }

        // Trigger the retry job if there are items to process
        const zraRetryJob = req.app.locals.zraRetryJob;
        if (zraRetryJob && updatedCount > 0) {
            // Run immediately
            setImmediate(() => {
                zraRetryJob.run().catch(err => {
                    console.error('ZRA retry job failed:', err);
                });
            });
        }

        return res.status(200).json({
            message: `Reset ${updatedCount} credit notes for retry, skipped ${skippedCount}`,
            updated_count: updatedCount,
            skipped_count: skippedCount,
            results: results,
            retry_triggered: updatedCount > 0
        });

    } catch (error) {
        console.error('Failed to reset credit notes:', error);
        return res.status(500).json({ 
            message: 'Server error', 
            error: error.message 
        });
    }
});

// Endpoint to get failed credit notes
router.get('/failed', auth, async (req, res) => {
    try {
        if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const failedCreditNotes = await creditnote.findAll({
            where: {
                zra_status: ['failed', 'pending'],
                sdcid: null
            },
            attributes: ['id', 'receipt_number', 'zra_status', 'retry_count', 'zra_error', 'createdAt'],
            include: [
                { 
                    model: sale, 
                    as: 'originalSale',
                    attributes: ['id', 'receipt_number'],
                    include: [{ model: customer, as: 'customer', attributes: ['id', 'name', 'tpin'] }]
                },
                { model: customer, as: 'customer', attributes: ['id', 'name', 'tpin'] }
            ],
            order: [['createdAt', 'DESC']]
        });

        // Separate by error type
        const tpinIssues = failedCreditNotes.filter(cn => 
            cn.zra_error && cn.zra_error.includes('custTpin')
        );
        const otherIssues = failedCreditNotes.filter(cn => 
            !cn.zra_error || !cn.zra_error.includes('custTpin')
        );

        return res.status(200).json({
            total: failedCreditNotes.length,
            tpin_issues: tpinIssues.length,
            other_issues: otherIssues.length,
            credit_notes: failedCreditNotes,
            tpin_issues_list: tpinIssues.map(cn => ({
                id: cn.id,
                receipt_number: cn.receipt_number,
                sale_id: cn.originalSale?.id,
                customer_name: cn.originalSale?.customer?.name,
                customer_tpin: cn.originalSale?.customer?.tpin,
                error: cn.zra_error
            }))
        });

    } catch (error) {
        console.error('Error fetching failed credit notes:', error);
        return res.status(500).json({ message: 'Server error' });
    }
});
module.exports = router;
