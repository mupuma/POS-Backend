const { store } = require('../models');
const axios = require('axios');

/**
 * Sage Shipment Service
 * Handles communication with Sage 300 API for inventory transactions
 */
class SageShipment {
    constructor() {
        this.baseURL = 'http://localhost/Sage300WebApi/v1.0/-/ZPSTST/AR/ARInvoiceBatches';
        // 30 seconds timeout
    }

}
