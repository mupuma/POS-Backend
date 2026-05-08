// models/productinventory.js
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const productinventory = sequelize.define('productinventory', {
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    stock_quantity: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    min_stock_level: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    price_override: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    updated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    timestamps: false,
    indexes: [
      { unique: true, fields: ['product_id', 'store_id'] }
    ]
  });

  productinventory.associate = function(models) {
    productinventory.belongsTo(models.product, { foreignKey: 'product_id', as: 'product' });
    productinventory.belongsTo(models.store, { foreignKey: 'store_id', as: 'store' });
  };

  return productinventory;
};