const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const discount = sequelize.define('discount', {
        name: {
            type: DataTypes.STRING(50),
            allowNull: false
        },
        type: {
            type: DataTypes.ENUM('percentage', 'fixed_amount'),
            allowNull: false
        },
        value: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false
        },
        is_active: {
            type: DataTypes.BOOLEAN,
            defaultValue: true
        },
        created_at: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW
        }
    }, {
        tableName: 'discounts',
        underscored: true, // ← ADD THIS
        timestamps: false,
    });
    
    discount.associate = function(models) {
        discount.hasMany(models.sale, { foreignKey: 'discount_id' });
    };
    
    return discount;
};