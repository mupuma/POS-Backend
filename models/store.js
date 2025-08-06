const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const store = sequelize.define('store', {
    store_number: {
        type: DataTypes.STRING(10),
            allowNull: false,
        defaultValue: '1001S',
    },
    store_location: {
        type: DataTypes.STRING(255),
        allowNull: false,
        defaultValue: 'Ndola, Zambia'
    },
    store_mobile_no: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: '0999999999'
    },
    next_invoice_number: {
                type: DataTypes.STRING(50),
                allowNull: false,
                defaultValue: 'INV-1001-1'
            }

    },
    {
        timestamps:false,
    })
    store.associate = function(models) {
        store.hasMany(models.user, {
            foreignKey: 'store_id'
        });
    };

return store;
};