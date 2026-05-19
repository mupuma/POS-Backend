const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const customer = sequelize.define('customer', {
        name: {
            type: DataTypes.STRING(100)
        },
        legal_name: {
            type: DataTypes.STRING(150),
            allowNull: true,
        },
        tpin: {
            type: DataTypes.STRING(20),
            allowNull: true,
            unique: true,
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
        lookup_status: {
            type: DataTypes.STRING(20),
            allowNull: false,
            defaultValue: 'resolved',
        },
        lookup_source: {
            type: DataTypes.STRING(20),
            allowNull: true,
        },
        lookup_error: {
            type: DataTypes.TEXT,
            allowNull: true,
        },
        central_customer_id: {
            type: DataTypes.STRING(100),
            allowNull: true,
        },
        last_verified_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },
        last_synced_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },
        zra_lookup_requested_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },
        zra_lookup_completed_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },
        needs_central_sync: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
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
