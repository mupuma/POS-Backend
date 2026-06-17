const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const report_email_log = sequelize.define('report_email_log', {
        store_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'stores',
                key: 'id',
            },
        },
        report_type: {
            type: DataTypes.STRING(64),
            allowNull: false,
        },
        period_key: {
            type: DataTypes.STRING(128),
            allowNull: false,
        },
        period_start: {
            type: DataTypes.DATE,
            allowNull: false,
        },
        period_end: {
            type: DataTypes.DATE,
            allowNull: false,
        },
        status: {
            type: DataTypes.ENUM('pending', 'sent', 'failed'),
            allowNull: false,
            defaultValue: 'pending',
        },
        attempt_count: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
        sent_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },
        error_message: {
            type: DataTypes.TEXT,
            allowNull: true,
        },
        email_to: {
            type: DataTypes.STRING(512),
            allowNull: true,
        },
    }, {
        tableName: 'report_email_logs',
        underscored: true,
        timestamps: true,
    });

    report_email_log.associate = function(models) {
        report_email_log.belongsTo(models.store, {
            foreignKey: 'store_id',
            as: 'store',
        });
    };

    return report_email_log;
};
