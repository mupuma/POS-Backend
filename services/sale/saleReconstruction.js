function buildSaleReconstructionDetails(salePayload) {
  const items = Array.isArray(salePayload?.items) ? salePayload.items : [];
  const totalItems = items.reduce((sum, item) => sum + Number(item?.quantity || 0), 0);

  return {
    item_count: items.length,
    total_items: totalItems,
    subtotal: salePayload?.subtotal != null ? Number(salePayload.subtotal) : null,
    tax_amount: salePayload?.tax_amount != null ? Number(salePayload.tax_amount) : null,
    discount_amount: salePayload?.discount_amount != null ? Number(salePayload.discount_amount) : null,
    total_amount: salePayload?.total_amount != null ? Number(salePayload.total_amount) : null,
    payment_method: salePayload?.payment_method || null,
    amount_paid: salePayload?.amount_paid != null ? Number(salePayload.amount_paid) : null,
    change_amount: salePayload?.change_amount != null ? Number(salePayload.change_amount) : null,
    items: items.map((item) => ({
      product_id: item?.product_id || null,
      name: item?.product?.name || null,
      quantity: Number(item?.quantity || 0),
      unit_price: item?.unit_price != null ? Number(item.unit_price) : null,
      total_price: item?.total_price != null ? Number(item.total_price) : null,
      tax_exclusive_total: item?.tax_exclusive_total != null ? Number(item.tax_exclusive_total) : null,
    })),
  };
}

module.exports = {
  buildSaleReconstructionDetails,
};
