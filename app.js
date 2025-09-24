const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increased limit for ZRA data
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ✅ FIX THIS: Serve QR code images from public/qrcodes with /sandboxvsdc prefix
const publicQrCodeDir = path.join(__dirname, 'public', 'qrcodes');
app.use('/sandboxvsdc/qrcodes', express.static(publicQrCodeDir));

// ✅ ADD THIS: Also create the public/qrcodes directory
if (!fs.existsSync(publicQrCodeDir)) {
    fs.mkdirSync(publicQrCodeDir, { recursive: true });
    console.log('Public QR codes directory created:', publicQrCodeDir);
}

// ✅ ADD THIS: Serve other static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// ✅ ADD THIS: ZRA Integration Middleware
app.use((req, res, next) => {
    // Add ZRA headers for all responses
    res.setHeader('X-ZRA-Integration', process.env.ZRA_ENABLED === 'true' ? 'enabled' : 'disabled');
    res.setHeader('X-ZRA-TPIN', process.env.ZRA_TPIN || 'not-set');
    res.setHeader('Access-Control-Expose-Headers', 'X-ZRA-Integration, X-ZRA-TPIN');
    next();
});

// ✅ ADD THIS: Health check endpoint for ZRA integration
app.get('/api/health/zra', (req, res) => {
    const zraStatus = {
        enabled: process.env.ZRA_ENABLED === 'true',
        baseUrl: process.env.ZRA_BASE_URL,
        tpin: process.env.ZRA_TPIN,
        branchId: process.env.ZRA_BHF_ID,
        status: process.env.ZRA_ENABLED === 'true' ? 'active' : 'disabled',
        qrCodePath: publicQrCodeDir,
        qrCodeUrl: '/sandboxvsdc/qrcodes/'
    };
    res.json(zraStatus);
});

// ✅ ADD THIS: QR code test endpoint
app.get('/api/test/qrcode', async (req, res) => {
    try {
        const QRCode = require('qrcode');
        const testData = {
            test: true,
            message: 'QR Code Test',
            timestamp: new Date().toISOString()
        };
        
        const fileName = `test_qr_${Date.now()}.png`;
        const filePath = path.join(publicQrCodeDir, fileName);
        const publicUrl = `/sandboxvsdc/qrcodes/${fileName}`;
        const fullUrl = `${req.protocol}://${req.get('host')}${publicUrl}`;
        
        await QRCode.toFile(filePath, JSON.stringify(testData), {
            width: 200,
            margin: 2,
            errorCorrectionLevel: 'H'
        });
        
        res.json({
            success: true,
            message: 'QR code generated successfully',
            filePath: filePath,
            publicUrl: publicUrl,
            fullUrl: fullUrl
        });
    } catch (error) {
        console.error('QR code test error:', error);
        res.status(500).json({
            success: false,
            message: 'QR code generation failed',
            error: error.message
        });
    }
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/discounts', require('./routes/discounts'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/users', require('./routes/users'));
//app.use('/api/store', require('./routes/store'));

// ✅ ADD THIS: ZRA specific routes
app.use('/api/zra', require('./routes/zra')); // You'll need to create this route


// ✅ ADD THIS: Route to get QR code by filename
app.get('/api/qrcode/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(publicQrCodeDir, filename);
    
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).json({
            success: false,
            message: 'QR code not found',
            filename: filename
        });
    }
});

// Comment this out temporarily - ZRA error handling middleware
/*
app.use((error, req, res, next) => {
    if (error.message.includes('ZRA') || error.message.includes('tax') || error.message.includes('invoice')) {
        console.error('ZRA Integration Error:', error);
        return res.status(500).json({
            success: false,
            message: 'ZRA integration failed',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Tax compliance service unavailable'
        });
    }
    next(error);
});
*/

// ✅ ADD THIS: Global error handler
app.use((error, req, res, next) => {
    console.error('Global Error Handler:', error);
    res.status(500).json({
        success: false,
        message: 'Internal server error',
        ...(process.env.NODE_ENV === 'development' && { error: error.message })
    });
});

app.get('/', (req, res) => {
  res.json({ 
      message: 'POS API is running!',
      zraIntegration: process.env.ZRA_ENABLED === 'true' ? 'enabled' : 'disabled',
      version: '1.0.0',
      qrCodeSupport: true,
      qrCodeDirectory: publicQrCodeDir,
      qrCodeBaseUrl: '/sandboxvsdc/qrcodes/'
  });
});

// ✅ ADD THIS: Catch all route for undefined endpoints
app.use((req, res) => {
    res.status(404).json({ 
        success: false, 
        message: 'Endpoint not found',
        zraEnabled: process.env.ZRA_ENABLED === 'true',
        availableEndpoints: [
            '/api/auth',
            '/api/products',
            '/api/sales',
            '/api/health/zra',
            '/api/test/qrcode'
        ]
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`ZRA Integration: ${process.env.ZRA_ENABLED === 'true' ? 'ENABLED' : 'DISABLED'}`);
    console.log(`QR Code Directory: ${publicQrCodeDir}`);
    console.log(`QR Codes accessible at: http://localhost:${PORT}/sandboxvsdc/qrcodes/`);
});

module.exports = app;