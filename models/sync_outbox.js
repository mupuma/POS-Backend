const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const sync_outbox = sequelize.define('sync_outbox', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    event_type: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    aggregate_type: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    aggregate_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'stores',
        key: 'id'
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE'
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id'
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL'
    },
    receipt_number: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    idempotency_key: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true
    },
    payload: {
      type: DataTypes.JSON,
      allowNull: false
    },
    status: {
      type: DataTypes.ENUM('pending', 'sending', 'sent', 'failed', 'dead_letter'),
      allowNull: false,
      defaultValue: 'pending'
    },
    attempt_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    next_retry_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    last_attempt_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    sent_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    last_error: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    response_payload: {
      type: DataTypes.JSON,
      allowNull: true
    },
    locked_at: {
      type: DataTypes.DATE,
      allowNull: true
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
    tableName: 'sync_outbox',
    timestamps: true,
    underscored: true,
    indexes: [
      { name: 'idx_sync_outbox_status', fields: ['status'] },
      { name: 'idx_sync_outbox_next_retry_at', fields: ['next_retry_at'] },
      { name: 'idx_sync_outbox_store_id', fields: ['store_id'] },
      { name: 'idx_sync_outbox_status_next_retry', fields: ['status', 'next_retry_at'] },
      { name: 'uidx_sync_outbox_idempotency_key', unique: true, fields: ['idempotency_key'] }
    ]
  });

  sync_outbox.associate = function(models) {
    sync_outbox.belongsTo(models.store, {
      foreignKey: 'store_id',
      as: 'store'
    });

    sync_outbox.belongsTo(models.user, {
      foreignKey: 'user_id',
      as: 'user'
    });
  };

  return sync_outbox;
};