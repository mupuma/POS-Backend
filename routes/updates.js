const express = require('express');

const router = express.Router();

router.get('/version.json', (req, res) => {
  const version = process.env.UPDATE_VERSION || process.env.APP_VERSION || '1.0.0';
  const downloadUrl = process.env.UPDATE_DOWNLOAD_URL || '';

  if (!downloadUrl) {
    return res.status(500).json({
      message: 'UPDATE_DOWNLOAD_URL is not configured',
    });
  }

  res.json({
    version,
    downloadUrl,
    releaseNotes: process.env.UPDATE_RELEASE_NOTES || '',
    mandatory: String(process.env.UPDATE_MANDATORY || 'false').toLowerCase() === 'true',
    publishedAt: process.env.UPDATE_PUBLISHED_AT || new Date().toISOString(),
  });
});

module.exports = router;