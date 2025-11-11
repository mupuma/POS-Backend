const { DataTypes } = require('sequelize');
module.exports = (sequelize) => {
    const product = sequelize.define('product', {
        name: {
            type: DataTypes.STRING(100),
            allowNull: false
        },
        description: {
            type: DataTypes.TEXT
        },
            image_url: {
            type: DataTypes.TEXT
        },
        price: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false
        },
        cost: {
            type: DataTypes.DECIMAL(10, 2),
            defaultValue: 0.00
        },
        product_class_code: {
            type: DataTypes.STRING(50),
            unique: true
        },
        stock_quantity: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        min_stock_level: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        min_price: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true
        },
        max_price: {
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
            defaultValue: DataTypes.NOW,
            onUpdate: DataTypes.NOW
        },
        product_code: {
                type: DataTypes.STRING(45),
                unique: true
            },
        formatted_product_code: {
                type: DataTypes.STRING(100),
                allowNull: true
            },
    },
        {
            timestamps:false,
        });
    // In Product model
    product.associate = function(models) {
        product.hasMany(models.saleitem, { foreignKey: 'product_id' });
        product.belongsTo(models.category, { foreignKey: 'category_id' });
        // Add per-store inventory
        product.hasMany(models.productinventory, { foreignKey: 'product_id', as: 'inventories' });
    };
    return product;
};
// Note: Set up Category association in your main model file