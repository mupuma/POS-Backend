const express = require('express');
const path = require('path');
const fs = require('fs');

const router = require("./auth");

// Route to serve QR code files
router.get('/:filename', (req, res) => {
  console.log(req.params);
    const filename = req.params.filename;
   const qrCodePath = path.join(__dirname, '..', 'qrcodes', filename);

  console.log(qrCodePath)
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