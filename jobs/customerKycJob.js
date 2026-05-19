const cron = require('node-cron');
const { Op } = require('sequelize');

const CustomerDirectoryService = require('../services/customerDirectoryService');

class CustomerKycJob {
  constructor(models) {
    this.models = models;
    this.service = new CustomerDirectoryService(models);
    this.cronJob = null;
    this.isRunning = false;
    this.intervalCron = '*/1 * * * *';
  }

  start() {
    if (this.cronJob) {
      return;
    }

    this.cronJob = cron.schedule(this.intervalCron, async () => {
      try {
        await this.run();
      } catch (_) {}
    }, { scheduled: true, timezone: 'Africa/Lusaka' });
  }

  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
  }

  async run() {
    if (this.isRunning) {
      return { skipped: true };
    }

    this.isRunning = true;

    try {
      const rows = await this.models.customer.findAll({
        where: {
          [Op.or]: [
            { lookup_status: 'pending' },
            { needs_central_sync: true, tpin: { [Op.ne]: null } },
          ],
        },
        order: [['zra_lookup_requested_at', 'ASC'], ['id', 'ASC']],
        limit: 10,
      });

      for (const row of rows) {
        await this.processCustomer(row);
      }

      return { success: true, processed: rows.length };
    } finally {
      this.isRunning = false;
    }
  }

  async processCustomer(customerRecord) {
    let currentCustomer = customerRecord;

    if (currentCustomer.lookup_status === 'pending') {
      const lookupResult = await this.service.resolveWithZra(currentCustomer);
      if (!lookupResult.success) {
        return lookupResult;
      }

      currentCustomer = lookupResult.customer;
    }

    if (currentCustomer && currentCustomer.needs_central_sync) {
      return this.service.syncToCentral(currentCustomer);
    }

    return { success: true, skipped: true };
  }
}

module.exports = CustomerKycJob;