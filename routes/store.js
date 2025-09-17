const express = require('express');
const router = express.Router();
const { store, user } = require('../models');
const { body, validationResult, param } = require('express-validator');
const { Op } = require('sequelize');

// Middleware for authentication (adjust as needed)
// const auth = require('../middleware/auth');

/**
 * @route   GET /api/stores
 * @desc    Get all stores
 * @access  Private
 */
router.get('/', async (req, res) => {
    try {
        const stores = await store.findAll({
            include: [
                {
                    model: user,
                    as: 'users',
                    attributes: ['id', 'full_name', 'email', 'role']
                }
            ],
            order: [['id', 'ASC']]
        });

        res.json({
            success: true,
            count: stores.length,
            data: stores
        });
    } catch (error) {
        console.error('Get stores error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching stores'
        });
    }
});

/**
 * @route   GET /api/stores/:id
 * @desc    Get single store by ID
 * @access  Private
 */
router.get('/:id', [
    param('id').isInt().withMessage('Store ID must be a valid integer')
], async (req, res) => {
    try {
        // Check for validation errors
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const storeData = await store.findByPk(req.params.id, {
            include: [
                {
                    model: user,
                    as: 'users',
                    attributes: ['id', 'full_name', 'email', 'role', 'created_at']
                }
            ]
        });

        if (!storeData) {
            return res.status(404).json({
                success: false,
                message: 'Store not found'
            });
        }

        res.json({
            success: true,
            data: storeData
        });
    } catch (error) {
        console.error('Get store error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching store'
        });
    }
});

/**
 * @route   POST /api/stores
 * @desc    Create new store
 * @access  Private
 */
router.post('/', [
    body('store_number')
        .isLength({ min: 1, max: 10 })
        .withMessage('Store number must be between 1 and 10 characters')
        .matches(/^[A-Z0-9]+$/)
        .withMessage('Store number must contain only uppercase letters and numbers'),

    body('store_location')
        .isLength({ min: 1, max: 255 })
        .withMessage('Store location must be between 1 and 255 characters')
        .trim(),

    body('store_mobile_no')
        .isLength({ min: 10, max: 10 })
        .withMessage('Mobile number must be exactly 10 characters')
        .matches(/^[0-9]+$/)
        .withMessage('Mobile number must contain only digits'),

    body('invoice_number')
        .optional()
        .isLength({ min: 1, max: 50 })
        .withMessage('Invoice number must be between 1 and 50 characters')
        .matches(/^INV\d+-\d+$/)
        .withMessage('Invoice number format must be like INV1001-1'),

    // New fields for ZRA integration
    body('store_identifier')
        .optional()
        .isLength({ min: 1, max: 20 })
        .withMessage('Store identifier must be between 1 and 20 characters'),
        
    body('zra_tpin')
        .optional()
        .isLength({ min: 10, max: 10 })
        .withMessage('ZRA TPIN must be exactly 10 characters')
        .matches(/^[0-9]+$/)
        .withMessage('ZRA TPIN must contain only digits'),
        
    body('zra_bhf_id')
        .optional()
        .isLength({ min: 1, max: 10 })
        .withMessage('ZRA BHF ID must be between 1 and 10 characters'),
        
    body('invoice_prefix')
        .optional()
        .isLength({ min: 1, max: 10 })
        .withMessage('Invoice prefix must be between 1 and 10 characters'),
        
    body('merchant_number')
        .optional()
        .isLength({ min: 1, max: 20 })
        .withMessage('Merchant number must be between 1 and 20 characters'),
        
    body('receipt_sequence')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Receipt sequence must be a positive integer'),
        
    body('receipt_number_length')
        .optional()
        .isInt({ min: 1, max: 10 })
        .withMessage('Receipt number length must be between 1 and 10'),
        
    body('zra_enabled')
        .optional()
        .isBoolean()
        .withMessage('ZRA enabled must be a boolean value')
], async (req, res) => {
    try {
        // Check for validation errors
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const { 
            store_number, 
            store_location, 
            store_mobile_no, 
            invoice_number,
            store_identifier,
            zra_tpin,
            zra_bhf_id,
            invoice_prefix,
            merchant_number,
            receipt_sequence,
            receipt_number_length,
            zra_enabled
        } = req.body;

        // Check if store number already exists
        const existingStore = await store.findOne({
            where: { store_number }
        });

        if (existingStore) {
            return res.status(400).json({
                success: false,
                message: 'Store number already exists'
            });
        }

        // Generate default invoice number if not provided using model's logic
        let finalInvoiceNumber = invoice_number;
        if (!finalInvoiceNumber) {
            // Create a temporary store instance to use its method
            const tempStore = store.build({ store_number });
            finalInvoiceNumber = tempStore.generateInvoiceNumber();
            // Reset to initial value for the actual sequence
            finalInvoiceNumber = finalInvoiceNumber.replace(/-(\d+)$/, '-1');
        }

        const newStore = await store.create({
            store_number,
            store_location,
            store_mobile_no,
            invoice_number: finalInvoiceNumber,
            store_identifier,
            zra_tpin,
            zra_bhf_id,
            invoice_prefix,
            merchant_number,
            receipt_sequence: receipt_sequence || 1,
            receipt_number_length: receipt_number_length || 6,
            zra_enabled: zra_enabled !== undefined ? zra_enabled : true
        });

        res.status(201).json({
            success: true,
            message: 'Store created successfully',
            data: newStore
        });
    } catch (error) {
        console.error('Create store error:', error);

        // Handle unique constraint errors
        if (error.name === 'SequelizeUniqueConstraintError') {
            return res.status(400).json({
                success: false,
                message: 'Store with this information already exists',
                field: error.errors[0]?.path
            });
        }

        res.status(500).json({
            success: false,
            message: 'Server error while creating store'
        });
    }
});

/**
 * @route   PUT /api/stores/:id
 * @desc    Update store
 * @access  Private
 */
router.put('/:id', [
    param('id').isInt().withMessage('Store ID must be a valid integer'),

    body('store_number')
        .optional()
        .isLength({ min: 1, max: 10 })
        .withMessage('Store number must be between 1 and 10 characters')
        .matches(/^[A-Z0-9]+$/)
        .withMessage('Store number must contain only uppercase letters and numbers'),

    body('store_location')
        .optional()
        .isLength({ min: 1, max: 255 })
        .withMessage('Store location must be between 1 and 255 characters')
        .trim(),

    body('store_mobile_no')
        .optional()
        .isLength({ min: 10, max: 10 })
        .withMessage('Mobile number must be exactly 10 characters')
        .matches(/^[0-9]+$/)
        .withMessage('Mobile number must contain only digits'),

    body('invoice_number')
        .optional()
        .isLength({ min: 1, max: 50 })
        .withMessage('Invoice number must be between 1 and 50 characters')
        .matches(/^INV\d+-\d+$/)
        .withMessage('Invoice number format must be like INV1001-1'),
        
    // New fields for ZRA integration
    body('store_identifier')
        .optional()
        .isLength({ min: 1, max: 20 })
        .withMessage('Store identifier must be between 1 and 20 characters'),
        
    body('zra_tpin')
        .optional()
        .isLength({ min: 9, max: 9 })
        .withMessage('ZRA TPIN must be exactly 9 characters')
        .matches(/^[0-9]+$/)
        .withMessage('ZRA TPIN must contain only digits'),
        
    body('zra_bhf_id')
        .optional()
        .isLength({ min: 1, max: 10 })
        .withMessage('ZRA BHF ID must be between 1 and 10 characters'),
        
    body('invoice_prefix')
        .optional()
        .isLength({ min: 1, max: 10 })
        .withMessage('Invoice prefix must be between 1 and 10 characters'),
        
    body('merchant_number')
        .optional()
        .isLength({ min: 1, max: 20 })
        .withMessage('Merchant number must be between 1 and 20 characters'),
        
    body('receipt_sequence')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Receipt sequence must be a positive integer'),
        
    body('receipt_number_length')
        .optional()
        .isInt({ min: 1, max: 10 })
        .withMessage('Receipt number length must be between 1 and 10'),
        
    body('zra_enabled')
        .optional()
        .isBoolean()
        .withMessage('ZRA enabled must be a boolean value')
], async (req, res) => {
    try {
        // Check for validation errors
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const storeId = req.params.id;
        const updateData = req.body;

        // Check if store exists
        const existingStore = await store.findByPk(storeId);
        if (!existingStore) {
            return res.status(404).json({
                success: false,
                message: 'Store not found'
            });
        }

        // If updating store_number, check if it already exists (excluding current store)
        if (updateData.store_number) {
            const duplicateStore = await store.findOne({
                where: {
                    store_number: updateData.store_number,
                    id: { [Op.ne]: storeId }
                }
            });

            if (duplicateStore) {
                return res.status(400).json({
                    success: false,
                    message: 'Store number already exists'
                });
            }
        }

        // Update the store
        const [updatedRows] = await store.update(updateData, {
            where: { id: storeId }
        });

        if (updatedRows === 0) {
            return res.status(400).json({
                success: false,
                message: 'No changes made to store'
            });
        }

        // Fetch updated store
        const updatedStore = await store.findByPk(storeId, {
            include: [
                {
                    model: user,
                    as: 'users',
                    attributes: ['id', 'full_name', 'email', 'role']
                }
            ]
        });

        res.json({
            success: true,
            message: 'Store updated successfully',
            data: updatedStore
        });
    } catch (error) {
        console.error('Update store error:', error);

        // Handle unique constraint errors
        if (error.name === 'SequelizeUniqueConstraintError') {
            return res.status(400).json({
                success: false,
                message: 'Store with this information already exists',
                field: error.errors[0]?.path
            });
        }

        res.status(500).json({
            success: false,
            message: 'Server error while updating store'
        });
    }
});

/**
 * @route   DELETE /api/stores/:id
 * @desc    Delete store
 * @access  Private
 */
router.delete('/:id', [
    param('id').isInt().withMessage('Store ID must be a valid integer')
], async (req, res) => {
    try {
        // Check for validation errors
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const storeId = req.params.id;

        // Check if store exists
        const existingStore = await store.findByPk(storeId);
        if (!existingStore) {
            return res.status(404).json({
                success: false,
                message: 'Store not found'
            });
        }

        // Check if store has associated users
        const associatedUsers = await user.count({
            where: { store_id: storeId }
        });

        if (associatedUsers > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete store. It has ${associatedUsers} associated user(s). Please reassign or remove users first.`
            });
        }

        // Delete the store
        await store.destroy({
            where: { id: storeId }
        });

        res.json({
            success: true,
            message: 'Store deleted successfully'
        });
    } catch (error) {
        console.error('Delete store error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while deleting store'
        });
    }
});

/**
 * @route   GET /api/stores/:id/users
 * @desc    Get all users for a specific store
 * @access  Private
 */
router.get('/:id/users', [
    param('id').isInt().withMessage('Store ID must be a valid integer')
], async (req, res) => {
    try {
        // Check for validation errors
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const storeId = req.params.id;

        // Check if store exists
        const existingStore = await store.findByPk(storeId);
        if (!existingStore) {
            return res.status(404).json({
                success: false,
                message: 'Store not found'
            });
        }

        // Get users for this store
        const storeUsers = await user.findAll({
            where: { store_id: storeId },
            attributes: ['id', 'full_name', 'email', 'role', 'created_at'],
            order: [['created_at', 'DESC']]
        });

        res.json({
            success: true,
            store: {
                id: existingStore.id,
                store_number: existingStore.store_number,
                store_location: existingStore.store_location
            },
            count: storeUsers.length,
            users: storeUsers
        });
    } catch (error) {
        console.error('Get store users error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching store users'
        });
    }
});

/**
 * @route   PATCH /api/stores/:id/invoice-number
 * @desc    Update only the invoice number (for admin use)
 * @access  Private
 */
router.patch('/:id/invoice-number', [
    param('id').isInt().withMessage('Store ID must be a valid integer'),
    body('invoice_number')
        .isLength({ min: 1, max: 50 })
        .withMessage('Invoice number must be between 1 and 50 characters')
        .matches(/^INV\d+-\d+$/)
        .withMessage('Invoice number format must be like INV1001-1')
], async (req, res) => {
    try {
        // Check for validation errors
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const storeId = req.params.id;
        const { invoice_number } = req.body;

        // Check if store exists
        const existingStore = await store.findByPk(storeId);
        if (!existingStore) {
            return res.status(404).json({
                success: false,
                message: 'Store not found'
            });
        }

        // Update only the invoice number
        await store.update(
            { invoice_number },
            { where: { id: storeId } }
        );

        // Fetch updated store
        const updatedStore = await store.findByPk(storeId);

        res.json({
            success: true,
            message: 'Invoice number updated successfully',
            data: {
                id: updatedStore.id,
                store_number: updatedStore.store_number,
                previous_invoice_number: existingStore.invoice_number,
                current_invoice_number: updatedStore.invoice_number
            }
        });
    } catch (error) {
        console.error('Update invoice number error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while updating invoice number'
        });
    }
});

/**
 * @route   POST /api/stores/:id/generate-invoice
 * @desc    Generate a new invoice number for a store (increments sequence)
 * @access  Private
 */
router.post('/:id/generate-invoice', [
    param('id').isInt().withMessage('Store ID must be a valid integer')
], async (req, res) => {
    try {
        const storeId = req.params.id;

        // Check if store exists
        const storeInstance = await store.findByPk(storeId);
        if (!storeInstance) {
            return res.status(404).json({
                success: false,
                message: 'Store not found'
            });
        }

        // Use the model's method to generate and save the new invoice number
        const newInvoiceNumber = await storeInstance.generateCISInvoiceNumber();

        res.json({
            success: true,
            message: 'New invoice number generated successfully',
            data: {
                id: storeInstance.id,
                store_number: storeInstance.store_number,
                previous_invoice_number: storeInstance.invoice_number,
                new_invoice_number: newInvoiceNumber
            }
        });
    } catch (error) {
        console.error('Generate invoice number error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while generating invoice number'
        });
    }
});

// Helper function to get store configuration
async function getStoreConfig(storeId, transaction = null) {
    const options = {};
    if (transaction) options.transaction = transaction;
    
    const storeData = await store.findByPk(storeId, options);
    if (!storeData) {
        throw new Error(`Store with ID ${storeId} not found`);
    }
    
    return {
        sdcid: storeData.store_identifier,
        tpin: storeData.zra_tpin,
        bhfId: storeData.zra_bhf_id,
        zraEnabled: storeData.zra_enabled,
        invoicePrefix: storeData.invoice_prefix,
        merchantNumber: storeData.merchant_number,
        receiptSequence: storeData.receipt_sequence,
        receiptNumberLength: storeData.receipt_number_length,
        invoiceNumber: storeData.invoice_number,
        // Add method to generate invoice numbers using the model's logic
        generateInvoiceNumber: () => storeData.generateInvoiceNumber()
    };
}

module.exports = {
    router,
    getStoreConfig
};