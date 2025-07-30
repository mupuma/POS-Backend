const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const customer = sequelize.define('customer', {
        name: {
            type: DataTypes.STRING(100)
        },
        phone: {
            type: DataTypes.STRING(20)
        },
        email: {
            type: DataTypes.STRING(100)
        },
        address: {
            type: DataTypes.TEXT
        },
        created_at: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW
        }
    },
        {
            timestamps:false,
        });
    customer.associate = function(models) {
        customer.hasMany(models.sale, { foreignKey: 'customer_id' });
    };
    return customer;
};
