const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

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
  const raw = req.params.filename || '';

  // Basic traversal protection: only allow a plain filename
  const filename = path.basename(raw);
  if (filename !== raw || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const imagePath = path.join(__dirname, '..', 'products', filename);

  if (!fs.existsSync(imagePath)) {
    return res.status(404).json({ error: 'Product image not found' });
  }

  const ext = path.extname(filename).toLowerCase();
  const mime = mimeByExt[ext] || 'application/octet-stream';

  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour

  return res.sendFile(imagePath);
});

module.exports = router;
