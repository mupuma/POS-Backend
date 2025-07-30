const express = require('express');
const { discount, sale } = require('../models');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');

const router = express.Router();

// Create new discount
router.post('/', auth, async (req, res) => {
    try {
        const { name, type, value, is_active = true } = req.body;

        // Validation
        if (!name || !type || value === undefined || value === null) {
            return res.status(400).json({
                message: 'Name, type, and value are required'
            });
        }

        if (!['percentage', 'fixed_amount'].includes(type)) {
            return res.status(400).json({
                message: 'Type must be either "percentage" or "fixed_amount"'
            });
        }

        if (value <= 0) {
            return res.status(400).json({
                message: 'Value must be greater than 0'
            });
        }

        // Additional validation for percentage
        if (type === 'percentage' && value > 100) {
            return res.status(400).json({
                message: 'Percentage discount cannot exceed 100%'
            });
        }

        // Check if discount name already exists
        const existingDiscount = await discount.findOne({
            where: { name: name.trim() }
        });

        if (existingDiscount) {
            return res.status(400).json({
                message: 'Discount with this name already exists'
            });
        }

        const newDiscount = await discount.create({
            name: name.trim(),
            type,
            value: parseFloat(value),
            is_active
        });

        res.status(201).json({
            message: 'Discount created successfully',
            discount: newDiscount
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get all discounts with pagination and filtering
router.get('/', auth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const { active, type, search } = req.query;

        // Build where clause
        const whereClause = {};

        if (active !== undefined) {
            whereClause.is_active = active === 'true';
        }

        if (type && ['percentage', 'fixed_amount'].includes(type)) {
            whereClause.type = type;
        }

        if (search) {
            whereClause.name = {
                [Op.like]: `%${search}%`
            };
        }

        const { count, rows } = await discount.findAndCountAll({
            where: whereClause,
            limit,
            offset,
            order: [['created_at', 'DESC']]
        });

        res.json({
            discounts: rows,
            pagination: {
                current_page: page,
                total_pages: Math.ceil(count / limit),
                total_records: count,
                per_page: limit
            }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get active discounts only (for POS use)
router.get('/active', auth, async (req, res) => {
    try {
        const activeDiscounts = await discount.findAll({
            where: {
                is_active: true
            },
            order: [['name', 'ASC']]
        });

        res.json({
            discounts: activeDiscounts
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get discount by ID
router.get('/:id', auth, async (req, res) => {
    try {
        const discountData = await discount.findByPk(req.params.id);

        if (!discountData) {
            return res.status(404).json({ message: 'Discount not found' });
        }

        res.json({ discount: discountData });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Update discount
router.put('/:id', auth, async (req, res) => {
    try {
        const { name, type, value, is_active } = req.body;

        const discountData = await discount.findByPk(req.params.id);

        if (!discountData) {
            return res.status(404).json({ message: 'Discount not found' });
        }

        // Validation
        if (name !== undefined && !name.trim()) {
            return res.status(400).json({ message: 'Name cannot be empty' });
        }

        if (type !== undefined && !['percentage', 'fixed_amount'].includes(type)) {
            return res.status(400).json({
                message: 'Type must be either "percentage" or "fixed_amount"'
            });
        }

        if (value !== undefined && value <= 0) {
            return res.status(400).json({
                message: 'Value must be greater than 0'
            });
        }

        if (type === 'percentage' && value !== undefined && value > 100) {
            return res.status(400).json({
                message: 'Percentage discount cannot exceed 100%'
            });
        }

        // Check if new name already exists (excluding current discount)
        if (name !== undefined && name.trim() !== discountData.name) {
            const existingDiscount = await discount.findOne({
                where: {
                    name: name.trim(),
                    id: { [Op.ne]: req.params.id }
                }
            });

            if (existingDiscount) {
                return res.status(400).json({
                    message: 'Discount with this name already exists'
                });
            }
        }

        // Update fields
        const updateData = {};
        if (name !== undefined) updateData.name = name.trim();
        if (type !== undefined) updateData.type = type;
        if (value !== undefined) updateData.value = parseFloat(value);
        if (is_active !== undefined) updateData.is_active = is_active;

        await discountData.update(updateData);

        res.json({
            message: 'Discount updated successfully',
            discount: discountData
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Toggle discount status (activate/deactivate)
router.patch('/:id/toggle', auth, async (req, res) => {
    try {
        const discountData = await discount.findByPk(req.params.id);

        if (!discountData) {
            return res.status(404).json({ message: 'Discount not found' });
        }

        await discountData.update({
            is_active: !discountData.is_active
        });

        res.json({
            message: `Discount ${discountData.is_active ? 'activated' : 'deactivated'} successfully`,
            discount: discountData
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Delete discount (soft delete by deactivating)
router.delete('/:id', auth, async (req, res) => {
    try {
        const discountData = await discount.findByPk(req.params.id);

        if (!discountData) {
            return res.status(404).json({ message: 'Discount not found' });
        }

        // Check if discount is being used in any sales
        const salesCount = await sale.count({
            where: { discount_id: req.params.id }
        });

        if (salesCount > 0) {
            // Don't delete, just deactivate
            await discountData.update({ is_active: false });
            return res.json({
                message: 'Discount deactivated successfully (cannot delete as it has been used in sales)',
                discount: discountData
            });
        }

        // If no sales use this discount, we can actually delete it
        await discountData.destroy();

        res.json({
            message: 'Discount deleted successfully'
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get discount usage statistics
router.get('/:id/stats', auth, async (req, res) => {
    try {
        const discountData = await discount.findByPk(req.params.id);

        if (!discountData) {
            return res.status(404).json({ message: 'Discount not found' });
        }

        const salesWithDiscount = await sale.findAll({
            where: { discount_id: req.params.id }
        });

        const stats = {
            discount: discountData,
            usage_count: salesWithDiscount.length,
            total_discount_amount: salesWithDiscount.reduce((sum, s) => sum + parseFloat(s.discount_amount), 0),
            total_sales_value: salesWithDiscount.reduce((sum, s) => sum + parseFloat(s.total_amount), 0),
            first_used: salesWithDiscount.length > 0 ? Math.min(...salesWithDiscount.map(s => s.sale_date)) : null,
            last_used: salesWithDiscount.length > 0 ? Math.max(...salesWithDiscount.map(s => s.sale_date)) : null
        };

        res.json(stats);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Calculate discount amount for given subtotal (utility endpoint)
router.post('/calculate', auth, async (req, res) => {
    try {
        const { discount_id, subtotal } = req.body;

        if (!discount_id || !subtotal) {
            return res.status(400).json({
                message: 'Discount ID and subtotal are required'
            });
        }

        const discountData = await discount.findByPk(discount_id);

        if (!discountData) {
            return res.status(404).json({ message: 'Discount not found' });
        }

        if (!discountData.is_active) {
            return res.status(400).json({ message: 'Discount is not active' });
        }

        let discount_amount = 0;
        if (discountData.type === 'percentage') {
            discount_amount = (parseFloat(subtotal) * parseFloat(discountData.value)) / 100;
        } else {
            discount_amount = parseFloat(discountData.value);
        }

        // Ensure discount doesn't exceed subtotal
        discount_amount = Math.min(discount_amount, parseFloat(subtotal));

        res.json({
            discount: discountData,
            subtotal: parseFloat(subtotal),
            discount_amount,
            final_amount: parseFloat(subtotal) - discount_amount
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;