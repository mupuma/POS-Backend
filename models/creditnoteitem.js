const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const creditnoteitem = sequelize.define('creditnoteitem', {
        quantity: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        unit_price: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false
        },
        total_price: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false
        }
    }, {
        tableName: 'credit_note_items',
        timestamps: false
    });

    creditnoteitem.associate = function(models) {
        creditnoteitem.belongsTo(models.creditnote, { foreignKey: 'credit_note_id' });
        creditnoteitem.belongsTo(models.product, { foreignKey: 'product_id' });
    };

    return creditnoteitem;
};
