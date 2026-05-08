const express = require('express');
const { category, product, productinventory, store } = require('../models');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');
const logger = require('../utils/logger');

const router = express.Router();
const siteId = process.env.SITE_ID || 'unknown-site';

// Get all categories with pagination and search
router.get('/', auth, async (req, res) => {
    const startedAt = new Date();

    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const search = req.query.search || '';
        const include_products = req.query.include_products === 'true';

        logger.info('categories_list_started', {
            siteId,
            userId: req.user?.id,
            page,
            limit,
            search,
            includeProducts: include_products,
            startedAt
        });

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
                attributes: ['id', 'name', 'price', 'is_active'],
                include: [{
                    model: productinventory,
                    as: 'inventories',
                    required: false,
                    attributes: ['store_id', 'stock_quantity', 'min_stock_level'],
                    include: [{ model: store, as: 'store', attributes: ['id', 'store_location'] }]
                }]
            });
        }

        const { count, rows } = await category.findAndCountAll({
            where: whereClause,
            limit,
            offset,
            order: [['name', 'ASC']],
            include: includeOptions
        });

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('categories_list_completed', {
            siteId,
            userId: req.user?.id,
            totalRecords: count,
            returnedRecords: rows.length,
            page,
            durationMs
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
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('categories_list_error', {
            siteId,
            userId: req.user?.id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

// Get all categories (simple list for dropdowns)
router.get('/list', auth, async (req, res) => {
    const startedAt = new Date();

    try {
        logger.info('categories_simple_list_started', {
            siteId,
            userId: req.user?.id,
            startedAt
        });

        const categories = await category.findAll({
            attributes: ['id', 'name'],
            order: [['name', 'ASC']]
        });

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('categories_simple_list_completed', {
            siteId,
            userId: req.user?.id,
            totalCategories: categories.length,
            durationMs
        });

        res.json({
            categories
        });

    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('categories_simple_list_error', {
            siteId,
            userId: req.user?.id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

// Get category by ID
router.get('/:id', auth, async (req, res) => {
    const startedAt = new Date();

    try {
        const categoryId = req.params.id;

        logger.info('category_get_started', {
            siteId,
            userId: req.user?.id,
            categoryId,
            startedAt
        });

        const categoryData = await category.findByPk(categoryId, {
            include: [
                {
                    model: product,
                    as: 'products',
                    attributes: ['id', 'name', 'price', 'is_active'],
                    include: [{
                        model: productinventory,
                        as: 'inventories',
                        required: false,
                        attributes: ['store_id', 'stock_quantity', 'min_stock_level']
                    }]
                }
            ]
        });

        if (!categoryData) {
            logger.warn('category_get_not_found', {
                siteId,
                userId: req.user?.id,
                categoryId
            });
            return res.status(404).json({ message: 'Category not found' });
        }

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('category_get_completed', {
            siteId,
            userId: req.user?.id,
            categoryId,
            categoryName: categoryData.name,
            productCount: categoryData.products?.length || 0,
            durationMs
        });

        res.json({ category: categoryData });

    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('category_get_error', {
            siteId,
            userId: req.user?.id,
            categoryId: req.params.id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

// Create new category (admin only)
router.post('/', auth, async (req, res) => {
    const startedAt = new Date();

    try {
        logger.info('category_create_started', {
            siteId,
            userId: req.user?.id,
            userRole: req.user?.role,
            startedAt
        });

        // Check if user is admin
        if (req.user.role !== 'admin') {
            logger.warn('category_create_unauthorized', {
                siteId,
                userId: req.user?.id,
                userRole: req.user?.role
            });
            return res.status(403).json({ message: 'Only admins can create categories' });
        }

        const { name, description } = req.body;

        // Validate required fields
        if (!name || !name.trim()) {
            logger.warn('category_create_missing_name', {
                siteId,
                userId: req.user?.id
            });
            return res.status(400).json({ message: 'Category name is required' });
        }

        logger.debug('category_create_name_validated', {
            siteId,
            categoryName: name.trim()
        });

        // Check if category name already exists
        const existingCategory = await category.findOne({
            where: { name: name.trim() }
        });

        if (existingCategory) {
            logger.warn('category_create_duplicate_name', {
                siteId,
                userId: req.user?.id,
                categoryName: name.trim(),
                existingCategoryId: existingCategory.id
            });
            return res.status(400).json({ message: 'Category with this name already exists' });
        }

        const newCategory = await category.create({
            name: name.trim(),
            description: description ? description.trim() : null
        });

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('category_create_completed', {
            siteId,
            userId: req.user?.id,
            categoryId: newCategory.id,
            categoryName: newCategory.name,
            durationMs
        });

        res.status(201).json({
            message: 'Category created successfully',
            category: newCategory
        });

    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('category_create_error', {
            siteId,
            userId: req.user?.id,
            categoryName: req.body?.name,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

// Update category (admin only)
router.put('/:id', auth, async (req, res) => {
    const startedAt = new Date();

    try {
        const categoryId = req.params.id;

        logger.info('category_update_started', {
            siteId,
            userId: req.user?.id,
            userRole: req.user?.role,
            categoryId,
            updateFields: Object.keys(req.body),
            startedAt
        });

        // Check if user is admin
        if (req.user.role !== 'admin') {
            logger.warn('category_update_unauthorized', {
                siteId,
                userId: req.user?.id,
                userRole: req.user?.role,
                categoryId
            });
            return res.status(403).json({ message: 'Only admins can update categories' });
        }

        const categoryData = await category.findByPk(categoryId);

        if (!categoryData) {
            logger.warn('category_update_not_found', {
                siteId,
                userId: req.user?.id,
                categoryId
            });
            return res.status(404).json({ message: 'Category not found' });
        }

        const { name, description } = req.body;

        // Validate name if provided
        if (name !== undefined && (!name || !name.trim())) {
            logger.warn('category_update_empty_name', {
                siteId,
                userId: req.user?.id,
                categoryId
            });
            return res.status(400).json({ message: 'Category name cannot be empty' });
        }

        // Check if new name already exists (excluding current category)
        if (name !== undefined && name.trim() !== categoryData.name) {
            const existingCategory = await category.findOne({
                where: {
                    name: name.trim(),
                    id: { [Op.ne]: categoryId }
                }
            });

            if (existingCategory) {
                logger.warn('category_update_duplicate_name', {
                    siteId,
                    userId: req.user?.id,
                    categoryId,
                    attemptedName: name.trim(),
                    existingCategoryId: existingCategory.id
                });
                return res.status(400).json({ message: 'Category with this name already exists' });
            }
        }

        // Update category
        const updateData = {};
        if (name !== undefined) {
            updateData.name = name.trim();
            logger.debug('category_update_name', {
                siteId,
                categoryId,
                oldName: categoryData.name,
                newName: name.trim()
            });
        }
        if (description !== undefined) {
            updateData.description = description ? description.trim() : null;
            logger.debug('category_update_description', {
                siteId,
                categoryId
            });
        }

        await categoryData.update(updateData);

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('category_update_completed', {
            siteId,
            userId: req.user?.id,
            categoryId,
            categoryName: categoryData.name,
            updatedFields: Object.keys(updateData),
            durationMs
        });

        res.json({
            message: 'Category updated successfully',
            category: categoryData
        });

    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('category_update_error', {
            siteId,
            userId: req.user?.id,
            categoryId: req.params.id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

// Delete category (admin only)
router.delete('/:id', auth, async (req, res) => {
    const startedAt = new Date();

    try {
        const categoryId = req.params.id;

        logger.info('category_delete_started', {
            siteId,
            userId: req.user?.id,
            userRole: req.user?.role,
            categoryId,
            startedAt
        });

        // Check if user is admin
        if (req.user.role !== 'admin') {
            logger.warn('category_delete_unauthorized', {
                siteId,
                userId: req.user?.id,
                userRole: req.user?.role,
                categoryId
            });
            return res.status(403).json({ message: 'Only admins can delete categories' });
        }

        const categoryData = await category.findByPk(categoryId);

        if (!categoryData) {
            logger.warn('category_delete_not_found', {
                siteId,
                userId: req.user?.id,
                categoryId
            });
            return res.status(404).json({ message: 'Category not found' });
        }

        logger.debug('category_delete_found', {
            siteId,
            categoryId,
            categoryName: categoryData.name
        });

        // Check if category has products
        const productCount = await product.count({
            where: { category_id: categoryId }
        });

        if (productCount > 0) {
            logger.warn('category_delete_has_products', {
                siteId,
                userId: req.user?.id,
                categoryId,
                categoryName: categoryData.name,
                productCount
            });
            return res.status(400).json({
                message: `Cannot delete category. It has ${productCount} products associated with it. Please move or delete the products first.`
            });
        }

        await categoryData.destroy();

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('category_delete_completed', {
            siteId,
            userId: req.user?.id,
            categoryId,
            categoryName: categoryData.name,
            durationMs
        });

        res.json({
            message: 'Category deleted successfully'
        });

    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('category_delete_error', {
            siteId,
            userId: req.user?.id,
            categoryId: req.params.id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

// Get category statistics
router.get('/:id/stats', auth, async (req, res) => {
    const startedAt = new Date();

    try {
        const categoryId = req.params.id;

        logger.info('category_stats_started', {
            siteId,
            userId: req.user?.id,
            categoryId,
            requestedStoreId: req.query.store_id,
            startedAt
        });

        const categoryData = await category.findByPk(categoryId);

        if (!categoryData) {
            logger.warn('category_stats_not_found', {
                siteId,
                userId: req.user?.id,
                categoryId
            });
            return res.status(404).json({ message: 'Category not found' });
        }

        logger.debug('category_stats_found', {
            siteId,
            categoryId,
            categoryName: categoryData.name
        });

        // Determine store context for stats
        const isAdmin = req.user && req.user.role === 'admin';
        const store_id = isAdmin ? (parseInt(req.query.store_id) || req.user.store_id || null) : (req.user && req.user.store_id);

        logger.debug('category_stats_store_context', {
            siteId,
            categoryId,
            isAdmin,
            storeId: store_id
        });

        const products = await product.findAll({
            where: { category_id: categoryId },
            attributes: ['id', 'name', 'price', 'cost', 'is_active'],
            include: [{
                model: productinventory,
                as: 'inventories',
                required: false,
                attributes: ['store_id', 'stock_quantity', 'min_stock_level']
            }]
        });

        const activeProducts = products.filter(p => p.is_active);

        // Helper to get stock for the relevant store
        const getStock = (p) => {
            const invs = Array.isArray(p.inventories) ? p.inventories : [];
            if (store_id) {
                const inv = invs.find(i => i.store_id === store_id);
                return inv ? parseInt(inv.stock_quantity || 0) : 0;
            }
            return invs.reduce((s, i) => s + parseInt(i.stock_quantity || 0), 0);
        };
        const getMinLevel = (p) => {
            const invs = Array.isArray(p.inventories) ? p.inventories : [];
            if (store_id) {
                const inv = invs.find(i => i.store_id === store_id);
                return inv ? parseInt(inv.min_stock_level || 0) : 0;
            }
            return invs.reduce((min, i) => Math.min(min, parseInt(i.min_stock_level || 0)), Number.POSITIVE_INFINITY) || 0;
        };

        const total_stock_quantity = products.reduce((sum, p) => sum + getStock(p), 0);
        const totalStockValue = products.reduce((sum, p) => sum + (parseFloat(p.price) * getStock(p)), 0);
        const totalCostValue = products.reduce((sum, p) => sum + (parseFloat(p.cost || 0) * getStock(p)), 0);
        const lowStockProducts = products.filter(p => getStock(p) <= getMinLevel(p));

        const stats = {
            category: categoryData,
            total_products: products.length,
            active_products: activeProducts.length,
            inactive_products: products.length - activeProducts.length,
            total_stock_quantity,
            total_stock_value: totalStockValue,
            total_cost_value: totalCostValue,
            potential_profit: totalStockValue - totalCostValue,
            low_stock_products_count: lowStockProducts.length,
            average_product_price: products.length > 0 ?
                products.reduce((sum, p) => sum + parseFloat(p.price), 0) / products.length : 0
        };

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('category_stats_completed', {
            siteId,
            userId: req.user?.id,
            categoryId,
            categoryName: categoryData.name,
            totalProducts: stats.total_products,
            activeProducts: stats.active_products,
            totalStockValue: stats.total_stock_value,
            lowStockCount: stats.low_stock_products_count,
            durationMs
        });

        res.json(stats);

    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('category_stats_error', {
            siteId,
            userId: req.user?.id,
            categoryId: req.params.id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

// Get products by category with pagination
router.get('/:id/products', auth, async (req, res) => {
    const startedAt = new Date();

    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const active_only = req.query.active_only === 'true';
        const search = req.query.search || '';
        const categoryId = req.params.id;

        logger.info('category_products_started', {
            siteId,
            userId: req.user?.id,
            categoryId,
            page,
            limit,
            activeOnly: active_only,
            search,
            startedAt
        });

        const categoryData = await category.findByPk(categoryId);

        if (!categoryData) {
            logger.warn('category_products_not_found', {
                siteId,
                userId: req.user?.id,
                categoryId
            });
            return res.status(404).json({ message: 'Category not found' });
        }

        // Build where clause
        const whereClause = { category_id: categoryId };

        if (active_only) {
            whereClause.is_active = true;
        }

        if (search) {
            whereClause[Op.or] = [
                { name: { [Op.like]: `%${search}%` } },
                { barcode: { [Op.like]: `%${search}%` } }
            ];
        }

        const isAdmin = req.user && req.user.role === 'admin';
        const store_id = isAdmin ? (parseInt(req.query.store_id) || req.user.store_id || null) : (req.user && req.user.store_id);

        const { count, rows } = await product.findAndCountAll({
            where: whereClause,
            limit,
            offset,
            order: [['name', 'ASC']],
            include: [
                { model: category, as: 'category' },
                {
                    model: productinventory,
                    as: 'inventories',
                    required: false,
                    attributes: ['store_id', 'stock_quantity', 'min_stock_level']
                }
            ]
        });

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('category_products_completed', {
            siteId,
            userId: req.user?.id,
            categoryId,
            categoryName: categoryData.name,
            totalRecords: count,
            returnedRecords: rows.length,
            page,
            durationMs
        });

        res.json({
            category: categoryData,
            products: rows,
            pagination: {
                current_page: page,
                total_pages: Math.ceil(count / limit),
                total_records: count,
                per_page: limit
            },
            store_id
        });

    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('category_products_error', {
            siteId,
            userId: req.user?.id,
            categoryId: req.params.id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

// Move products from one category to another (admin only)
router.post('/:id/move-products', auth, async (req, res) => {
    const startedAt = new Date();

    try {
        const sourceCategoryId = req.params.id;
        const { target_category_id, product_ids } = req.body;

        logger.info('category_move_products_started', {
            siteId,
            userId: req.user?.id,
            userRole: req.user?.role,
            sourceCategoryId,
            targetCategoryId: target_category_id,
            productIdsCount: product_ids?.length,
            startedAt
        });

        // Check if user is admin
        if (req.user.role !== 'admin') {
            logger.warn('category_move_products_unauthorized', {
                siteId,
                userId: req.user?.id,
                userRole: req.user?.role,
                sourceCategoryId
            });
            return res.status(403).json({ message: 'Only admins can move products between categories' });
        }

        if (!target_category_id || !product_ids || !Array.isArray(product_ids)) {
            logger.warn('category_move_products_invalid_params', {
                siteId,
                userId: req.user?.id,
                sourceCategoryId,
                hasTargetId: !!target_category_id,
                hasProductIds: !!product_ids,
                isArrayProductIds: Array.isArray(product_ids)
            });
            return res.status(400).json({
                message: 'Target category ID and product IDs array are required'
            });
        }

        // Validate source category exists
        const sourceCategory = await category.findByPk(sourceCategoryId);
        if (!sourceCategory) {
            logger.warn('category_move_products_source_not_found', {
                siteId,
                userId: req.user?.id,
                sourceCategoryId
            });
            return res.status(404).json({ message: 'Source category not found' });
        }

        logger.debug('category_move_products_source_found', {
            siteId,
            sourceCategoryId,
            sourceCategoryName: sourceCategory.name
        });

        // Validate target category exists
        const targetCategory = await category.findByPk(target_category_id);
        if (!targetCategory) {
            logger.warn('category_move_products_target_not_found', {
                siteId,
                userId: req.user?.id,
                targetCategoryId: target_category_id
            });
            return res.status(404).json({ message: 'Target category not found' });
        }

        logger.debug('category_move_products_target_found', {
            siteId,
            targetCategoryId: target_category_id,
            targetCategoryName: targetCategory.name
        });

        // Validate all products exist and belong to source category
        const products = await product.findAll({
            where: {
                id: { [Op.in]: product_ids },
                category_id: sourceCategoryId
            }
        });

        if (products.length !== product_ids.length) {
            logger.warn('category_move_products_mismatch', {
                siteId,
                userId: req.user?.id,
                sourceCategoryId,
                requestedProductCount: product_ids.length,
                foundProductCount: products.length
            });
            return res.status(400).json({
                message: 'Some products not found or do not belong to the source category'
            });
        }

        logger.debug('category_move_products_validated', {
            siteId,
            validProductCount: products.length,
            productNames: products.map(p => p.name).slice(0, 5) // Log first 5 product names
        });

        // Move products
        await product.update(
            { category_id: target_category_id },
            {
                where: {
                    id: { [Op.in]: product_ids }
                }
            }
        );

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('category_move_products_completed', {
            siteId,
            userId: req.user?.id,
            sourceCategoryId,
            sourceCategoryName: sourceCategory.name,
            targetCategoryId: target_category_id,
            targetCategoryName: targetCategory.name,
            movedProductCount: products.length,
            durationMs
        });

        res.json({
            message: `Successfully moved ${products.length} products from "${sourceCategory.name}" to "${targetCategory.name}"`,
            moved_products: products.length,
            source_category: sourceCategory.name,
            target_category: targetCategory.name
        });

    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('category_move_products_error', {
            siteId,
            userId: req.user?.id,
            sourceCategoryId: req.params.id,
            targetCategoryId: req.body?.target_category_id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;