const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const logger = require('../utils/logger');

// Trigger manual sync (admin only)
router.post('/sync/manual', auth, async (req, res) => {
  const startedAt = new Date();
  const siteId = process.env.SITE_ID || 'unknown-site';

  try {
    logger.info('inventory_sync_manual_started', {
      siteId,
      userId: req.user?.id,
      userRole: req.user?.role,
      storeId: req.user?.store_id,
      startedAt
    });

    if (!req.user || req.user.role !== 'admin') {
      logger.warn('inventory_sync_manual_unauthorized', {
        siteId,
        userId: req.user?.id,
        userRole: req.user?.role
      });
      return res.status(403).json({ error: 'Only admins can trigger manual sync' });
    }

    const job = req.app.locals.inventorySyncJob;
    if (!job || typeof job.manualSync !== 'function') {
      logger.error('inventory_sync_manual_job_not_initialized', {
        siteId,
        userId: req.user?.id,
        hasJob: !!job,
        hasManualSyncMethod: job ? typeof job.manualSync === 'function' : false
      });
      return res.status(500).json({ error: 'InventorySyncJob not initialized' });
    }

    logger.info('inventory_sync_manual_job_executing', {
      siteId,
      userId: req.user?.id
    });

    const result = await job.manualSync();

    const durationMs = Date.now() - startedAt.getTime();
    logger.info('inventory_sync_manual_completed', {
      siteId,
      userId: req.user?.id,
      success: result?.success,
      productsProcessed: result?.productsProcessed,
      productsUpdated: result?.productsUpdated,
      productsCreated: result?.productsCreated,
      errors: result?.errors?.length || 0,
      durationMs
    });

    return res.status(200).json(result);
  } catch (err) {
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('inventory_sync_manual_error', {
      siteId,
      userId: req.user?.id,
      error: err.message,
      stack: err.stack,
      durationMs
    });
    return res.status(500).json({ error: err.message || 'Manual sync failed' });
  }
});

module.exports = router;