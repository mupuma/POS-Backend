const express = require('express');
const { product, category, saleitem } = require('../models');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');

const router = express.Router();

// Get all products with pagination and search
router.get('/', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const category_id = req.query.category_id;
    const active_only = req.query.active_only === 'true';

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

// Get product by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const productData = await product.findByPk(req.params.id, {
      include: [
        { model: category, as: 'category' }
      ]
    });

    if (!productData) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.json({ product: productData });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get product by barcode (for scanning)
router.get('/barcode/:barcode', auth, async (req, res) => {
  try {
    const productData = await product.findOne({
      where: {
        barcode: req.params.barcode,
        is_active: true
      },
      include: [
        { model: category, as: 'category' }
      ]
    });

    if (!productData) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.json({ product: productData });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create new product (admin only)
router.post('/', auth, async (req, res) => {
  try {
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
      stock_quantity,
      min_stock_level
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
      stock_quantity: stock_quantity || 0,
      min_stock_level: min_stock_level || 0
    });

    // Fetch with category info
    const productWithCategory = await product.findByPk(newProduct.id, {
      include: [{ model: category, as: 'category' }]
    });

    res.status(201).json({
      message: 'Product created successfully',
      product: productWithCategory
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update product (admin only)
router.put('/:id', auth, async (req, res) => {
  try {
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
      is_active
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

    // Update product
    await product.update({
      name: name || productData.name,
      description: description !== undefined ? description : productData.description,
      price: price ? parseFloat(price) : productData.price,
      cost: cost !== undefined ? parseFloat(cost) : productData.cost,
      barcode: barcode !== undefined ? barcode : productData.barcode,
      category_id: category_id !== undefined ? category_id : productData.category_id,
      stock_quantity: stock_quantity !== undefined ? stock_quantity : productData.stock_quantity,
      min_stock_level: min_stock_level !== undefined ? min_stock_level : productData.min_stock_level,
      is_active: is_active !== undefined ? is_active : productData.is_active
    }, {
      where: { id: req.params.id }
    });

    // Fetch updated product with category
    const updatedProduct = await product.findByPk(req.params.id, {
      include: [{ model: category, as: 'category' }]
    });

    res.json({
      message: 'Product updated successfully',
      product: updatedProduct
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update stock quantity
router.patch('/:id/stock', auth, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can update stock' });
    }

    const { stock_quantity, adjustment_type, adjustment_reason } = req.body;

    if (stock_quantity === undefined) {
      return res.status(400).json({ message: 'Stock quantity is required' });
    }

    const productData = await product.findByPk(req.params.id);
    if (!productData) {
      return res.status(404).json({ message: 'Product not found' });
    }

    let newStockQuantity;

    if (adjustment_type === 'add') {
      newStockQuantity = productData.stock_quantity + parseInt(stock_quantity);
    } else if (adjustment_type === 'subtract') {
      newStockQuantity = productData.stock_quantity - parseInt(stock_quantity);
    } else {
      newStockQuantity = parseInt(stock_quantity);
    }

    // Ensure stock doesn't go negative
    if (newStockQuantity < 0) {
      return res.status(400).json({ message: 'Stock cannot be negative' });
    }

    await product.update(
        { stock_quantity: newStockQuantity },
        { where: { id: req.params.id } }
    );

    const updatedProduct = await product.findByPk(req.params.id, {
      include: [{ model: category, as: 'category' }]
    });

    res.json({
      message: 'Stock updated successfully',
      product: updatedProduct,
      previous_stock: productData.stock_quantity,
      new_stock: newStockQuantity
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get low stock products
router.get('/reports/low-stock', auth, async (req, res) => {
  try {
    const lowStockProducts = await product.findAll({
      where: {
        [Op.and]: [
          { is_active: true },
          product.sequelize.where(
              product.sequelize.col('stock_quantity'),
              Op.lte,
              product.sequelize.col('min_stock_level')
          )
        ]
      },
      include: [{ model: category, as: 'category' }],
      order: [['stock_quantity', 'ASC']]
    });

    res.json({
      message: `Found ${lowStockProducts.length} products with low stock`,
      products: lowStockProducts
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get product sales report
router.get('/:id/sales-report', auth, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    const whereClause = { product_id: req.params.id };

    if (start_date && end_date) {
      whereClause['$sale.sale_date$'] = {
        [Op.between]: [new Date(start_date), new Date(end_date)]
      };
    }

    const salesData = await saleitem.findAll({
      where: whereClause,
      include: [
        {
          model: product,
          as: 'product',
          include: [{ model: category, as: 'category' }]
        },
        {
          model: sale,
          as: 'sale',
          attributes: ['id', 'receipt_number', 'sale_date']
        }
      ],
      order: [['sale', 'sale_date', 'DESC']]
    });

    const summary = {
      total_quantity_sold: salesData.reduce((sum, item) => sum + item.quantity, 0),
      total_revenue: salesData.reduce((sum, item) => sum + parseFloat(item.total_price), 0),
      total_transactions: salesData.length,
      average_quantity_per_sale: salesData.length > 0 ?
          salesData.reduce((sum, item) => sum + item.quantity, 0) / salesData.length : 0
    };

    res.json({
      product_sales: salesData,
      summary
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete product (soft delete - set is_active to false)
router.delete('/:id', auth, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can delete products' });
    }

    const productData = await product.findByPk(req.params.id);
    if (!productData) {
      return res.status(404).json({ message: 'Product not found' });
    }

    await product.update(
        { is_active: false },
        { where: { id: req.params.id } }
    );

    res.json({ message: 'Product deleted successfully' });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;