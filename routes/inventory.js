const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');

// Trigger manual sync (admin only)
router.post('/sync/manual', auth, async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can trigger manual sync' });
    }

    const job = req.app.locals.inventorySyncJob;
    if (!job || typeof job.manualSync !== 'function') {
      return res.status(500).json({ error: 'InventorySyncJob not initialized' });
    }

    const result = await job.manualSync();
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Manual sync failed' });
  }
});

module.exports = router;