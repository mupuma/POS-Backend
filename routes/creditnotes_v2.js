const express = require('express');
const { sale, creditnote, creditnoteitem, product, user, customer, store, productinventory } = require('../models');
const auth = require('../middleware/auth');
const { Op, literal } = require('sequelize');

const ZRAIntegrationService = require('../services/credit-note/generateSmartInvoiceCreditNote');
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

const router = express.Router();
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

// Create credit note (return) - positive amounts; CRN prefix identifies CN
router.post('/:saleId/return', auth, async (req, res) => {
    const t = await creditnote.sequelize.transaction();

    try {
        const { saleId } = req.params;
        const { items, reason, reason_code, reason_label } = req.body;

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
            return res.status(404).json({ message: 'Original sale not found' });
        }

        if (originalSale.cashier && originalSale.cashier.store_id !== req.user.store_id) {
            await t.rollback();
            return res.status(403).json({ message: 'Access denied: Sale does not belong to your store' });
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
        const zraService = new ZRAIntegrationService();
        const salesData = await zraService.transformToZRACreditNoteSalesData(
            creditNoteData,
            returnItems,
            req.user,
            reason_code || '03',
             originalSale.receipt_no
        );
        const salesResponse = await zraService.sendCreditNoteSalesData(salesData);

        if (!salesResponse.success) {
            await t.rollback();
            return res.status(500).json({
                message: 'Failed to process credit note with ZRA system',
                zra_errors: [salesResponse.error]
            });
        }

        const saveSalesData = salesResponse.data.data;
        if (!saveSalesData) {
            await t.rollback();
            return res.status(500).json({ message: 'No data received from ZRA credit note endpoint' });
        }
        let qrFilePath = null;
        if (saveSalesData.qrCodeUrl && saveSalesData.rcptNo) {
            try {
                qrFilePath = await generateQrCode(
                    saveSalesData.qrCodeUrl,
                    saveSalesData.rcptNo,
                    "./qrcodes"
                );
            } catch (qrError) {
                console.error('QR Code generation failed:', qrError);
                // Don't fail the entire transaction for QR code generation
            }
        }
        // Persist Credit Note document (separate table)
        const cn = await creditnote.create({
            receipt_number: `CN-${originalSale.receipt_number}`,
            user_id: req.user.id,
            customer_id: originalSale.customer_id || null,
            subtotal,
            discount_amount,
            tax_amount,
            total_amount,
            payment_method: originalSale.payment_method,
            amount_paid: total_amount,
            change_amount: 0,
            notes: `Credit Note for Sale #${originalSale.id} - ${reason || reason_label || 'Return'}`,
            invnumber: saveSalesData.invnumber || null,
            receipt_no: saveSalesData.rcptNo || null,
            sdcid: saveSalesData.sdcId || null,
            receiptsig: saveSalesData.rcptSign || null,
            intrldata: saveSalesData.intrlData || null,
            qrcode_url: saveSalesData.qrCodeUrl || null,
            vsdcrcpdate: saveSalesData.vsdcRcptPbctDate || null,
            invoice_no: `CRN${saveSalesData.sdcId.substring(3)}/${saveSalesData.rcptNo}`,
            qrfilepath:qrFilePath,
            original_sale_id: originalSale.id,
            reason_label: reason || reason_label || 'Return',


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

        await t.commit();

        const fullCN = await creditnote.findByPk(cn.id, {
            include: [
                { model: creditnoteitem, as: 'items', include: [{ model: product, as: 'product' }] },
                { model: user, as: 'cashier', attributes: ['id', 'full_name'], include: [{ model: store, as: 'store', attributes: ['store_location', 'store_mobile_no'] }] },
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

        // Note: Sage integration will be handled separately at day-end (manual trigger)

    } catch (error) {
        await t.rollback();
        return res.status(500).json({ message: 'Server error', error: error.message });
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
            { model: creditnoteitem, as: 'items', include: [{ model: product, as: 'product' }] }
        ];

        const { count, rows } = await creditnote.findAndCountAll({
            limit,
            offset,
            order: [['credit_note_date', 'DESC']],
            include
        });

        res.json({
            creditNotes: rows,
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
