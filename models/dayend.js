const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const dayend = sequelize.define('dayend', {
        // Using default id (INTEGER AI PK) by Sequelize
        store_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'stores', key: 'id' }
        },
        date: {
            type: DataTypes.DATEONLY,
            allowNull: false
        },
        status: {
            type: DataTypes.ENUM('running', 'success', 'failed'),
            allowNull: false,
            defaultValue: 'running'
        },
        started_at: {
            type: DataTypes.DATE,
            allowNull: true
        },
        finished_at: {
            type: DataTypes.DATE,
            allowNull: true
        },
        duration_seconds: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        triggered_by: {
            type: DataTypes.ENUM('scheduled', 'manual'),
            allowNull: false,
            defaultValue: 'scheduled'
        },
        orders_attempted: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        orders_succeeded: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        error_message: {
            type: DataTypes.TEXT,
            allowNull: true
        }
    }, {
        tableName: 'dayends',
        timestamps: true,
        underscored: true,
        indexes: [
            { unique: true, fields: ['store_id', 'date'] },
            { fields: ['date'] },
            { fields: ['status'] }
        ]
    });

    dayend.associate = function(models) {
        dayend.belongsTo(models.store, { foreignKey: 'store_id', as: 'store' });
    };

    return dayend;
};
