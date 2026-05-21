const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

function resolveQrCodePath(filename) {
  const candidates = [
    path.join(process.cwd(), 'qrcodes', filename),
    path.join(path.dirname(process.execPath), 'qrcodes', filename),
    path.join(__dirname, '..', 'qrcodes', filename),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

// Route to serve QR code files
router.get('/:filename', (req, res) => {
  const filename = req.params.filename;
  const qrCodePath = resolveQrCodePath(filename);

  // Check if file exists
  if (fs.existsSync(qrCodePath)) {
    // Set appropriate headers
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour

    // Send the file
    res.sendFile(qrCodePath);
  } else {
    res.status(404).json({ error: 'QR code not found' });
  }
});
module.exports = router;