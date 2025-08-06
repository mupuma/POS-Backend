const express = require('express');
const router = express.Router();
const { store, user } = require('../models'); // Adjust path as needed
const { body, validationResult, param } = require('express-validator');

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

    body('next_invoice_number')
        .optional()
        .isLength({ min: 1, max: 50 })
        .withMessage('Next invoice number must be between 1 and 50 characters')
        .matches(/^[A-Z]{3}-\d{4}-\d+$/)
        .withMessage('Invoice number format must be like INV-1001-1')
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

        const { store_number, store_location, store_mobile_no, next_invoice_number } = req.body;

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

        // Generate default invoice number if not provided
        let invoiceNumber = next_invoice_number;
        if (!invoiceNumber) {
            // Extract numeric part from store number for invoice
            const numericPart = store_number.replace(/[^0-9]/g, '') || '1001';
            invoiceNumber = `INV-${numericPart}-1`;
        }

        const newStore = await store.create({
            store_number,
            store_location,
            store_mobile_no,
            next_invoice_number: invoiceNumber
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

    body('next_invoice_number')
        .optional()
        .isLength({ min: 1, max: 50 })
        .withMessage('Next invoice number must be between 1 and 50 characters')
        .matches(/^[A-Z]{3}-\d{4}-\d+$/)
        .withMessage('Invoice number format must be like INV-1001-1')
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
                    id: { [require('sequelize').Op.ne]: storeId }
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
 * @desc    Update only the next invoice number (for admin use)
 * @access  Private
 */
router.patch('/:id/invoice-number', [
    param('id').isInt().withMessage('Store ID must be a valid integer'),
    body('next_invoice_number')
        .isLength({ min: 1, max: 50 })
        .withMessage('Next invoice number must be between 1 and 50 characters')
        .matches(/^[A-Z]{3}-\d{4}-\d+$/)
        .withMessage('Invoice number format must be like INV-1001-1')
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
        const { next_invoice_number } = req.body;

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
            { next_invoice_number },
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
                previous_invoice_number: existingStore.next_invoice_number,
                current_invoice_number: updatedStore.next_invoice_number
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

module.exports = router;