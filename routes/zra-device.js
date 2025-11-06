const express = require('express');
const axios = require('axios');
const router = express.Router();

/**
 * Initialize device route for ZRA VSDC system
 * Proxies the request to the ZRA service and returns its response as-is
 */
router.post('/initializer/selectInitInfo', async (req, res) => {
    try {
        const { tpin, bhfId, dvcSrlNo } = req.body;

        // Validate required fields
        if (!tpin || !bhfId || !dvcSrlNo) {
            return res.status(400).json({
                resultCd: '400',
                resultMsg: 'Missing required fields',
                resultDt: new Date().toISOString(),
                data: null
            });
        }

        // Basic format validation (kept minimal to avoid blocking valid upstream cases)
        if (typeof tpin !== 'string' || typeof bhfId !== 'string' || typeof dvcSrlNo !== 'string') {
            return res.status(400).json({
                resultCd: '400',
                resultMsg: 'Invalid field types: tpin, bhfId, and dvcSrlNo must be strings',
                resultDt: new Date().toISOString(),
                data: null
            });
        }

        const baseUrl = process.env.ZRA_BASE_URL
        const url = `${baseUrl}/initializer/selectInitInfo`;

        console.log('Proxying device initialization to ZRA:', { url, tpin, bhfId, dvcSrlNo });

        const response = await axios.post(
            url,
            { tpin, bhfId, dvcSrlNo },
            { headers: { 'Content-Type': 'application/json' } }
        );

        // Forward the upstream JSON exactly
        return res.status(200).json(response.data);
    } catch (error) {
        // If upstream returned an error response, relay its status and body
        if (error.response) {
            console.error('ZRA upstream error:', {
                status: error.response.status,
                data: error.response.data
            });
            return res.status(error.response.status).json(error.response.data);
        }

        // Network or unexpected error
        console.error('Device initialization error:', error.message);
        return res.status(500).json({
            resultCd: '500',
            resultMsg: 'Failed to initialize device',
            resultDt: new Date().toISOString(),
            data: null
        });
    }
});

module.exports = router;
