const express = require('express');
const { sale, creditnote, user } = require('../models');
const auth = require('../middleware/auth');

const router = express.Router();

// GET /api/print-status?type=sale|creditnote&id=123
router.get('/', auth, async (req, res) => {
  try {
    const { type, id } = req.query;

    if (!type || !id) {
      return res.status(400).json({ message: 'Missing required query params: type and id' });
    }

    const normalizedType = String(type).toLowerCase();
    if (!['sale', 'creditnote', 'credit_note', 'credit-note'].includes(normalizedType)) {
      return res.status(400).json({ message: "Invalid 'type'. Must be 'sale' or 'creditnote'" });
    }

    const entityType = normalizedType === 'sale' ? 'sale' : 'creditnote';

    // Fetch entity including cashier to enforce store scope
    let entity;
    if (entityType === 'sale') {
      entity = await sale.findByPk(id, {
        include: [{ model: user, as: 'cashier', attributes: ['id', 'store_id'] }]
      });
    } else {
      entity = await creditnote.findByPk(id, {
        include: [{ model: user, as: 'cashier', attributes: ['id', 'store_id'] }]
      });
    }

    if (!entity) {
      return res.status(404).json({ message: `${entityType === 'sale' ? 'Sale' : 'Credit note'} not found` });
    }

    // Enforce store access: cashiers/admins can only access within their store
    if (req.user && (req.user.role === 'cashier' || req.user.role === 'admin')) {
      const cashierStoreId = entity.cashier && entity.cashier.store_id;
      if (!cashierStoreId || cashierStoreId !== req.user.store_id) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    const printed = !!entity.receipt_printed;
    return res.json({
      type: entityType,
      id: Number(id),
      printed,
      entity: entity, // include entity for convenience (frontend may already rely on extra fields)
      message: printed ? 'Receipt has been printed before' : 'Receipt has not been printed yet'
    });
  } catch (error) {
    console.error('Print status check error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
