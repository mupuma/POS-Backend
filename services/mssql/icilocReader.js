// services/mssql/icilocReader.js
const mssqlDb = require('../../models_mssql');

/**
 * Read-only helper to fetch rows from dbo.ICILOC
 * Refine attributes/order after running the introspection scripts
 */
async function listLocations(limit = 50) {
  const rows = await mssqlDb.ICILOC.findAll({
    raw: true,
    limit,
    // attributes: ['LOCATION', 'DESCRIPTION', 'INACTIVE'], // fill after introspection
  });
  return rows;
}

module.exports = { listLocations };