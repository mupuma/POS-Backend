const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(
  process.env.MSSQL_DATABASE || 'DAPDAT',
  process.env.MSSQL_USER || 'sa',
  process.env.MSSQL_PASSWORD || 'Admin123',
  {
    host: process.env.MSSQL_SERVER || '10.40.0.42',
    port: process.env.MSSQL_PORT || 1433,
    dialect: 'mssql',
    dialectOptions: {
      options: {
        encrypt: false,
        trustServerCertificate: true
      }
    },
    logging: console.log // Enable to see SQL queries
  }
);

const db = {};

db.Sequelize = Sequelize;
db.sequelize = sequelize;

// Load models
db.ICILOC = require('./ICILOC')(sequelize);

module.exports = db;