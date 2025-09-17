module.exports = (sequelize, DataTypes) => {
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
                model: 'stores',
                key: 'id'
            }
        }
    }, {
        tableName: 'users',
        underscored: true,
        timestamps: false
    });

    user.associate = function(models) {
        user.belongsTo(models.store, {
            foreignKey: 'store_id',
            as: 'store'
        });

        user.hasMany(models.sale, {
            foreignKey: 'user_id',
            as: 'sales'
        });
    };

    return user;
};
