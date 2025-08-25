const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const Sale = sequelize.define('sale', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        receipt_number: {
            type: DataTypes.STRING(20),
            unique: true,
            allowNull: false,
        },
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'users',
                key: 'id',
            },
        },
        customer_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: {
                model: 'customers',
                key: 'id',
            },
        },
        discount_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: {
                model: 'discounts',
                key: 'id',
            },
        },
        subtotal: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false,
        },
        discount_amount: {
            type: DataTypes.DECIMAL(10, 2),
            defaultValue: 0.00,
        },
        tax_amount: {
            type: DataTypes.DECIMAL(10, 2),
            defaultValue: 0.00,
        },
        total_amount: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false,
        },
        payment_method: {
            type: DataTypes.ENUM('cash', 'card', 'mobile_money'),
            allowNull: false,
        },
        amount_paid: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false,
        },
        change_amount: {
            type: DataTypes.DECIMAL(10, 2),
            defaultValue: 0.00,
        },
        sale_date: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW,
        },
        notes: {
            type: DataTypes.TEXT,
        },

        // New fields added based on the ALTER TABLE statement
        invnumber: {
            type: DataTypes.STRING(50),
            allowNull: true,
        },
        receipt_no: {
            type: DataTypes.STRING(50),
            allowNull: true,
        },
        sdcid: {
            type: DataTypes.STRING(50),
            allowNull: true,
        },
        receiptsig: {
            type: DataTypes.STRING(50),
            allowNull: true,
        },
        intrldata: {
            type: DataTypes.STRING(100),
            allowNull: true,
        },
        qrcode_url: {
            type: DataTypes.STRING(255),
            allowNull: true,
        },
        vsdcrcpdate: {
            type: DataTypes.STRING(100),
            allowNull: true,
        },
        invoice_no: {
            type: DataTypes.STRING(100),
            allowNull: true,
        },
        qrfilepath: {
            type: DataTypes.STRING(255),
            allowNull: true,
        },
    }, {
        tableName: 'sales',
        timestamps: true,
        underscored: true,
    });

    Sale.associate = function(models) {
        // Sale belongs to a user (cashier)
        Sale.belongsTo(models.user, {
            foreignKey: 'user_id',
            as: 'cashier',
        });

        // Sale belongs to a customer (optional)
        Sale.belongsTo(models.customer, {
            foreignKey: 'customer_id',
            as: 'customer',
        });

        // Sale belongs to a discount (optional)
        Sale.belongsTo(models.discount, {
            foreignKey: 'discount_id',
            as: 'discount',
        });

        // Sale has many sale items
        Sale.hasMany(models.saleitem, {
            foreignKey: 'sale_id',
            as: 'items',
        });
    };

    return Sale;
};
