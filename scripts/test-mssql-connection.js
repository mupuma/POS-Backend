// scripts/test-mssql-connection.js
require('dotenv').config();
const sequelize = require('../config/mssqlSequelize');

(async () => {
  try {
    await sequelize.authenticate();
    console.log('MSSQL connection OK');
    const [res] = await sequelize.query('SELECT 1 AS ok');
    console.log(res);
  } catch (e) {
    console.error('MSSQL connection failed:', e.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
