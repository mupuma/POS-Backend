module.exports = (sequelize, DataTypes) => {
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
        invoice_number: {
            type: DataTypes.STRING(50),
            allowNull: false,
            defaultValue: 'INV1001-1' // ZRA compliant format
        },
        // ZRA Compliance Fields
        store_identifier: {
            type: DataTypes.STRING(10),
            allowNull: false,
            defaultValue: '000' // Should match ZRA_BHF_ID
        },
        invoice_prefix: {
            type: DataTypes.STRING(10),
            allowNull: false,
            defaultValue: 'INV'
        },
        receipt_sequence: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 1
        },
        receipt_number_length: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 6
        },
        // ZRA Configuration
        zra_tpin: {
            type: DataTypes.STRING(20),
            allowNull: true,
            defaultValue: process.env.ZRA_TPIN || '1002010901'
        },
        zra_bhf_id: {
            type: DataTypes.STRING(10),
            allowNull: true,
            defaultValue: process.env.ZRA_BHF_ID || '000'
        },
        zra_enabled: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: true
        }
    }, {
        tableName: 'stores',
        underscored: true,
        timestamps: false,
    });
    
    // Add virtual field for name to maintain compatibility
    store.prototype.toJSON = function() {
        const values = { ...this.get() };
        values.name = values.store_number;
        return values;
    };

    // Add class method to get store with proper attributes
    store.getStoreWithAttributes = function() {
        return this.findOne({
            attributes: [
                'id', 
                'store_number', 
                'store_location', 
                'store_mobile_no', 
                'invoice_number',
                'store_identifier',
                'invoice_prefix',
                'receipt_sequence',
                'receipt_number_length',
                'zra_tpin',
                'zra_bhf_id',
                'zra_enabled'
            ]
        });
    };

    // Instance methods
    store.prototype.generateCISInvoiceNumber = async function() {
        // This method should be used by the ZRA service to generate proper CIS invoice numbers
        // The format should match: INV1001-1, INV1001-2, etc.
        const currentInvoice = this.invoice_number;
        const match = currentInvoice.match(/^(INV\d+-)(\d+)$/);
        
        if (!match) {
            throw new Error('Invalid invoice number format for ZRA');
        }

        const prefix = match[1];
        const number = parseInt(match[2], 10);
        const newNumber = number + 1;
        const newInvoiceNumber = `${prefix}${newNumber}`;

        this.invoice_number = newInvoiceNumber;
        await this.save();

        return newInvoiceNumber;
    };

    store.prototype.generateRandomString = function(length = 24) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    };

    store.prototype.generateTimestamp = function() {
        const now = new Date();
        return now.getFullYear().toString() + 
               String(now.getMonth() + 1).padStart(2, '0') + 
               String(now.getDate()).padStart(2, '0') + 
               String(now.getHours()).padStart(2, '0') + 
               String(now.getMinutes()).padStart(2, '0') + 
               String(now.getSeconds()).padStart(2, '0');
    };

    store.prototype.generateReceiptNumber = async function() {
        const nextNumber = this.receipt_sequence;
        const receiptNumber = `${this.invoice_prefix}-${this.store_identifier}-${nextNumber.toString().padStart(this.receipt_number_length, '0')}`;
        
        this.receipt_sequence += 1;
        await this.save();
        
        return receiptNumber;
    };

    // ZRA-specific methods
    store.prototype.getZRAConfig = function() {
        return {
            tpin: this.zra_tpin,
            bhfId: this.zra_bhf_id,
            enabled: this.zra_enabled
        };
    };

    store.prototype.updateZRAConfig = function(config) {
        if (config.tpin) this.zra_tpin = config.tpin;
        if (config.bhfId) this.zra_bhf_id = config.bhfId;
        if (config.enabled !== undefined) this.zra_enabled = config.enabled;
        return this.save();
    };

    store.associate = function(models) {
        store.hasMany(models.user, {
            foreignKey: 'store_id'
        });
        store.hasMany(models.sale, {
            foreignKey: 'store_id'
        });
    };

    return store;
};