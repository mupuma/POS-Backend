const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const saleitem = sequelize.define('saleitem', {
        quantity: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        unit_price: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false
        },
        total_price: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false
        },
        created_at: {          // ← You might want to add this
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW
        },
        updated_at: {          // ← You might want to add this
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW
        }
    }, {
        tableName: 'saleitems', // Add explicit table name
        underscored: true,      // ← ADD THIS
        timestamps: false,      // Set to true if you want Sequelize to handle timestamps
    });
    
    saleitem.associate = function(models) {
        saleitem.belongsTo(models.sale, { foreignKey: 'sale_id' });
        saleitem.belongsTo(models.product, { foreignKey: 'product_id' });
    };
    
    return saleitem;
};