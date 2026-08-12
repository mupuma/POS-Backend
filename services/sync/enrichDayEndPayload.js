const ZRA_SALE_FIELDS = [
  'sale_date',
  'invoice_no',
  'invnumber',
  'receipt_no',
  'sdcid',
  'receiptsig',
  'intrldata',
  'qrcode_url',
  'qrfilepath',
  'vsdcrcpdate',
  'zra_status',
  'zra_error',
  'receipt_printed',
];

function pickZraFields(saleRow) {
  const plain = saleRow?.get ? saleRow.get({ plain: true }) : saleRow;
  if (!plain) {
    return {};
  }

  const picked = {};
  for (const field of ZRA_SALE_FIELDS) {
    if (plain[field] !== undefined && plain[field] !== null) {
      picked[field] = plain[field];
    }
  }
  return normalizeZraStatusForSync(picked);
}

function hasRequiredZraReceiptData(sale) {
  return Boolean(sale?.sdcid && sale?.receipt_no);
}

function normalizeZraStatusForSync(sale) {
  const normalized = { ...sale };
  const status = String(normalized.zra_status || 'pending').toLowerCase();
  const error = normalized.zra_error == null ? '' : String(normalized.zra_error).trim();

  if (status === 'sent' && !hasRequiredZraReceiptData(normalized)) {
    normalized.zra_status = error ? 'failed' : 'pending';
  } else {
    normalized.zra_status = ['pending', 'sent', 'failed'].includes(status) ? status : 'pending';
  }

  return normalized;
}

/**
 * Refreshes ZRA/SDC fields on each sale inside a day-end payload from the live DB
 * before forwarding to the central sync server.
 */
async function enrichDayEndPayloadSales(models, payload) {
  if (!payload || !Array.isArray(payload.sales) || payload.sales.length === 0) {
    return payload;
  }

  const saleIds = payload.sales
    .map((sale) => sale?.id)
    .filter((id) => id != null);

  if (saleIds.length === 0 || !models?.sale) {
    return payload;
  }

  const liveSales = await models.sale.findAll({
    where: { id: saleIds },
    attributes: ['id', ...ZRA_SALE_FIELDS],
  });
  const liveById = new Map(liveSales.map((row) => [String(row.id), pickZraFields(row)]));

  return {
    ...payload,
    sales: payload.sales.map((sale) => ({
      ...sale,
      ...normalizeZraStatusForSync(liveById.get(String(sale.id)) || {}),
    })),
  };
}

module.exports = {
  enrichDayEndPayloadSales,
  pickZraFields,
  normalizeZraStatusForSync,
};
