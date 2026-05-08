const express = require('express');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const router = express.Router();
const siteId = process.env.SITE_ID || 'unknown-site';

// Very small mime map to avoid adding a dependency
const mimeByExt = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
};

// Public route to serve product image files
router.get('/:filename', (req, res) => {
  const startedAt = new Date();

  try {
    const raw = req.params.filename || '';

    logger.info('product_image_retrieval_started', {
      siteId,
      requestedFilename: raw,
      clientIp: req.ip,
      userAgent: req.get('user-agent'),
      startedAt
    });

    // Basic traversal protection: only allow a plain filename
    const filename = path.basename(raw);
    if (filename !== raw || filename.includes('..')) {
      logger.warn('product_image_invalid_filename', {
        siteId,
        requestedFilename: raw,
        baseName: filename,
        clientIp: req.ip,
        reason: filename !== raw ? 'path_traversal_attempt' : 'contains_double_dot'
      });
      return res.status(400).json({ error: 'Invalid filename' });
    }

    logger.debug('product_image_filename_validated', {
      siteId,
      filename,
      validationPassed: true
    });

    const imagePath = path.join(__dirname, '..', 'products', filename);

    logger.debug('product_image_path_resolved', {
      siteId,
      filename,
      resolvedPath: imagePath
    });

    if (!fs.existsSync(imagePath)) {
      logger.warn('product_image_not_found', {
        siteId,
        filename,
        requestedPath: imagePath,
        clientIp: req.ip
      });
      return res.status(404).json({ error: 'Product image not found' });
    }

    logger.info('product_image_file_found', {
      siteId,
      filename,
      filePath: imagePath
    });

    const ext = path.extname(filename).toLowerCase();
    const mime = mimeByExt[ext] || 'application/octet-stream';

    // Get file stats for size and other metadata
    const stats = fs.statSync(imagePath);

    logger.debug('product_image_stats', {
      siteId,
      filename,
      extension: ext,
      mimeType: mime,
      fileSize: stats.size,
      modifiedAt: stats.mtime
    });

    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour

    const durationMs = Date.now() - startedAt.getTime();
    logger.info('product_image_retrieval_completed', {
      siteId,
      filename,
      mimeType: mime,
      fileSize: stats.size,
      durationMs
    });

    return res.sendFile(imagePath);

  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('product_image_retrieval_error', {
      siteId,
      filename: req.params.filename,
      error: error.message,
      stack: error.stack,
      clientIp: req.ip,
      durationMs
    });

    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;