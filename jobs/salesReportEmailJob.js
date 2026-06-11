const cron = require('node-cron');
const { sendDailySalesReportsForAllStores } = require('../services/reports/salesReportEmailService');

/**
 * Sends daily sales reports to the hardcoded management email address.
 * Runs shortly after day-end so the report covers the full business day.
 */
class SalesReportEmailJob {
    constructor(models) {
        this.models = models;
        this.isRunning = false;
        this.cronJob = null;
        this.schedule = process.env.SALES_REPORT_EMAIL_CRON || '30 20 * * *';
        this.timezone = process.env.TZ || 'Africa/Lusaka';
    }

    async runOnce(triggeredBy = 'scheduled') {
        if (this.isRunning) {
            return { skipped: true, reason: 'SalesReportEmailJob already running' };
        }

        this.isRunning = true;
        const startedAt = new Date();
        const todayStr = new Date().toISOString().split('T')[0];

        try {
            const results = await sendDailySalesReportsForAllStores(this.models, todayStr);
            const sent = results.filter((r) => r.ok).length;
            const failed = results.filter((r) => !r.ok).length;

            return {
                success: failed === 0,
                triggeredBy,
                date: todayStr,
                sent,
                failed,
                results,
                durationSeconds: Math.floor((new Date() - startedAt) / 1000),
            };
        } finally {
            this.isRunning = false;
        }
    }

    start() {
        if (this.cronJob) return;

        this.cronJob = cron.schedule(this.schedule, async () => {
            try {
                const result = await this.runOnce('scheduled');
                console.log(
                    `SalesReportEmailJob: sent ${result.sent || 0}, failed ${result.failed || 0} for ${result.date || 'unknown date'}`
                );
            } catch (error) {
                console.error('SalesReportEmailJob scheduled run failed:', error.message);
            }
        }, {
            scheduled: true,
            timezone: this.timezone,
        });
    }

    stop() {
        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob = null;
        }
    }

    async manualRun() {
        return this.runOnce('manual');
    }
}

module.exports = SalesReportEmailJob;
