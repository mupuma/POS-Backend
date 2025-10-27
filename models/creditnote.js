const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const CreditNote = sequelize.define('creditnote', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        receipt_number: {
            type: DataTypes.STRING(50),
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
        credit_note_date: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW,
        },
        notes: {
            type: DataTypes.TEXT,
        },
        // ZRA fields
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
        reason: {
            type: DataTypes.STRING(255),
            allowNull: true,
        },
        original_sale_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
    }, {
        tableName: 'credit_notes',
        timestamps: true,
        underscored: true,
    });

    CreditNote.associate = function(models) {
        // Credit Note belongs to a user (cashier)
        CreditNote.belongsTo(models.user, {
            foreignKey: 'user_id',
            as: 'cashier',
        });

        // Credit Note belongs to a customer (optional)
        CreditNote.belongsTo(models.customer, {
            foreignKey: 'customer_id',
            as: 'customer',
        });

        // Credit Note has many items
        CreditNote.hasMany(models.creditnoteitem, {
            foreignKey: 'credit_note_id',
            as: 'items',
        });
    };

    return CreditNote;
};
