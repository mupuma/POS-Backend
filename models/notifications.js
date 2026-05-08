module.exports = (sequelize, DataTypes) => {
    const Notification = sequelize.define('notification', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        type: {
            type: DataTypes.STRING(100),
            allowNull: false,
            comment: 'Type of notification (e.g., ZRA_STOCK_ITEMS_FAILED, ZRA_STOCK_MASTER_FAILED)'
        },
        title: {
            type: DataTypes.STRING(255),
            allowNull: false,
            comment: 'Notification title'
        },
        message: {
            type: DataTypes.TEXT,
            allowNull: false,
            comment: 'Notification message content'
        },
        severity: {
            type: DataTypes.ENUM('info', 'success', 'warning', 'error'),
            allowNull: false,
            defaultValue: 'info',
            comment: 'Notification severity level'
        },
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: {
                model: 'users',
                key: 'id'
            },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
            comment: 'User this notification belongs to (null for system-wide notifications)'
        },
        metadata: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'JSON metadata for additional notification data'
        },
        is_read: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
            comment: 'Whether the notification has been read'
        },
        created_at: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW
        },
        updated_at: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW
        }
    }, {
        tableName: 'notifications',
        timestamps: true,
        underscored: true,
        indexes: [
            {
                name: 'idx_notifications_user_id',
                fields: ['user_id']
            },
            {
                name: 'idx_notifications_type',
                fields: ['type']
            },
            {
                name: 'idx_notifications_severity',
                fields: ['severity']
            },
            {
                name: 'idx_notifications_is_read',
                fields: ['is_read']
            },
            {
                name: 'idx_notifications_created_at',
                fields: ['created_at']
            },
            {
                name: 'idx_notifications_user_unread',
                fields: ['user_id', 'is_read']
            }
        ]
    });

    Notification.associate = function(models) {
        // Association with User model
        Notification.belongsTo(models.user, {
            foreignKey: 'user_id',
            as: 'user'
        });
    };

    return Notification;
};