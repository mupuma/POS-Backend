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
    }, {
        tableName: 'categories', // ← ADD THIS
        underscored: true,       // ← ADD THIS
        timestamps: false,
    });
    
    category.associate = function(models) {
        category.hasMany(models.product, { foreignKey: 'category_id' });
    };
    
    return category;
};