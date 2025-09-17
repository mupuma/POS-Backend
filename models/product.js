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
        price: {
            type: DataTypes.DECIMAL(10, 4), // Changed to 4 decimals for ZRA precision
            allowNull: false
        },
        cost: {
            type: DataTypes.DECIMAL(10, 4), // Changed to 4 decimals
            defaultValue: 0.0000
        },
        product_class_code: {
            type: DataTypes.STRING(50),
            allowNull: false, // Made required for ZRA
            defaultValue: "50102518" // Default ZRA product class code
        },
        stock_quantity: {
            type: DataTypes.DECIMAL(10, 2), // Changed to decimal for partial quantities
            defaultValue: 0.00
        },
        min_stock_level: {
            type: DataTypes.DECIMAL(10, 2), // Changed to decimal
            defaultValue: 0.00
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
        },
        product_code: {
            type: DataTypes.STRING(45),
            allowNull: false, // Made required for ZRA
            unique: true
        },
        // New fields for ZRA compliance
        barcode: {
            type: DataTypes.STRING(100),
            allowNull: true
        },
        package_unit_code: {
            type: DataTypes.STRING(10),
            defaultValue: "BA" // BA = Basic unit
        },
        quantity_unit_code: {
            type: DataTypes.STRING(10),
            defaultValue: "BE" // BE = Each
        },
        vat_category_code: {
            type: DataTypes.STRING(1),
            defaultValue: "A" // Standard VAT rate
        },
        is_taxable: {
            type: DataTypes.BOOLEAN,
            defaultValue: true
        },
        tax_rate: {
            type: DataTypes.DECIMAL(5, 2),
            defaultValue: 16.00 // Default VAT rate
        }
    }, {
        tableName: 'products',
        underscored: true,
        timestamps: false,
    });
    
    product.associate = function(models) {
        product.hasMany(models.saleitem, { foreignKey: 'product_id' });
        product.belongsTo(models.category, { foreignKey: 'category_id' });
    };
    
    return product;
};