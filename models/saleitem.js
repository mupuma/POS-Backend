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
        }
    });
    saleitem.associate = function(models) {
        saleitem.belongsTo(models.sale, { foreignKey: 'sale_id' });

        saleitem.belongsTo(models.product, { foreignKey: 'product_id' });
    };
    return saleitem;
};
// Note: Set up Sale and Product associations in your main model file
