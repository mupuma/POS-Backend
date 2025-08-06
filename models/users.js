const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const user = sequelize.define('user', {
        username: {
            type: DataTypes.STRING(50),
            unique: true,
            allowNull: false
        },
        password_hash: {
            type: DataTypes.STRING(255),
            allowNull: false
        },
        full_name: {
            type: DataTypes.STRING(100),
            allowNull: false
        },
        role: {
            type: DataTypes.ENUM('admin', 'cashier'),
            defaultValue: 'cashier'
        },
        is_active: {
            type: DataTypes.BOOLEAN,
            defaultValue: true
        },
        created_at: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW
        },
        store_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'stores', // should match the table name exactly (default is pluralized model name)
                key: 'id'
            }
        }
    }, {
        timestamps: false
    });

    user.associate = function(models) {
        user.belongsTo(models.store, {
            foreignKey: 'store_id'
        });

        user.hasMany(models.sale, {
            foreignKey: 'user_id'
        });
    };

    return user;
};
