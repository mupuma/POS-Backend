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
    }, store_rev_account: {
        type: DataTypes.STRING(255),
        allowNull: false,
        defaultValue: '13031000001'
    },
    store_mobile_no: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: '0999999999'
    },

    invoice_number: {
                type: DataTypes.STRING(50),
                allowNull: false,
                defaultValue: 'INV-1001-1'
            },

            credit_note_number: {
                type: DataTypes.STRING(50),
                allowNull: false,
                defaultValue: 'CRN-1001-1'
            },

            // Tracks the last date a day-end was completed for this store (YYYY-MM-DD)
    last_day_end_date: {
                type: DataTypes.DATEONLY,
                allowNull: true,
                defaultValue: null
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