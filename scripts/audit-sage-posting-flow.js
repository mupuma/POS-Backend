require('dotenv').config();

const sequelize = require('../config/mssqlSequelize');

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      continue;
    }

    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_\[]/g, (match) => `\\${match}`);
}

function quoteName(value) {
  return `[${String(value).replace(/]/g, ']]')}]`;
}

function formatRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value instanceof Date) {
      return [key, value.toISOString()];
    }
    return [key, value];
  }));
}

async function getTables() {
  const [rows] = await sequelize.query(`
    SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = 'BASE TABLE'
      AND (
        TABLE_NAME LIKE 'OE%'
        OR TABLE_NAME LIKE 'GL%'
        OR TABLE_NAME LIKE 'IC%'
        OR TABLE_NAME LIKE 'AR%'
      )
    ORDER BY TABLE_SCHEMA, TABLE_NAME
  `);
  return rows;
}

async function getColumns(schemaName, tableName) {
  const [rows] = await sequelize.query(`
    SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = :schemaName
      AND TABLE_NAME = :tableName
    ORDER BY ORDINAL_POSITION
  `, {
    replacements: { schemaName, tableName },
  });
  return rows;
}

function pickColumns(columns) {
  const preferred = [
    /ORD/i,
    /INV/i,
    /SHIP|SHI/i,
    /DATE/i,
    /DESC|REFERENCE|REF|PONUM/i,
    /CUST/i,
    /ITEM/i,
    /LOC/i,
    /CAT/i,
    /ACCT|GL/i,
    /AMT|TOTAL|NET|TAX|COST|PRICE/i,
    /SRC|BATCH|ENTRY/i,
  ];

  const selected = [];
  for (const pattern of preferred) {
    for (const column of columns) {
      if (pattern.test(column.column_name) && !selected.includes(column.column_name)) {
        selected.push(column.column_name);
      }
    }
  }

  return selected.slice(0, 24);
}

function searchableColumns(columns) {
  return columns.filter((column) => [
    'char',
    'nchar',
    'varchar',
    'nvarchar',
    'text',
    'ntext',
  ].includes(String(column.data_type).toLowerCase()));
}

function dateColumns(columns) {
  return columns.filter((column) => /date|time/i.test(column.column_name));
}

async function searchTable({ schemaName, tableName, columns, tokens, fromDate, toDate, limit }) {
  const selectedColumns = pickColumns(columns);
  if (selectedColumns.length === 0) {
    return [];
  }

  const textColumns = searchableColumns(columns);
  const filters = [];
  const replacements = { limit };

  tokens.forEach((token, index) => {
    const tokenFilters = textColumns.map((column) => (
      `${quoteName(column.column_name)} LIKE :token${index} ESCAPE '\\'`
    ));
    if (tokenFilters.length > 0) {
      filters.push(`(${tokenFilters.join(' OR ')})`);
      replacements[`token${index}`] = `%${escapeLike(token)}%`;
    }
  });

  const usableDateColumns = dateColumns(columns);
  if (fromDate && toDate && usableDateColumns.length > 0) {
    const dateFilters = usableDateColumns.map((column) => (
      `${quoteName(column.column_name)} >= :fromDate AND ${quoteName(column.column_name)} < DATEADD(day, 1, :toDate)`
    ));
    filters.push(`(${dateFilters.join(' OR ')})`);
    replacements.fromDate = fromDate;
    replacements.toDate = toDate;
  }

  if (filters.length === 0) {
    return [];
  }

  const sql = `
    SELECT TOP (:limit) ${selectedColumns.map(quoteName).join(', ')}
    FROM ${quoteName(schemaName)}.${quoteName(tableName)}
    WHERE ${filters.join(' OR ')}
  `;

  const [rows] = await sequelize.query(sql, { replacements });
  return rows;
}

function scoreTable(tableName) {
  if (/^OEORD/i.test(tableName)) return 10;
  if (/^OESHI/i.test(tableName)) return 9;
  if (/^OEINV/i.test(tableName)) return 8;
  if (/^GL/i.test(tableName)) return 7;
  if (/^IC/i.test(tableName)) return 6;
  if (/^AR/i.test(tableName)) return 5;
  return 1;
}

async function run() {
  const args = parseArgs(process.argv);
  const tokens = [
    args.order,
    args.reference,
    args.account,
    args.category,
  ].filter(Boolean);

  if (tokens.length === 0 && !(args.from && args.to)) {
    throw new Error('Provide --order, --reference, --account, --category, or both --from and --to.');
  }

  const tables = (await getTables())
    .filter((table) => /^(OE|GL|IC|AR)/i.test(table.table_name))
    .sort((left, right) => scoreTable(right.table_name) - scoreTable(left.table_name));

  console.log('Sage posting audit');
  console.log({
    database: process.env.MSSQL_DATABASE || 'DAPDAT',
    order: args.order || null,
    reference: args.reference || null,
    account: args.account || null,
    category: args.category || null,
    from: args.from || null,
    to: args.to || null,
  });

  let foundAny = false;
  for (const table of tables) {
    const columns = await getColumns(table.schema_name, table.table_name);
    const rows = await searchTable({
      schemaName: table.schema_name,
      tableName: table.table_name,
      columns,
      tokens,
      fromDate: args.from,
      toDate: args.to,
      limit: Number(args.limit || 20),
    });

    if (rows.length === 0) {
      continue;
    }

    foundAny = true;
    console.log(`\n${table.schema_name}.${table.table_name} (${rows.length})`);
    console.table(rows.map(formatRow));
  }

  if (!foundAny) {
    console.log('\nNo matching rows found in candidate Sage O/E, G/L, I/C, or A/R tables.');
  }
}

run()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });
