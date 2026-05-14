// config/mssqlSequelize.js
const { Sequelize } = require('sequelize');

const {
  MSSQL_HOST = 'localhost',
  MSSQL_PORT = 1433,
  MSSQL_DATABASE = 'DAPDAT',
  MSSQL_USERNAME = 'sa',
  MSSQL_PASSWORD = 'root',
  MSSQL_ENCRYPT = 'true',
  MSSQL_TRUST_SERVER_CERT = 'true',
  MSSQL_INSTANCE,
} = process.env;

const dialectOptions = {
  options: {
    encrypt: MSSQL_ENCRYPT === 'true',
    trustServerCertificate: MSSQL_TRUST_SERVER_CERT === 'true',
  },
};

if (MSSQL_INSTANCE) {
  // For named instances like SQLEXPRESS
  dialectOptions.options.instanceName = MSSQL_INSTANCE;
}

const mssqlSequelize = new Sequelize(MSSQL_DATABASE, MSSQL_USERNAME, MSSQL_PASSWORD, {
  host: MSSQL_HOST,
  port: Number(MSSQL_PORT),
  dialect: 'mssql',
  logging: false, // set to console.log to debug queries
  define: {
    timestamps: false,      // safer defaults for read-only
    freezeTableName: true,  // MSSQL tables are often uppercase fixed names
  },
  pool: {
    max: 10,
    min: 0,
    acquire: 30000,
    idle: 10000,
  },
  dialectOptions,
});

module.exports = mssqlSequelize;
