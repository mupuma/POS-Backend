const express = require('express');
const { product, category, saleitem,productinventory ,store} = require('../models');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const siteId = process.env.SITE_ID || 'unknown-site';

const router = express.Router();

// Get all products with pagination and search
router.get('/', auth, async (req, res) => {
  const startedAt = new Date();
  try {
    logger.info('products_list_started', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      query: req.query,
      startedAt
    });
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const category_id = req.query.category_id;
    const active_only = req.query.active_only === 'true';
    const store_id = (req.user && req.user.store_id) || null;

    // Build where clause
    const whereClause = {};
 //
    if (search) {
      whereClause[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { barcode: { [Op.like]: `%${search}%` } }
      ];
    }

    if (category_id) {
      whereClause.category_id = category_id;
    }

    if (active_only) {
      whereClause.is_active = true;
    }

    const include = [
      { model: category, as: 'category' }
    ];

    // If store_id is provided/available, require an inventory row for that store
    if (store_id) {
      include.push({
        model: productinventory,
        as: 'inventories',
        where: { store_id, is_active: true },
        required: true,
        attributes: ['store_id', 'stock_quantity', 'min_stock_level', 'price_override'],
        include: [{ model: store, as: 'store', attributes: ['id', 'store_location'] }]
      });
    } else {
      // If no store context, include inventories as optional for visibility
      include.push({
        model: productinventory,
        as: 'inventories',
        required: false,
        attributes: ['store_id', 'stock_quantity', 'min_stock_level', 'price_override']
      });
    }

    const { count, rows } = await product.findAndCountAll({
      where: whereClause,
      limit,
      offset,
      order: [['name', 'ASC']],
      include
    });

     const productsWithEffective = rows.map(p => {
      const json = p.toJSON();
      const inv = Array.isArray(json.inventories) && json.inventories.length > 0 ? json.inventories[0] : null;
      const effective_price = inv && inv.price_override != null ? Number(inv.price_override) : Number(json.price);
      // Prefer per-store inventory values when available
      const stock_quantity = inv && inv.stock_quantity != null ? Number(inv.stock_quantity) : (json.stock_quantity != null ? Number(json.stock_quantity) : null);
      const min_stock_level = inv && inv.min_stock_level != null ? Number(inv.min_stock_level) : (json.min_stock_level != null ? Number(json.min_stock_level) : null);
      return {
        ...json,
        effective_price,
        // Override top-level fields so consumers read store inventory
        stock_quantity,
        min_stock_level
      };
    });
    logger.info('products_list_fetched', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      returnedCount: rows.length,
      totalCount: count
    });
    const durationMs = Date.now() - startedAt.getTime();
    logger.info('products_list_completed', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      durationMs
    });
    res.json({
      products: productsWithEffective,
      pagination: {
        current_page: page,
        total_pages: Math.ceil(count / limit),
        total_records: count,
        per_page: limit
      }
    });

  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('products_list_error', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      error: error.message,
      stack: error.stack,
      durationMs
    });
    res.status(500).json({ message: 'Server error' });
  }
});

// Get product by ID
router.get('/:id', auth, async (req, res) => {
   const startedAt = new Date();
   try {
    logger.info('product_get_started', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      productId: req.params.id,
      startedAt
    });
    const store_id = (req.user && req.user.store_id) || null;

    const include = [
      { model: category, as: 'category' }
    ];

    if (store_id) {
      include.push({
        model: productinventory,
        as: 'inventories',
        where: { store_id },
        required: false,
        attributes: ['store_id', 'stock_quantity', 'min_stock_level', 'price_override']
      });
    }

    const productData = await product.findByPk(req.params.id, { include });

    if (!productData) {
      return res.status(404).json({ message: 'Product not found' });
    }

    const json = productData.toJSON();
    const inv = Array.isArray(json.inventories) && json.inventories.length > 0 ? json.inventories[0] : null;
    const effective_price = inv && inv.price_override != null ? Number(inv.price_override) : Number(json.price);
    // Prefer per-store inventory values when available
    const stock_quantity = inv && inv.stock_quantity != null ? Number(inv.stock_quantity) : (json.stock_quantity != null ? Number(json.stock_quantity) : null);
    const min_stock_level = inv && inv.min_stock_level != null ? Number(inv.min_stock_level) : (json.min_stock_level != null ? Number(json.min_stock_level) : null);

    const durationMs = Date.now() - startedAt.getTime();
    logger.info('product_get_completed', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      productId: req.params.id,
      durationMs
    });
    res.json({ product: { ...json, effective_price, stock_quantity, min_stock_level } });

  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('product_get_error', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      productId: req.params.id,
      error: error.message,
      stack: error.stack,
      durationMs
    });
    res.status(500).json({ message: 'Server error' });
  }
});


// Get product by barcode (for scanning)
router.get('/barcode/:barcode', auth, async (req, res) => {
   const startedAt = new Date();
   try {
    logger.info('product_get_by_barcode_started', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      barcode: req.params.barcode,
      startedAt
    });
    const store_id = (req.user && req.user.store_id) || null;

    const include = [
      { model: category, as: 'category' }
    ];

    if (store_id) {
      include.push({
        model: productinventory,
        as: 'inventories',
        where: { store_id, is_active: true },
        required: true,
        attributes: ['store_id', 'stock_quantity', 'min_stock_level', 'price_override']
      });
    }

    const productData = await product.findOne({
      where: {
        barcode: req.params.barcode,
        is_active: true
      },
      include
    });

    if (!productData) {
      return res.status(404).json({ message: 'Product not found' });
    }

    const json = productData.toJSON();
    const inv = Array.isArray(json.inventories) && json.inventories.length > 0 ? json.inventories[0] : null;
    const effective_price = inv && inv.price_override != null ? Number(inv.price_override) : Number(json.price);
    // Prefer per-store inventory values when available
    const stock_quantity = inv && inv.stock_quantity != null ? Number(inv.stock_quantity) : (json.stock_quantity != null ? Number(json.stock_quantity) : null);
    const min_stock_level = inv && inv.min_stock_level != null ? Number(inv.min_stock_level) : (json.min_stock_level != null ? Number(json.min_stock_level) : null);

    const durationMs = Date.now() - startedAt.getTime();
    logger.info('product_get_by_barcode_completed', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      barcode: req.params.barcode,
      durationMs
    });
    res.json({ product: { ...json, effective_price, stock_quantity, min_stock_level } });


  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('product_get_by_barcode_error', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      barcode: req.params.barcode,
      error: error.message,
      stack: error.stack,
      durationMs
    });
    res.status(500).json({ message: 'Server error' });
  }
});


// Create new product (admin only)
router.post('/', auth, async (req, res) => {
  const startedAt = new Date();
  try {
    logger.info('product_create_started', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      body: { name: req.body?.name, barcode: req.body?.barcode, category_id: req.body?.category_id },
      startedAt
    });
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can create products' });
    }

    const {
      name,
      description,
      price,
      cost,
      barcode,
      category_id,
      // store-specific initial inventory (optional)
      store_id,
      stock_quantity,
      min_stock_level,
      price_override
    } = req.body;

    // Validate required fields
    if (!name || !price) {
      return res.status(400).json({ message: 'Name and price are required' });
    }

    // Check if barcode already exists
    if (barcode) {
      const existingProduct = await product.findOne({ where: { barcode } });
      if (existingProduct) {
        return res.status(400).json({ message: 'Barcode already exists' });
      }
    }

    // Validate category if provided
    if (category_id) {
      const categoryExists = await category.findByPk(category_id);
      if (!categoryExists) {
        return res.status(400).json({ message: 'Category not found' });
      }
    }

    const newProduct = await product.create({
      name,
      description,
      price: parseFloat(price),
      cost: cost ? parseFloat(cost) : 0.00,
      barcode,
      category_id,
      // keep product-level stock fields untouched for backward compatibility
    });

    // Optionally seed inventory row for a particular store
    let inventoryRow = null;
    if (store_id) {
      inventoryRow = await productinventory.create({
        product_id: newProduct.id,
        store_id,
        stock_quantity: stock_quantity || 0,
        min_stock_level: min_stock_level || 0,
        price_override: price_override !== undefined && price_override !== null
          ? parseFloat(price_override) : null
      });
    }

    // Fetch with category + inventories info
    const productWithRelations = await product.findByPk(newProduct.id, {
      include: [
        { model: category, as: 'category' },
        { model: productinventory, as: 'inventories' }
      ]
    });

    const durationMs = Date.now() - startedAt.getTime();
    logger.info('product_create_completed', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      productId: productWithRelations?.id,
      createdInventory: !!inventoryRow,
      durationMs
    });
    res.status(201).json({
      message: 'Product created successfully',
      product: productWithRelations,
      created_inventory: inventoryRow
    });

  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('product_create_error', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      error: error.message,
      stack: error.stack,
      durationMs
    });
    res.status(500).json({ message: 'Server error' });
  }
});

// Update product (admin only)
router.put('/:id', auth, async (req, res) => {
  const startedAt = new Date();
  try {
    logger.info('product_update_started', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      productId: req.params.id,
      startedAt
    });
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can update products' });
    }

    const productData = await product.findByPk(req.params.id);
    if (!productData) {
      return res.status(404).json({ message: 'Product not found' });
    }

    const {
      name,
      description,
      price,
      cost,
      barcode,
      category_id,
      stock_quantity,
      min_stock_level,
      min_price,
      max_price,
      is_active,
      // optional: update a specific store's inventory
      store_id,
      price_override
    } = req.body;

    // Check if barcode already exists (exclude current product)
    if (barcode && barcode !== productData.barcode) {
      const existingProduct = await product.findOne({
        where: {
          barcode,
          id: { [Op.ne]: req.params.id }
        }
      });
      if (existingProduct) {
        return res.status(400).json({ message: 'Barcode already exists' });
      }
    }

    // Validate category if provided
    if (category_id) {
      const categoryExists = await category.findByPk(category_id);
      if (!categoryExists) {
        return res.status(400).json({ message: 'Category not found' });
      }
    }

    // Validate and compute min/max price
    const parsedMin = (min_price !== undefined && min_price !== null && min_price !== '') ? parseFloat(min_price) : null;
    const parsedMax = (max_price !== undefined && max_price !== null && max_price !== '') ? parseFloat(max_price) : null;

    if ((parsedMin !== null && isNaN(parsedMin)) || (parsedMax !== null && isNaN(parsedMax))) {
      return res.status(400).json({ message: 'min_price and max_price must be valid numbers' });
    }

    const finalMin = (parsedMin !== null) ? parsedMin : productData.min_price;
    const finalMax = (parsedMax !== null) ? parsedMax : productData.max_price;

    if (finalMin !== null && finalMax !== null && Number(finalMin) > Number(finalMax)) {
      return res.status(400).json({ message: 'min_price cannot be greater than max_price' });
    }

    // Update product fields (catalog-level)
    await product.update({
      name: name || productData.name,
      description: description !== undefined ? description : productData.description,
      price: price ? parseFloat(price) : productData.price,
      cost: cost !== undefined ? parseFloat(cost) : productData.cost,
      barcode: barcode !== undefined ? barcode : productData.barcode,
      category_id: category_id !== undefined ? category_id : productData.category_id,
      min_price: finalMin,
      max_price: finalMax,
      is_active: is_active !== undefined ? is_active : productData.is_active
    }, {
      where: { id: req.params.id }
    });

    // If store_id provided, optionally upsert the per-store inventory
    if (store_id) {
      const [inv] = await productinventory.findOrCreate({
        where: { product_id: req.params.id, store_id },
        defaults: {
          stock_quantity: stock_quantity || 0,
          min_stock_level: min_stock_level || 0,
          price_override: price_override !== undefined && price_override !== null
            ? parseFloat(price_override) : null
        }
      });

      const fieldsToUpdate = {};
      if (stock_quantity !== undefined) fieldsToUpdate.stock_quantity = stock_quantity;
      if (min_stock_level !== undefined) fieldsToUpdate.min_stock_level = min_stock_level;
      if (price_override !== undefined) {
        fieldsToUpdate.price_override = (price_override === null || price_override === '') ? null : parseFloat(price_override);
      }
      if (Object.keys(fieldsToUpdate).length > 0) {
        await inv.update(fieldsToUpdate);
      }
    }

    // Fetch updated product with category + inventories
    const updatedProduct = await product.findByPk(req.params.id, {
      include: [
        { model: category, as: 'category' },
        { model: productinventory, as: 'inventories' }
      ]
    });

    const durationMs = Date.now() - startedAt.getTime();
    logger.info('product_update_completed', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      productId: req.params.id,
      durationMs
    });
    res.json({
      message: 'Product updated successfully',
      product: updatedProduct
    });

  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('product_update_error', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      productId: req.params.id,
      error: error.message,
      stack: error.stack,
      durationMs
    });
    res.status(500).json({ message: 'Server error' });
  }
});

// Update stock quantity (per store)
router.patch('/:id/stock', auth, async (req, res) => {
  const startedAt = new Date();
  try {
    logger.info('product_stock_update_started', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      productId: req.params.id,
      body: { adjustment_type: req.body?.adjustment_type, stock_quantity: req.body?.stock_quantity, store_id: req.body?.store_id },
      startedAt
    });
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can update stock' });
    }

    const { stock_quantity, adjustment_type, adjustment_reason, store_id: body_store_id } = req.body;

    const store_id = parseInt(body_store_id) || req.user.store_id;
    if (!store_id) {
      return res.status(400).json({ message: 'store_id is required for stock updates' });
    }

    if (stock_quantity === undefined) {
      return res.status(400).json({ message: 'Stock quantity is required' });
    }

    const productData = await product.findByPk(req.params.id);
    if (!productData) {
      return res.status(404).json({ message: 'Product not found' });
    }

    const [inventory] = await productinventory.findOrCreate({
      where: { product_id: req.params.id, store_id },
      defaults: { stock_quantity: 0, min_stock_level: 0 }
    });

    let newStockQuantity;

    if (adjustment_type === 'add') {
      newStockQuantity = inventory.stock_quantity + parseInt(stock_quantity);
    } else if (adjustment_type === 'subtract') {
      newStockQuantity = inventory.stock_quantity - parseInt(stock_quantity);
    } else {
      newStockQuantity = parseInt(stock_quantity);
    }

    // Ensure stock doesn't go negative
    if (newStockQuantity < 0) {
      return res.status(400).json({ message: 'Stock cannot be negative' });
    }

    await inventory.update({ stock_quantity: newStockQuantity });

    const updatedProduct = await product.findByPk(req.params.id, {
      include: [
        { model: category, as: 'category' },
        {
          model: productinventory,
          as: 'inventories',
          where: { store_id },
          required: false
        }
      ]
    });

    // Override top-level stock fields in response using the store inventory
    const updatedJson = updatedProduct ? updatedProduct.toJSON() : null;
    const inv = updatedJson && Array.isArray(updatedJson.inventories) && updatedJson.inventories.length > 0 ? updatedJson.inventories[0] : null;
    const responseProduct = updatedJson ? {
      ...updatedJson,
      stock_quantity: inv && inv.stock_quantity != null ? Number(inv.stock_quantity) : (updatedJson.stock_quantity != null ? Number(updatedJson.stock_quantity) : null),
      min_stock_level: inv && inv.min_stock_level != null ? Number(inv.min_stock_level) : (updatedJson.min_stock_level != null ? Number(updatedJson.min_stock_level) : null)
    } : null;

    const durationMs = Date.now() - startedAt.getTime();
    logger.info('product_stock_update_completed', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      productId: req.params.id,
      previousStock: inventory.stock_quantity,
      newStock: newStockQuantity,
      durationMs
    });
    res.json({
      message: 'Stock updated successfully',
      product: responseProduct,
      previous_stock: inventory.stock_quantity,
      new_stock: newStockQuantity,
      store_id
    });

  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('product_stock_update_error', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      productId: req.params.id,
      error: error.message,
      stack: error.stack,
      durationMs
    });
    res.status(500).json({ message: 'Server error' });
  }
});


// Get low stock products (per store)
router.get('/reports/low-stock', auth, async (req, res) => {
  const startedAt = new Date();
  try {
    logger.info('products_low_stock_started', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      startedAt
    });
    const store_id = (req.user && req.user.store_id) || null;
    if (!store_id) {
      return res.status(400).json({ message: 'store_id is required' });
    }

    const lowStockProducts = await product.findAll({
      where: { is_active: true },
      include: [
        { model: category, as: 'category' },
        {
          model: productinventory,
          as: 'inventories',
          where: {
            store_id
          },
          required: true,
          attributes: ['stock_quantity', 'min_stock_level']
        }
      ],
      order: [['name', 'ASC']]
    });

    // Filter those where inventory.stock_quantity <= inventory.min_stock_level
    const filtered = lowStockProducts.filter(p => {
      const inv = Array.isArray(p.inventories) ? p.inventories[0] : null;
      return inv && inv.stock_quantity <= inv.min_stock_level;
    });

    const durationMs = Date.now() - startedAt.getTime();
    logger.info('products_low_stock_completed', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      count: filtered.length,
      durationMs
    });
    res.json({
      message: `Found ${filtered.length} products with low stock at store ${store_id}`,
      products: filtered
    });

  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('products_low_stock_error', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      error: error.message,
      stack: error.stack,
      durationMs
    });
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
