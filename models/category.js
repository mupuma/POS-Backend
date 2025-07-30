const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const category = sequelize.define('category', {
        name: {
            type: DataTypes.STRING(50),
            allowNull: false
        },
        description: {
            type: DataTypes.TEXT
        },
        created_at: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW
        }
    },
        {
            timestamps:false,
        });
    category.associate = function(models) {
        category.hasMany(models.product, { foreignKey: 'category_id' });
    };
    return category;
};
