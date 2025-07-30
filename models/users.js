const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const users = sequelize.define('user', {
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


    },
        {
            timestamps:false,
        });

    users.associate = function(models) {
        users.hasMany(models.sale, { foreignKey: 'user_id' });
    };

    return users;
};
