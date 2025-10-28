const express = require('express');
const router = express.Router();

/**
 * Initialize device route for ZRA VSDC system
 * Handles device initialization with TPIN, Branch ID, and Device Serial Number
 */
router.post('/initializer/selectInitInfo', async (req, res) => {
    try {
        const { tpin, bhfId, dvcSrlNo } = req.body;

        // Validate required fields
        if (!tpin || !bhfId || !dvcSrlNo) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields',
                message: 'tpin, bhfId, and dvcSrlNo are required'
            });
        }

        // Validate field formats
        if (typeof tpin !== 'string' || tpin.length < 8) {
            return res.status(400).json({
                success: false,
                error: 'Invalid tpin format',
                message: 'tpin must be a string with at least 8 characters'
            });
        }

        if (typeof bhfId !== 'string' || bhfId.length !== 3) {
            return res.status(400).json({
                success: false,
                error: 'Invalid bhfId format',
                message: 'bhfId must be a 3-character string'
            });
        }

        if (typeof dvcSrlNo !== 'string' || dvcSrlNo.length < 5) {
            return res.status(400).json({
                success: false,
                error: 'Invalid dvcSrlNo format',
                message: 'dvcSrlNo must be a string with at least 5 characters'
            });
        }

        console.log('Device initialization request:', { tpin, bhfId, dvcSrlNo });

        // Prepare initialization response data
        const initializationData = {
            tpin: tpin,
            bhfId: bhfId,
            dvcSrlNo: dvcSrlNo,
            initializationDate: new Date().toISOString(),
            status: 'initialized',
            taxServerUrl: process.env.ZRA_TAX_SERVER_URL || 'http://localhost:8082',
            bhfNm: process.env.ZRA_BHF_NAME || 'Main Branch',
            bhfOpenDt: process.env.ZRA_BHF_OPEN_DATE || '20240101',
            prvncNm: process.env.ZRA_PROVINCE_NAME || 'Lusaka',
            dstrtNm: process.env.ZRA_DISTRICT_NAME || 'Lusaka',
            sctrNm: process.env.ZRA_SECTOR_NAME || 'Urban',
            locDesc: process.env.ZRA_LOCATION_DESC || 'City Center'
        };

        // Store device information (in a real implementation, you might save to database)
        console.log('Device initialized successfully:', initializationData);

        return res.status(200).json({
            success: true,
            message: 'Device initialized successfully',
            data: {
                resultCd: '000',
                resultMsg: 'Success',
                resultDt: new Date().toISOString(),
                data: initializationData
            }
        });

    } catch (error) {
        console.error('Device initialization error:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: 'Failed to initialize device',
            details: error.message
        });
    }
});

module.exports = router;
