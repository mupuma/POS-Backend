// Helpers for sorting query results in JavaScript instead of in SQL.
//
// Rationale: when a Sequelize query selects large TEXT/JSON columns (e.g. sale.notes,
// sale.payments_breakdown, credit_note.intrldata) AND uses an ORDER BY on a column that
// has no usable index, MySQL performs a filesort and buffers the full rows (including the
// blobs). With thousands of rows this overflows sort_buffer_size and throws
// ER_OUT_OF_SORTMEMORY (errno 1038). For UNBOUNDED queries (no LIMIT) we already load the
// entire result set, so sorting in JS produces identical output without the DB-side
// filesort. Do NOT use this for paginated (LIMIT/OFFSET) queries — those must sort in SQL
// (ideally backed by an index) so the correct page is returned.

function getFieldValue(row, field) {
  if (row && typeof row.get === 'function') {
    const value = row.get(field);
    if (value !== undefined) {
      return value;
    }
  }
  return row ? row[field] : undefined;
}

function compareValues(left, right) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;

  if (left instanceof Date || right instanceof Date) {
    return new Date(left).getTime() - new Date(right).getTime();
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }

  const leftNum = Number(left);
  const rightNum = Number(right);
  if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) {
    return leftNum - rightNum;
  }

  return String(left).localeCompare(String(right));
}

// Sorts an array of Sequelize instances (or plain objects) in place by one or more
// [field, direction] pairs, mirroring Sequelize's `order` option.
// Example: sortRows(rows, [['sale_date', 'DESC'], ['id', 'DESC']])
function sortRows(rows, order) {
  if (!Array.isArray(rows)) return rows;
  const criteria = (Array.isArray(order) ? order : [order])
    .filter(Boolean)
    .map((entry) => {
      const [field, direction] = Array.isArray(entry) ? entry : [entry, 'ASC'];
      return { field, dir: String(direction).toUpperCase() === 'DESC' ? -1 : 1 };
    });

  rows.sort((a, b) => {
    for (const { field, dir } of criteria) {
      const result = compareValues(getFieldValue(a, field), getFieldValue(b, field));
      if (result !== 0) {
        return result * dir;
      }
    }
    return 0;
  });

  return rows;
}

module.exports = { sortRows };
