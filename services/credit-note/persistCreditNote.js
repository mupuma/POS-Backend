const { writeFileAuditLog } = require('../fileAuditLogger');

/**
 * Apply a patch to a credit note row by primary key. Throws if the row is missing.
 */
async function persistCreditNoteFields(models, creditNoteId, patch) {
  const row = models.creditnote;
  const [affectedCount] = await row.update(patch, { where: { id: creditNoteId } });

  if (affectedCount === 0) {
    throw new Error(`Credit note #${creditNoteId} was not found while saving (${Object.keys(patch).join(', ')})`);
  }

  return row.findByPk(creditNoteId);
}

/**
 * Persist ZRA fiscalisation outcome and verify SDC fields landed in the DB when ZRA succeeded.
 */
async function applyCreditNoteZraResult(models, creditNoteId, zraResult) {
  if (zraResult?.success && zraResult.updates) {
    await persistCreditNoteFields(models, creditNoteId, zraResult.updates);

    const reloaded = await models.creditnote.findByPk(creditNoteId);
    const persisted = Boolean(reloaded?.sdcid && reloaded?.receipt_no && reloaded?.zra_status === 'sent');

    if (!persisted) {
      throw new Error(
        `ZRA returned SDC data but credit note #${creditNoteId} was not persisted `
        + `(sdcid=${reloaded?.sdcid || 'null'}, receipt_no=${reloaded?.receipt_no || 'null'}, `
        + `zra_status=${reloaded?.zra_status || 'null'})`
      );
    }

    return {
      creditNote: reloaded,
      zraFailed: false,
      zraError: null,
    };
  }

  const zraError = zraResult?.error || 'ZRA unavailable; queued for retry';
  await persistCreditNoteFields(models, creditNoteId, {
    zra_error: zraError.toString().slice(0, 1000),
    zra_status: 'pending',
    next_retry_at: new Date(),
  });

  return {
    creditNote: await models.creditnote.findByPk(creditNoteId),
    zraFailed: true,
    zraError,
  };
}

function mapCreditNoteItems(creditNoteInstance) {
  return (creditNoteInstance.items || []).map((item) => ({
    product_id: item.product_id,
    name: item.product?.name || null,
    quantity: Number(item.quantity),
    unit_price: Number(item.unit_price),
    total_price: Number(item.total_price),
  }));
}

function buildCreditNoteAuditDetails(creditNoteInstance, originalSale, extra = {}) {
  const plain = creditNoteInstance?.get ? creditNoteInstance.get({ plain: true }) : creditNoteInstance;

  return {
    credit_note_id: plain.id,
    receipt_number: plain.receipt_number,
    original_sale_id: plain.original_sale_id,
    original_receipt_number: originalSale?.receipt_number || null,
    reason: plain.reason || null,
    subtotal: Number(plain.subtotal || 0),
    tax_amount: Number(plain.tax_amount || 0),
    total_amount: Number(plain.total_amount || 0),
    payment_method: plain.payment_method || null,
    item_count: (plain.items || []).length,
    items: mapCreditNoteItems(plain),
    zra_status: plain.zra_status || null,
    zra_error: plain.zra_error || null,
    sdcid: plain.sdcid || null,
    receipt_no: plain.receipt_no || null,
    invoice_no: plain.invoice_no || null,
    invnumber: plain.invnumber || null,
    ...extra,
  };
}

function logCreditNoteEvent(entry) {
  writeFileAuditLog({
    action: entry.action || 'credit_note.create',
    entityType: 'credit_note',
    outcome: entry.outcome || 'success',
    actor_user_id: entry.actor_user_id ?? null,
    actor_identifier: entry.actor_identifier ?? null,
    actor_name: entry.actor_name ?? null,
    actor_role: entry.actor_role ?? null,
    store_id: entry.store_id ?? null,
    target_identifier: entry.target_identifier || entry.details?.receipt_number || null,
    target_name: entry.target_name || entry.details?.receipt_number || null,
    ip_address: entry.ip_address ?? null,
    user_agent: entry.user_agent ?? null,
    details: entry.details || null,
  });
}

async function logCreditNotePersistence(models, req, {
  creditNoteInstance,
  originalSale,
  outcome = 'success',
  reason = null,
  actor = {},
}) {
  const details = buildCreditNoteAuditDetails(creditNoteInstance, originalSale, reason ? { reason } : {});

  await models.auditLog?.create?.({
    action: 'credit_note.create',
    entity_type: 'credit_note',
    outcome,
    actor_user_id: actor.actor_user_id ?? null,
    actor_identifier: actor.actor_identifier ?? null,
    actor_name: actor.actor_name ?? null,
    actor_role: actor.actor_role ?? null,
    target_identifier: details.receipt_number,
    target_name: details.receipt_number,
    store_id: actor.store_id ?? null,
    ip_address: req?.ip || null,
    user_agent: req?.headers?.['user-agent'] || null,
    details,
    occurred_at: new Date(),
  }).catch((error) => {
    console.error('Failed to write credit note audit log row:', error.message);
  });

  logCreditNoteEvent({
    outcome,
    actor_user_id: actor.actor_user_id,
    actor_identifier: actor.actor_identifier,
    actor_name: actor.actor_name,
    actor_role: actor.actor_role,
    store_id: actor.store_id,
    target_identifier: details.receipt_number,
    target_name: details.receipt_number,
    ip_address: req?.ip || null,
    user_agent: req?.headers?.['user-agent'] || null,
    details,
  });
}

module.exports = {
  persistCreditNoteFields,
  applyCreditNoteZraResult,
  buildCreditNoteAuditDetails,
  logCreditNoteEvent,
  logCreditNotePersistence,
};
