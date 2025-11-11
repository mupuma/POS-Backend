
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ICILOC = sequelize.define('ICILOC', {
    ITEMNO: {
      type: DataTypes.STRING(24),
      allowNull: false,
      primaryKey: true
    },
    LOCATION: {
      type: DataTypes.STRING(6),
      allowNull: false,
      primaryKey: true
    },
    QTYONHAND: {
      type: DataTypes.DECIMAL(19, 4),
      defaultValue: 0
    },
    QTYONORDER: {
      type: DataTypes.DECIMAL(19, 4),
      defaultValue: 0
    },
    QTYCOMMIT: {
      type: DataTypes.DECIMAL(19, 4),
      defaultValue: 0
    },
    TOTALCOST: {
      type: DataTypes.DECIMAL(19, 4),
      defaultValue: 0
    },
    RECENTCOST: {
      type: DataTypes.DECIMAL(19, 4),
      defaultValue: 0
    },
    LASTRCPTDT: {
      type: DataTypes.DECIMAL(9, 0),
      defaultValue: 0
    },
    LASTSHIPDT: {
      type: DataTypes.DECIMAL(9, 0),
      defaultValue: 0
    },
    STDCOST: {
      type: DataTypes.DECIMAL(19, 4),
      defaultValue: 0
    },
    LASTSTDCST: {
      type: DataTypes.DECIMAL(19, 4),
      defaultValue: 0
    },
    ACTIVE: {
      type: DataTypes.INTEGER,
      defaultValue: 1
    },
    PICKINGSEQ: {
      type: DataTypes.STRING(10),
      defaultValue: ''
    },
    LEADTIME: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    QTYMINREQ: {
      type: DataTypes.DECIMAL(19, 4),
      defaultValue: 0
    }
  }, {
    tableName: 'ICILOC',
    schema: 'dbo', // Change this if your schema is different (e.g., 'INDCOM', 'SAMINC')
    timestamps: false,
    freezeTableName: true
  });

  return ICILOC;
};