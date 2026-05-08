const express = require('express');
const { sale, creditnote, user } = require('../models');
const auth = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();
const siteId = process.env.SITE_ID || 'unknown-site';

// GET /api/print-status?type=sale|creditnote&id=123
router.get('/', auth, async (req, res) => {
  const startedAt = new Date();

  try {
    const { type, id } = req.query;

    logger.info('print_status_check_started', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      userRole: req.user?.role,
      requestedType: type,
      requestedId: id,
      startedAt
    });

    if (!type || !id) {
      logger.warn('print_status_missing_params', {
        siteId,
        userId: req.user?.id,
        hasType: !!type,
        hasId: !!id
      });
      return res.status(400).json({ message: 'Missing required query params: type and id' });
    }

    const normalizedType = String(type).toLowerCase();
    if (!['sale', 'creditnote', 'credit_note', 'credit-note'].includes(normalizedType)) {
      logger.warn('print_status_invalid_type', {
        siteId,
        userId: req.user?.id,
        requestedType: type,
        normalizedType
      });
      return res.status(400).json({ message: "Invalid 'type'. Must be 'sale' or 'creditnote'" });
    }

    const entityType = normalizedType === 'sale' ? 'sale' : 'creditnote';

    logger.debug('print_status_type_validated', {
      siteId,
      normalizedType,
      resolvedEntityType: entityType
    });

    // Fetch entity including cashier to enforce store scope
    let entity;
    if (entityType === 'sale') {
      logger.debug('print_status_fetching_sale', {
        siteId,
        saleId: id
      });

      entity = await sale.findByPk(id, {
        include: [{ model: user, as: 'cashier', attributes: ['id', 'store_id'] }]
      });
    } else {
      logger.debug('print_status_fetching_creditnote', {
        siteId,
        creditNoteId: id
      });

      entity = await creditnote.findByPk(id, {
        include: [{ model: user, as: 'cashier', attributes: ['id', 'store_id'] }]
      });
    }

    if (!entity) {
      logger.warn('print_status_entity_not_found', {
        siteId,
        userId: req.user?.id,
        entityType,
        entityId: id
      });
      return res.status(404).json({ message: `${entityType === 'sale' ? 'Sale' : 'Credit note'} not found` });
    }

    logger.debug('print_status_entity_found', {
      siteId,
      entityType,
      entityId: id,
      receiptNumber: entity.receipt_number || entity.receipt_no,
      cashierStoreId: entity.cashier?.store_id
    });

    // Enforce store access: cashiers/admins can only access within their store
    if (req.user && (req.user.role === 'cashier' || req.user.role === 'admin')) {
      const cashierStoreId = entity.cashier && entity.cashier.store_id;
      if (!cashierStoreId || cashierStoreId !== req.user.store_id) {
        logger.warn('print_status_store_mismatch', {
          siteId,
          userId: req.user?.id,
          userStoreId: req.user.store_id,
          entityStoreId: cashierStoreId,
          entityType,
          entityId: id
        });
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    const printed = !!entity.receipt_printed;

    const durationMs = Date.now() - startedAt.getTime();
    logger.info('print_status_check_completed', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      entityType,
      entityId: id,
      printed,
      durationMs
    });

    return res.json({
      type: entityType,
      id: Number(id),
      printed,
      entity: entity,
      message: printed ? 'Receipt has been printed before' : 'Receipt has not been printed yet'
    });

  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('print_status_check_error', {
      siteId,
      userId: req.user?.id,
      storeId: req.user?.store_id,
      requestedType: req.query.type,
      requestedId: req.query.id,
      error: error.message,
      stack: error.stack,
      durationMs
    });
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;