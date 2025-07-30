const express = require('express');
const { category, product } = require('../models');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');

const router = express.Router();

// Get all categories with pagination and search
router.get('/', auth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const search = req.query.search || '';
        const include_products = req.query.include_products === 'true';

        // Build where clause
        const whereClause = {};

        if (search) {
            whereClause[Op.or] = [
                { name: { [Op.like]: `%${search}%` } },
                { description: { [Op.like]: `%${search}%` } }
            ];
        }

        const includeOptions = [];

        if (include_products) {
            includeOptions.push({
                model: product,
                as: 'products',
                attributes: ['id', 'name', 'price', 'stock_quantity', 'is_active']
            });
        }

        const { count, rows } = await category.findAndCountAll({
            where: whereClause,
            limit,
            offset,
            order: [['name', 'ASC']],
            include: includeOptions
        });

        res.json({
            categories: rows,
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

// Get all categories (simple list for dropdowns)
router.get('/list', auth, async (req, res) => {
    try {
        const categories = await category.findAll({
            attributes: ['id', 'name'],
            order: [['name', 'ASC']]
        });

        res.json({
            categories
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get category by ID
router.get('/:id', auth, async (req, res) => {
    try {
        const categoryData = await category.findByPk(req.params.id, {
            include: [
                {
                    model: product,
                    as: 'products',
                    attributes: ['id', 'name', 'price', 'stock_quantity', 'is_active']
                }
            ]
        });

        if (!categoryData) {
            return res.status(404).json({ message: 'Category not found' });
        }

        res.json({ category: categoryData });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Create new category (admin only)
router.post('/', auth, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Only admins can create categories' });
        }

        const { name, description } = req.body;

        // Validate required fields
        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Category name is required' });
        }

        // Check if category name already exists
        const existingCategory = await category.findOne({
            where: { name: name.trim() }
        });

        if (existingCategory) {
            return res.status(400).json({ message: 'Category with this name already exists' });
        }

        const newCategory = await category.create({
            name: name.trim(),
            description: description ? description.trim() : null
        });

        res.status(201).json({
            message: 'Category created successfully',
            category: newCategory
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Update category (admin only)
router.put('/:id', auth, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Only admins can update categories' });
        }

        const categoryData = await category.findByPk(req.params.id);

        if (!categoryData) {
            return res.status(404).json({ message: 'Category not found' });
        }

        const { name, description } = req.body;

        // Validate name if provided
        if (name !== undefined && (!name || !name.trim())) {
            return res.status(400).json({ message: 'Category name cannot be empty' });
        }

        // Check if new name already exists (excluding current category)
        if (name !== undefined && name.trim() !== categoryData.name) {
            const existingCategory = await category.findOne({
                where: {
                    name: name.trim(),
                    id: { [Op.ne]: req.params.id }
                }
            });

            if (existingCategory) {
                return res.status(400).json({ message: 'Category with this name already exists' });
            }
        }

        // Update category
        const updateData = {};
        if (name !== undefined) updateData.name = name.trim();
        if (description !== undefined) updateData.description = description ? description.trim() : null;

        await categoryData.update(updateData);

        res.json({
            message: 'Category updated successfully',
            category: categoryData
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Delete category (admin only)
router.delete('/:id', auth, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Only admins can delete categories' });
        }

        const categoryData = await category.findByPk(req.params.id);

        if (!categoryData) {
            return res.status(404).json({ message: 'Category not found' });
        }

        // Check if category has products
        const productCount = await product.count({
            where: { category_id: req.params.id }
        });

        if (productCount > 0) {
            return res.status(400).json({
                message: `Cannot delete category. It has ${productCount} products associated with it. Please move or delete the products first.`
            });
        }

        await categoryData.destroy();

        res.json({
            message: 'Category deleted successfully'
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get category statistics
router.get('/:id/stats', auth, async (req, res) => {
    try {
        const categoryData = await category.findByPk(req.params.id);

        if (!categoryData) {
            return res.status(404).json({ message: 'Category not found' });
        }

        const products = await product.findAll({
            where: { category_id: req.params.id },
            attributes: ['id', 'name', 'price', 'cost', 'stock_quantity', 'is_active']
        });

        const activeProducts = products.filter(p => p.is_active);
        const totalStockValue = products.reduce((sum, p) => sum + (parseFloat(p.price) * p.stock_quantity), 0);
        const totalCostValue = products.reduce((sum, p) => sum + (parseFloat(p.cost || 0) * p.stock_quantity), 0);
        const lowStockProducts = products.filter(p => p.stock_quantity <= (p.min_stock_level || 0));

        const stats = {
            category: categoryData,
            total_products: products.length,
            active_products: activeProducts.length,
            inactive_products: products.length - activeProducts.length,
            total_stock_quantity: products.reduce((sum, p) => sum + p.stock_quantity, 0),
            total_stock_value: totalStockValue,
            total_cost_value: totalCostValue,
            potential_profit: totalStockValue - totalCostValue,
            low_stock_products_count: lowStockProducts.length,
            average_product_price: products.length > 0 ?
                products.reduce((sum, p) => sum + parseFloat(p.price), 0) / products.length : 0
        };

        res.json(stats);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get products by category with pagination
router.get('/:id/products', auth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const active_only = req.query.active_only === 'true';
        const search = req.query.search || '';

        const categoryData = await category.findByPk(req.params.id);

        if (!categoryData) {
            return res.status(404).json({ message: 'Category not found' });
        }

        // Build where clause
        const whereClause = { category_id: req.params.id };

        if (active_only) {
            whereClause.is_active = true;
        }

        if (search) {
            whereClause[Op.or] = [
                { name: { [Op.like]: `%${search}%` } },
                { barcode: { [Op.like]: `%${search}%` } }
            ];
        }

        const { count, rows } = await product.findAndCountAll({
            where: whereClause,
            limit,
            offset,
            order: [['name', 'ASC']],
            include: [
                { model: category, as: 'category' }
            ]
        });

        res.json({
            category: categoryData,
            products: rows,
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

// Move products from one category to another (admin only)
router.post('/:id/move-products', auth, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Only admins can move products between categories' });
        }

        const { target_category_id, product_ids } = req.body;

        if (!target_category_id || !product_ids || !Array.isArray(product_ids)) {
            return res.status(400).json({
                message: 'Target category ID and product IDs array are required'
            });
        }

        // Validate source category exists
        const sourceCategory = await category.findByPk(req.params.id);
        if (!sourceCategory) {
            return res.status(404).json({ message: 'Source category not found' });
        }

        // Validate target category exists
        const targetCategory = await category.findByPk(target_category_id);
        if (!targetCategory) {
            return res.status(404).json({ message: 'Target category not found' });
        }

        // Validate all products exist and belong to source category
        const products = await product.findAll({
            where: {
                id: { [Op.in]: product_ids },
                category_id: req.params.id
            }
        });

        if (products.length !== product_ids.length) {
            return res.status(400).json({
                message: 'Some products not found or do not belong to the source category'
            });
        }

        // Move products
        await product.update(
            { category_id: target_category_id },
            {
                where: {
                    id: { [Op.in]: product_ids }
                }
            }
        );

        res.json({
            message: `Successfully moved ${products.length} products from "${sourceCategory.name}" to "${targetCategory.name}"`,
            moved_products: products.length,
            source_category: sourceCategory.name,
            target_category: targetCategory.name
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;