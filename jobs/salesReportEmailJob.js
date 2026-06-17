const cron = require('node-cron');
const {
    sendDailySalesReportsForAllStores,
    sendMonthlySalesReportsForAllStores,
} = require('../services/reports/salesReportEmailService');

/**
 * Sends daily sales reports to the hardcoded management email address.
 * Optionally sends monthly sales reports based on configured period definitions.
 */
class SalesReportEmailJob {
    constructor(models) {
        this.models = models;
        this.isRunning = false;
        this.cronJob = null;
        this.schedule = process.env.SALES_REPORT_EMAIL_CRON || '30 20 * * *';
        this.timezone = process.env.TZ || 'Africa/Lusaka';
        this.monthlyEnabled = Number(process.env.SALES_REPORT_PERIOD_DURATION_MONTHS || 0) > 0;
    }

    async runDaily() {
        const todayStr = new Date().toISOString().split('T')[0];
        const results = await sendDailySalesReportsForAllStores(this.models, todayStr);
        const sent = results.filter((r) => r.ok).length;
        const failed = results.filter((r) => !r.ok).length;
        return { sent, failed, results, date: todayStr };
    }

    async runMonthly() {
        const monthlyResult = await sendMonthlySalesReportsForAllStores(this.models, {
            periodDurationMonths: process.env.SALES_REPORT_PERIOD_DURATION_MONTHS,
            periodStartDay: process.env.SALES_REPORT_PERIOD_START_DAY,
        });
        const sent = monthlyResult.results.filter((r) => r.ok).length;
        const failed = monthlyResult.results.filter((r) => !r.ok).length;
        return { ...monthlyResult, sent, failed };
    }

    async runOnce(triggeredBy = 'scheduled') {
        if (this.isRunning) {
            return { skipped: true, reason: 'SalesReportEmailJob already running' };
        }

        this.isRunning = true;
        const startedAt = new Date();
        const outcome = {
            success: true,
            triggeredBy,
            durationSeconds: 0,
            daily: null,
            monthly: null,
        };

        try {
            const dailyResult = await this.runDaily();
            outcome.daily = dailyResult;
            outcome.success = outcome.success && dailyResult.failed === 0;

            if (this.monthlyEnabled) {
                const monthlyResult = await this.runMonthly();
                outcome.monthly = monthlyResult;
                outcome.success = outcome.success && monthlyResult.failed === 0;
            }

            return outcome;
        } finally {
            outcome.durationSeconds = Math.floor((new Date() - startedAt) / 1000);
            this.isRunning = false;
        }
    }

    start() {
        if (this.cronJob) return;

        this.cronJob = cron.schedule(this.schedule, async () => {
            try {
                const result = await this.runOnce('scheduled');
                if (result.daily) {
                    console.log(
                        `SalesReportEmailJob: daily sent ${result.daily.sent || 0}, failed ${result.daily.failed || 0} for ${result.daily.date || 'unknown date'}`
                    );
                }
                if (result.monthly) {
                    console.log(
                        `SalesReportEmailJob: monthly period ${result.monthly.periodStart?.toISOString().slice(0, 10)} to ${result.monthly.periodEnd?.toISOString().slice(0, 10)} sent ${result.monthly.sent || 0}, failed ${result.monthly.failed || 0}`
                    );
                }
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
