// scripts/inspect-table-iciloc.js
require('dotenv').config();
const sequelize = require('../config/mssqlSequelize');

(async () => {
  try {
    const [cols] = await sequelize.query(`
      SELECT 
        c.COLUMN_NAME,
        c.DATA_TYPE,
        c.CHARACTER_MAXIMUM_LENGTH,
        c.NUMERIC_PRECISION,
        c.NUMERIC_SCALE,
        c.IS_NULLABLE,
        COLUMNPROPERTY(object_id(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY
      FROM INFORMATION_SCHEMA.COLUMNS c
      WHERE c.TABLE_NAME = 'ICILOC' AND c.TABLE_SCHEMA = 'dbo'
      ORDER BY c.ORDINAL_POSITION;
    `);

    const [pk] = await sequelize.query(`
      SELECT k.COLUMN_NAME
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS t
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
        ON t.CONSTRAINT_NAME = k.CONSTRAINT_NAME
      WHERE t.TABLE_NAME = 'ICILOC' AND t.TABLE_SCHEMA = 'dbo' AND t.CONSTRAINT_TYPE = 'PRIMARY KEY'
      ORDER BY k.ORDINAL_POSITION;
    `);

    console.log('Columns:');
    console.table(cols);
    console.log('Primary Key columns:');
    console.table(pk);
  } catch (e) {
    console.error('ICILOC inspection failed:', e);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
