const express = require('express');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const router = require("./auth");

const siteId = process.env.SITE_ID || 'unknown-site';
function getBaseDir() {
  // When running as a packaged exe (pkg/nexe)
  if (process.pkg) {
    return path.dirname(process.execPath);
  }
  // In normal dev/start: use the working directory
  return process.cwd();
}
// Route to serve QR code files
router.get('/:filename', (req, res) => {
  const startedAt = new Date();

  try {
    const filename = req.params.filename;

    logger.info('qrcode_retrieval_started', {
      siteId,
      filename,
      clientIp: req.ip,
      userAgent: req.get('user-agent'),
      startedAt
    });

    // Validate filename to prevent directory traversal attacks
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      logger.warn('qrcode_invalid_filename', {
        siteId,
        filename,
        clientIp: req.ip,
        reason: 'path_traversal_attempt'
      });
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const qrCodePath = path.join(getBaseDir(), 'qrcodes', filename);
    logger.debug('qrcode_path_resolved', {
      siteId,
      filename,
      resolvedPath: qrCodePath
    });

    // Check if file exists
    if (fs.existsSync(qrCodePath)) {
      logger.info('qrcode_file_found', {
        siteId,
        filename,
        filePath: qrCodePath
      });

      // Get file stats for logging
      const stats = fs.statSync(qrCodePath);

      // Set appropriate headers
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour

      const durationMs = Date.now() - startedAt.getTime();
      logger.info('qrcode_retrieval_completed', {
        siteId,
        filename,
        fileSize: stats.size,
        durationMs
      });

      // Send the file
      res.sendFile(qrCodePath);
    } else {
      logger.warn('qrcode_not_found', {
        siteId,
        filename,
        requestedPath: qrCodePath,
        clientIp: req.ip
      });

      res.status(404).json({ error: 'QR code not found' });
    }
  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('qrcode_retrieval_error', {
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