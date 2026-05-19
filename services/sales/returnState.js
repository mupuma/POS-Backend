const { Op } = require('sequelize');
const { creditnote, creditnoteitem } = require('../../models');

function toPlain(row) {
  if (!row) return {};
  if (typeof row.get === 'function') {
    return row.get({ plain: true });
  }
  return { ...row };
}

function toNumber(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === 'object' && typeof value.valueOf === 'function') {
    const parsed = Number(value.valueOf());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function sumSaleQuantity(sale) {
  const items = Array.isArray(sale.items) ? sale.items : [];
  return items.reduce((total, item) => total + toNumber(item.quantity ?? item.qty ?? 0), 0);
}

function summarizeCreditNotes(notes) {
  return notes.reduce((summary, note) => {
    summary.returnCount += 1;
    summary.returnedAmount += toNumber(note.total_amount ?? note.total ?? 0);
    const items = Array.isArray(note.items) ? note.items : [];
    summary.returnedQuantity += items.reduce(
      (total, item) => total + toNumber(item.quantity ?? item.qty ?? 0),
      0
    );
    return summary;
  }, {
    returnCount: 0,
    returnedAmount: 0,
    returnedQuantity: 0,
  });
}

function buildReturnState(saleRow, notes = []) {
  const sale = toPlain(saleRow);
  const saleAmount = toNumber(sale.total_amount ?? sale.total ?? 0);
  const saleQuantity = sumSaleQuantity(sale);
  const summary = summarizeCreditNotes(notes.map(toPlain));
  const hasReturns = summary.returnCount > 0;
  const isFullyReturned = hasReturns && (
    (saleQuantity > 0 && summary.returnedQuantity >= saleQuantity) ||
    (saleAmount > 0 && summary.returnedAmount >= saleAmount)
  );

  return {
    return_status: isFullyReturned ? 'returned' : (hasReturns ? 'partial_returned' : 'active'),
    is_fully_returned: isFullyReturned,
    has_returns: hasReturns,
    allow_return: !isFullyReturned,
    total_returned_amount: summary.returnedAmount,
    returned_amount: summary.returnedAmount,
    returned_quantity: summary.returnedQuantity,
    remaining_amount: Math.max(saleAmount - summary.returnedAmount, 0),
    return_count: summary.returnCount,
  };
}

async function getReturnStateMap(sales) {
  const saleRows = Array.isArray(sales) ? sales.map(toPlain) : [];
  const saleIds = [...new Set(saleRows.map(sale => sale.id).filter(Boolean))];
  if (saleIds.length === 0) return new Map();

  const creditNotes = await creditnote.findAll({
    where: { original_sale_id: { [Op.in]: saleIds } },
    include: [{
      model: creditnoteitem,
      as: 'items',
      attributes: ['id', 'quantity']
    }],
    order: [['createdAt', 'ASC']]
  });

  const notesBySaleId = new Map();
  for (const note of creditNotes) {
    const saleId = note.original_sale_id;
    if (!notesBySaleId.has(saleId)) {
      notesBySaleId.set(saleId, []);
    }
    notesBySaleId.get(saleId).push(note);
  }

  const returnStateMap = new Map();
  for (const sale of saleRows) {
    returnStateMap.set(sale.id, buildReturnState(sale, notesBySaleId.get(sale.id) || []));
  }

  return returnStateMap;
}

async function annotateSalesWithReturnState(sales) {
  const saleRows = Array.isArray(sales) ? sales : [];
  const returnStateMap = await getReturnStateMap(saleRows);

  return saleRows.map(row => {
    const sale = toPlain(row);
    const returnState = returnStateMap.get(sale.id) || buildReturnState(sale, []);
    return {
      ...sale,
      ...returnState,
    };
  });
}

module.exports = {
  annotateSalesWithReturnState,
  buildReturnState,
  getReturnStateMap,
};