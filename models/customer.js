const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const customer = sequelize.define('customer', {
        name: {
            type: DataTypes.STRING(100),
            allowNull: false, // Made required
            defaultValue: "Walk-in Customer"
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
        },
        // New fields for ZRA compliance
        tpin: {
            type: DataTypes.STRING(20),
            comment: 'ZRA Taxpayer Identification Number'
        },
        customer_type: {
            type: DataTypes.ENUM('individual', 'business', 'government'),
            defaultValue: 'individual'
        },
        is_registered: {
            type: DataTypes.BOOLEAN,
            defaultValue: false
        },
        registration_date: {
            type: DataTypes.DATE,
            allowNull: true
        },
        branch_id: {
            type: DataTypes.STRING(10),
            comment: 'ZRA Branch ID if applicable'
        },
        contact_person: {
            type: DataTypes.STRING(100),
            allowNull: true
        }
    }, {
        tableName: 'customers',
        underscored: true,
        timestamps: false,
    });
    
    customer.associate = function(models) {
        customer.hasMany(models.sale, { foreignKey: 'customer_id' });
    };
    
    return customer;
};