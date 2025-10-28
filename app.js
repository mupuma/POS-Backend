const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const {join} = require("node:path");
const models = require('./models');
const InventorySyncJob = require('./jobs/inventorySyncJob');

// ... existing code ...
require('dotenv').config();

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/discounts', require('./routes/discounts'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/users', require('./routes/users'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/qrcodes', require('./routes/qrcodes'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/stores', require('./routes/store'));
app.use('/api/inventory', require('./routes/inventory'));
// Use the new credit notes router that writes to dedicated tables
app.use('/api/creditnotes', require('./routes/creditnotes_v2'));
app.use('api/vsdc/', require('./routes/zra-device'));
app.get('/', (req, res) => {
    res.json({ message: 'POS API is running!' });
});
app.use('/api/notifications', require('./routes/notifications'));



// Optional dev-only debug route (still OK in app layer)
if (process.env.NODE_ENV === 'development') {
    const { getWebSocketService } = require('./notificationsInit');
    app.get('/api/debug/websocket-info', (req, res) => {
        const wsService = getWebSocketService();
        res.json(wsService.getConnectionInfo());
    });
}

// Export only the Express app
module.exports = { app };