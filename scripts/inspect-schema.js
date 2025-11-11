// scripts/inspect-schema.js
require('dotenv').config();
const sequelize = require('../config/mssqlSequelize');

(async () => {
  try {
    const [tables] = await sequelize.query(`
      SELECT s.name AS schema_name, t.name AS table_name
      FROM sys.tables t
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      ORDER BY s.name, t.name;
    `);
    console.table(tables);
  } catch (e) {
    console.error('Schema inspection failed:', e);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
