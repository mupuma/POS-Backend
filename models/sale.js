const { DataTypes, Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
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
            validate: {
                min: 0
            }
        },
        discount_amount: {
            type: DataTypes.DECIMAL(10, 2),
            defaultValue: 0.00,
            validate: {
                min: 0
            }
        },
        tax_amount: {
            type: DataTypes.DECIMAL(10, 2),
            defaultValue: 0.00,
            validate: {
                min: 0
            }
        },
        total_amount: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false,
            validate: {
                min: 0
            }
        },
        payment_method: {
            type: DataTypes.ENUM('cash', 'card', 'mobile_money'),
            allowNull: false,
        },
        amount_paid: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false,
            validate: {
                min: 0
            }
        },
        change_amount: {
            type: DataTypes.DECIMAL(10, 2),
            defaultValue: 0.00,
            validate: {
                min: 0
            }
        },
        sale_date: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW,
        },
        notes: {
            type: DataTypes.TEXT,
        },
        tax_rate: {
            type: DataTypes.DECIMAL(5, 2),
            defaultValue: 16.00,
            validate: {
                min: 0,
                max: 100
            }
        },

        // ZRA Compliance Fields
        cis_invoice_no: {
            type: DataTypes.STRING(50),
            allowNull: true,
        },
        zra_response: {
            type: DataTypes.JSON,
            allowNull: true,
        },
        zra_status: {
            type: DataTypes.ENUM('pending', 'success', 'failed', 'disabled'),
            defaultValue: 'pending',
        },
        
        // Legacy fields (keep for backward compatibility)
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
        
        // Store reference
        store_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'stores',
                key: 'id',
            },
        },
    }, {
        tableName: 'sales',
        timestamps: true,
        underscored: true,
        hooks: {
            beforeValidate: async (sale) => {
                // Set default store_id if not provided (from user context)
                if (!sale.store_id && sale.user_id) {
                    const user = await sequelize.models.user.findByPk(sale.user_id);
                    if (user && user.store_id) {
                        sale.store_id = user.store_id;
                    }
                }

                if (sale.store_id) {
                    const storeSettings = await sequelize.models.store.findByPk(sale.store_id);
                    if (!storeSettings) throw new Error('Store settings not found');

                    // Generate receipt number if missing
                    if (!sale.receipt_number) {
                        sale.receipt_number = await storeSettings.generateReceiptNumber();
                    }

                    // Generate ZRA invoice number if missing
                    if (!sale.cis_invoice_no) {
                        sale.cis_invoice_no = await storeSettings.generateCISInvoiceNumber();
                    }

                    // Standardize invoice number fields - ensure all legacy fields point to cis_invoice_no
                    sale.invoice_no = sale.cis_invoice_no;
                    sale.invnumber = sale.cis_invoice_no;
                    
                    // Fill other legacy fields for backward compatibility
                    sale.receipt_no = `WIS${storeSettings.store_number}`;
                    sale.sdcid = `SDC${storeSettings.store_identifier}`;
                    sale.intrldata = storeSettings.generateRandomString(24);
                    sale.receiptsig = storeSettings.generateRandomString(16);
                    sale.vsdcrcpdate = storeSettings.generateTimestamp();

                    // Set ZRA status
                    sale.zra_status = storeSettings.zra_enabled ? 'pending' : 'disabled';
                }

                // Add timestamp if missing
                if (!sale.sale_date) {
                    sale.sale_date = new Date();
                }
            }
        }
    });

    Sale.associate = function(models) {
        Sale.belongsTo(models.user, {
            foreignKey: 'user_id',
            as: 'cashier',
        });

        Sale.belongsTo(models.customer, {
            foreignKey: 'customer_id',
            as: 'customer',
        });

        Sale.belongsTo(models.discount, {
            foreignKey: 'discount_id',
            as: 'discount',
        });

        Sale.belongsTo(models.store, {
            foreignKey: 'store_id',
            as: 'store',
        });

        Sale.hasMany(models.saleitem, {
            foreignKey: 'sale_id',
            as: 'items',
        });
    };

    // Instance method to get formatted invoice details
    Sale.prototype.getInvoiceDetails = function() {
        return {
            cisInvoiceNumber: this.cis_invoice_no,
            invoiceNumber: this.invoice_no || this.cis_invoice_no, // Backward compatibility
            receiptNumber: this.receipt_number,
            sdcid: this.sdcid,
            saleDate: this.sale_date,
            totalAmount: this.total_amount,
            zraStatus: this.zra_status
        };
    };

    // Update ZRA status method
    Sale.prototype.updateZRAStatus = function(status, response = null) {
        this.zra_status = status;
        if (response) {
            this.zra_response = response;
        }
        return this.save();
    };

    // Class method to find by CIS invoice number
    Sale.findByCISInvoiceNumber = function(cisInvoiceNumber) {
        return this.findOne({ where: { cis_invoice_no: cisInvoiceNumber } });
    };

    // Class method to find by invoice number (backward compatibility)
    Sale.findByInvoiceNumber = function(invoiceNumber) {
        return this.findOne({ 
            where: { 
                [Op.or]: [
                    { invoice_no: invoiceNumber },
                    { cis_invoice_no: invoiceNumber }
                ]
            } 
        });
    };

    // Class method to calculate totals for reporting
    Sale.getSalesSummary = async function(whereClause = {}) {
        return this.findAll({
            where: whereClause,
            attributes: [
                [sequelize.fn('COUNT', sequelize.col('id')), 'total_sales'],
                [sequelize.fn('SUM', sequelize.col('total_amount')), 'total_revenue'],
                [sequelize.fn('SUM', sequelize.col('discount_amount')), 'total_discounts'],
                [sequelize.fn('SUM', sequelize.col('tax_amount')), 'total_taxes'],
                [sequelize.fn('SUM', sequelize.col('subtotal')), 'total_subtotal'],
                'payment_method',
                [sequelize.fn('DATE', sequelize.col('sale_date')), 'sale_date']
            ],
            group: ['payment_method', sequelize.fn('DATE', sequelize.col('sale_date'))],
            raw: true
        });
    };

    return Sale;
};