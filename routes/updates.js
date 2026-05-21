const express = require('express');
const axios = require('axios');

const router = express.Router();

async function fetchCentralUpdateManifest() {
  const syncServerUrl = String(process.env.SYNC_SERVER_URL || '').replace(/\/$/, '');
  if (!syncServerUrl) {
    return null;
  }

  const response = await axios.get(`${syncServerUrl}/updates/version.json`, {
    timeout: 8000,
    headers: {
      Accept: 'application/json',
    },
  });

  return response.data;
}

function buildEnvManifest() {
  const version = process.env.UPDATE_VERSION || process.env.APP_VERSION || '1.0.0';
  const downloadUrl = process.env.UPDATE_DOWNLOAD_URL || '';

  if (!downloadUrl) {
    return null;
  }

  return {
    version,
    downloadUrl,
    releaseNotes: process.env.UPDATE_RELEASE_NOTES || '',
    mandatory: String(process.env.UPDATE_MANDATORY || 'false').toLowerCase() === 'true',
    publishedAt: process.env.UPDATE_PUBLISHED_AT || new Date().toISOString(),
  };
}

router.get('/version.json', async (req, res) => {
  try {
    const centralManifest = await fetchCentralUpdateManifest();
    if (centralManifest) {
      return res.json(centralManifest);
    }
  } catch (error) {
    console.error('Failed to fetch central update manifest:', error.message);
  }

  const envManifest = buildEnvManifest();
  if (envManifest) {
    return res.json(envManifest);
  }

  return res.status(404).json({
    message: 'No published update is available',
  });
});

module.exports = router;