const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const inventorysynclog = sequelize.define('inventorysynclog', {
    sync_date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    sync_time: {
      type: DataTypes.TIME,
      allowNull: false
    },
    status: {
      type: DataTypes.ENUM('success', 'failed', 'partial'),
      allowNull: false
    },
    items_processed: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    records_created: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    records_updated: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    records_skipped: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    errors_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    error_details: {
      type: DataTypes.JSON,
      allowNull: true
    },
    duration_seconds: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    started_at: {
      type: DataTypes.DATE,
      allowNull: false
    },
    completed_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    triggered_by: {
      type: DataTypes.ENUM('scheduled', 'manual'),
      defaultValue: 'scheduled'
    }
  }, {
    timestamps: false,
    indexes: [
      { fields: ['sync_date'] },
      { fields: ['status'] }
    ]
  });

  return inventorysynclog;
};