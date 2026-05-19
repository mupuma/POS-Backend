const express = require('express');

const auth = require('../middleware/auth');
const CustomerDirectoryService = require('../services/customerDirectoryService');

const router = express.Router();

router.get('/lookup', auth, async (req, res) => {
  try {
    const service = new CustomerDirectoryService(req.app.locals.models || require('../models'));
    const result = await service.lookupCustomerChain(req.query.tpin);

    if (result.status === 'pending' && req.app.locals.customerKycJob) {
      req.app.locals.customerKycJob.run().catch((error) => {
        console.error('Failed to run customer KYC job:', error.message);
      });
    }

    const statusCode = result.status === 'resolved' ? 200 : 202;
    return res.status(statusCode).json({
      success: true,
      status: result.status,
      source: result.source,
      customer: service.sanitizeCustomer(result.customer),
      message: result.status === 'resolved'
        ? 'Customer resolved successfully'
        : 'Customer lookup queued. Retry shortly.',
    });
  } catch (error) {
    return res.status(400).json({ message: error.message || 'Failed to lookup customer' });
  }
});

router.get('/lookup-status', auth, async (req, res) => {
  try {
    const service = new CustomerDirectoryService(req.app.locals.models || require('../models'));
    const customerRecord = await service.findLocalByTpin(req.query.tpin);

    if (!customerRecord) {
      return res.status(404).json({ message: 'Customer lookup not found' });
    }

    if (customerRecord.lookup_status === 'pending' && req.app.locals.customerKycJob) {
      req.app.locals.customerKycJob.run().catch((error) => {
        console.error('Failed to refresh customer KYC job:', error.message);
      });
    }

    return res.json({
      success: customerRecord.lookup_status === 'resolved',
      status: customerRecord.lookup_status,
      customer: service.sanitizeCustomer(customerRecord),
      message: customerRecord.lookup_error || null,
    });
  } catch (error) {
    return res.status(400).json({ message: error.message || 'Failed to check customer lookup status' });
  }
});

module.exports = router;