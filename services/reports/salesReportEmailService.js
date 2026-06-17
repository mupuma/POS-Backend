const fs = require('fs').promises;
const path = require('path');
const ExcelJS = require('exceljs');
const nodemailer = require('nodemailer');

const DEFAULT_REPORT_RECIPIENTS = (process.env.SALES_REPORT_RECIPIENTS || process.env.SALES_REPORT_RECIPIENT || 'brightonbanda13@gmail.com');
const REPORT_RECIPIENTS = DEFAULT_REPORT_RECIPIENTS.split(',').map((recipient) => recipient.trim()).filter(Boolean);
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

function formatReportDate(date) {
    return new Date(date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
    });
}

function resolveStoreLabel(store) {
    if (!store) return 'All Stores';
    const number = store.store_number || store.id;
    const location = store.store_location ? ` ${store.store_location}` : '';
    return `Store ${number}${location}`;
}

function formatWithCurrency(value) {
    return Number(value || 0).toLocaleString('en-ZM', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function buildSubject({ storeLabel, startDate, endDate, recordCount, totalAmount, reportFrequency }) {
    const startLabel = formatReportDate(startDate);
    const endLabel = formatReportDate(endDate);
    const period = startLabel === endLabel ? startLabel : `${startLabel} to ${endLabel}`;
    const amount = formatWithCurrency(totalAmount);
    const frequencyLabel = reportFrequency === 'monthly' ? 'Monthly' : 'Daily';

    return `[DAPP POS] ${frequencyLabel} Sales Report — ${storeLabel} — ${period} — ${recordCount} transaction${recordCount === 1 ? '' : 's'}, ZMW ${amount}`;
}

function getDayBounds(dateStr) {
    return {
        startDate: new Date(`${dateStr}T00:00:00.000Z`),
        endDate: new Date(`${dateStr}T23:59:59.999Z`),
    };
}

function getMonthDays(year, month) {
    return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function clampDay(day, year, month) {
    return Math.min(day, getMonthDays(year, month));
}

function addMonthsUTC(date, months) {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + months;
    const day = date.getUTCDate();
    const result = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
    result.setUTCDate(clampDay(day, result.getUTCFullYear(), result.getUTCMonth()));
    return result;
}

function getPeriodStartForDate(date, startDay) {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const candidateDay = clampDay(startDay, year, month);
    const candidate = new Date(Date.UTC(year, month, candidateDay, 0, 0, 0, 0));
    if (date.getTime() < candidate.getTime()) {
        const previous = addMonthsUTC(candidate, -1);
        return new Date(Date.UTC(previous.getUTCFullYear(), previous.getUTCMonth(), clampDay(startDay, previous.getUTCFullYear(), previous.getUTCMonth()), 0, 0, 0, 0));
    }
    return candidate;
}

function getAlignedCycleStart(date, startDay, durationMonths) {
    const periodStart = getPeriodStartForDate(date, startDay);
    const absoluteMonthIndex = periodStart.getUTCFullYear() * 12 + periodStart.getUTCMonth();
    const cycleIndex = Math.floor(absoluteMonthIndex / durationMonths) * durationMonths;
    const year = Math.floor(cycleIndex / 12);
    const month = cycleIndex % 12;
    return new Date(Date.UTC(year, month, clampDay(startDay, year, month), 0, 0, 0, 0));
}

function getPeriodEnd(periodStart, durationMonths) {
    const nextStart = addMonthsUTC(periodStart, durationMonths);
    return new Date(nextStart.getTime() - 1);
}

function getLastCompletedPeriod(now, startDay, durationMonths) {
    const cycleStart = getAlignedCycleStart(now, startDay, durationMonths);
    const cycleEnd = getPeriodEnd(cycleStart, durationMonths);

    if (now.getTime() > cycleEnd.getTime()) {
        return { periodStart: cycleStart, periodEnd: cycleEnd };
    }

    const previousStart = addMonthsUTC(cycleStart, -durationMonths);
    return { periodStart: previousStart, periodEnd: getPeriodEnd(previousStart, durationMonths) };
}

function getPeriodKey(reportType, startDate, endDate) {
    return `${reportType}:${startDate.toISOString().slice(0, 10)}_${endDate.toISOString().slice(0, 10)}`;
}

function createEmailTransporter() {
    return nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
}

async function verifyTransporter(transporter) {
    try {
        await transporter.verify();
        return true;
    } catch (error) {
        return false;
    }
}

function buildReportWorkbook(reportData, startDate, endDate, storeLabel, reportFrequency) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Sales Report');

    worksheet.addRow([`${reportFrequency === 'monthly' ? 'Monthly' : 'Daily'} Sales Report`]);
    worksheet.addRow([`${storeLabel}`]);
    worksheet.addRow([`Period: ${formatReportDate(startDate)} - ${formatReportDate(endDate)}`]);
    worksheet.addRow([]);

    const headerRow = worksheet.addRow([
        'Receipt',
        'Date',
        'Cashier',
        'Store',
        'Payment Method',
        'Items',
        'Subtotal',
        'Tax',
        'Discount',
        'Total',
    ]);
    headerRow.font = { bold: true };

    reportData.forEach((row) => {
        worksheet.addRow([
            row.receipt_number,
            new Date(row.sale_date).toLocaleString('en-GB', { hour12: false }),
            row.cashier_name,
            row.store_label,
            row.payment_method,
            row.items_count,
            formatWithCurrency(row.subtotal),
            formatWithCurrency(row.tax_amount),
            formatWithCurrency(row.discount_amount),
            formatWithCurrency(row.total_amount),
        ]);
    });

    const totalRow = worksheet.addRow([
        'Totals',
        null,
        null,
        null,
        null,
        reportData.reduce((sum, row) => sum + Number(row.items_count || 0), 0),
        formatWithCurrency(reportData.reduce((sum, row) => sum + Number(row.subtotal || 0), 0)),
        formatWithCurrency(reportData.reduce((sum, row) => sum + Number(row.tax_amount || 0), 0)),
        formatWithCurrency(reportData.reduce((sum, row) => sum + Number(row.discount_amount || 0), 0)),
        formatWithCurrency(reportData.reduce((sum, row) => sum + Number(row.total_amount || 0), 0)),
    ]);
    totalRow.font = { bold: true };

    worksheet.columns.forEach((column) => { column.width = 16; });
    worksheet.getColumn(2).width = 22;
    worksheet.getColumn(3).width = 20;
    worksheet.getColumn(4).width = 20;

    worksheet.views = [{ state: 'frozen', ySplit: 5 }];
    worksheet.autoFilter = { from: 'A5', to: `J${worksheet.rowCount}` };

    return workbook;
}

async function generateSalesReport(models, startDate, endDate, storeId) {
    const where = {
        sale_date: {
            [models.Sequelize.Op.between]: [startDate, endDate],
        },
    };

    const include = [
        {
            model: models.user,
            as: 'cashier',
            attributes: ['id', 'full_name', 'store_id'],
            include: [
                {
                    model: models.store,
                    as: 'store',
                    attributes: ['id', 'store_number', 'store_location'],
                },
            ],
            ...(storeId ? { where: { store_id: storeId }, required: true } : {}),
        },
        {
            model: models.saleitem,
            as: 'items',
            attributes: ['id', 'quantity', 'unit_price', 'total_price'],
            include: [
                {
                    model: models.product,
                    as: 'product',
                    attributes: ['id', 'product_code', 'name'],
                },
            ],
        },
    ];

    const sales = await models.sale.findAll({
        where,
        include,
        order: [['sale_date', 'ASC']],
    });

    return sales.map((sale) => ({
        sale_id: sale.id,
        receipt_number: sale.receipt_number,
        invoice_no: sale.invoice_no,
        sale_date: sale.sale_date,
        cashier_name: sale.cashier?.full_name || 'Unknown',
        store_label: resolveStoreLabel(sale.cashier?.store),
        payment_method: sale.payment_method,
        items_count: (sale.items || []).reduce((count, item) => count + Number(item.quantity || 0), 0),
        subtotal: Number(sale.subtotal || 0),
        tax_amount: Number(sale.tax_amount || 0),
        discount_amount: Number(sale.discount_amount || 0),
        total_amount: Number(sale.total_amount || 0),
    }));
}

async function sendSalesReportEmail({ models, storeId = null, store = null, startDate, endDate, reportFrequency = 'daily' }) {
    if (!SMTP_USER || !SMTP_PASS) {
        return { ok: false, error: 'SMTP credentials are not configured' };
    }

    const reportData = await generateSalesReport(models, startDate, endDate, storeId);
    const recordCount = reportData.length;
    const totalAmount = reportData.reduce((sum, row) => sum + Number(row.total_amount || 0), 0);
    const storeLabel = resolveStoreLabel(store);
    const subject = buildSubject({ storeLabel, startDate, endDate, recordCount, totalAmount, reportFrequency });

    const workbook = buildReportWorkbook(reportData, startDate, endDate, storeLabel, reportFrequency);
    const tempDir = path.join(__dirname, '../../temp');
    await fs.mkdir(tempDir, { recursive: true });

    const fileName = `sales_report_${reportFrequency}_${startDate.toISOString().slice(0, 10)}_to_${endDate.toISOString().slice(0, 10)}.xlsx`;
    const tempFilePath = path.join(tempDir, fileName);
    await workbook.xlsx.writeFile(tempFilePath);

    const transporter = createEmailTransporter();
    const verified = await verifyTransporter(transporter);
    if (!verified) {
        await fs.unlink(tempFilePath).catch(() => {});
        return { ok: false, error: 'Unable to verify SMTP transporter. Internet connectivity or SMTP credentials may be invalid.' };
    }

    try {
        await transporter.sendMail({
            from: `"${process.env.COMPANY_NAME || 'DAPP POS'}" <${SMTP_USER}>`,
            to: REPORT_RECIPIENTS,
            subject,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #4472C4;">${reportFrequency === 'monthly' ? 'Monthly' : 'Daily'} Sales Report</h2>
                    <p>Hello,</p>
                    <p>Attached is the automated ${reportFrequency === 'monthly' ? 'monthly' : 'daily'} sales report for <strong>${storeLabel}</strong>.</p>
                    <ul>
                        <li><strong>Period:</strong> ${formatReportDate(startDate)} to ${formatReportDate(endDate)}</li>
                        <li><strong>Transactions:</strong> ${recordCount}</li>
                        <li><strong>Total sales:</strong> ZMW ${formatWithCurrency(totalAmount)}</li>
                    </ul>
                    <p>The report is attached in Excel format (.xlsx).</p>
                    <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
                    <p style="color: #666; font-size: 12px;">
                        Automated message from ${process.env.COMPANY_NAME || 'DAPP POS'}. Please do not reply.
                    </p>
                </div>
            `,
            attachments: [{ filename: fileName, path: tempFilePath }],
        });
    } finally {
        await fs.unlink(tempFilePath).catch(() => {});
    }

    return {
        ok: true,
        recipients: REPORT_RECIPIENTS,
        subject,
        recordCount,
        totalAmount,
    };
}

async function sendDailySalesReportsForAllStores(models, dateStr) {
    const { startDate, endDate } = getDayBounds(dateStr);
    const stores = await models.store.findAll();
    const results = [];

    for (const store of stores) {
        try {
            const result = await sendSalesReportEmail({
                models,
                storeId: store.id,
                store,
                startDate,
                endDate,
                reportFrequency: 'daily',
            });
            results.push({ store_id: store.id, ...result });
        } catch (error) {
            results.push({ store_id: store.id, ok: false, error: error.message });
        }
    }

    return results;
}

async function sendMonthlySalesReportsForAllStores(models, options = {}) {
    const durationMonths = Number(options.periodDurationMonths || process.env.SALES_REPORT_PERIOD_DURATION_MONTHS || 1);
    const startDay = Number(options.periodStartDay || process.env.SALES_REPORT_PERIOD_START_DAY || 1);
    const now = options.referenceDate || new Date();
    const { periodStart, periodEnd } = getLastCompletedPeriod(now, startDay, durationMonths);
    const periodKey = getPeriodKey('sales_monthly', periodStart, periodEnd);
    const stores = await models.store.findAll();
    const results = [];

    for (const store of stores) {
        const [logEntry] = await models.report_email_log.findOrCreate({
            where: {
                store_id: store.id,
                report_type: 'monthly_sales',
                period_key: periodKey,
            },
            defaults: {
                period_start: periodStart,
                period_end: periodEnd,
                status: 'pending',
                attempt_count: 0,
                email_to: REPORT_RECIPIENTS.join(','),
            },
        });

        if (logEntry.status === 'sent') {
            results.push({ store_id: store.id, ok: true, skipped: true, reason: 'Already sent' });
            continue;
        }

        const attempt = logEntry.attempt_count + 1;
        try {
            const result = await sendSalesReportEmail({
                models,
                storeId: store.id,
                store,
                startDate: periodStart,
                endDate: periodEnd,
                reportFrequency: 'monthly',
            });

            await logEntry.update({
                status: result.ok ? 'sent' : 'failed',
                attempt_count: attempt,
                sent_at: result.ok ? new Date() : null,
                error_message: result.ok ? null : result.error,
            });

            results.push({ store_id: store.id, ...result, attempt });
        } catch (error) {
            await logEntry.update({
                status: 'failed',
                attempt_count: attempt,
                error_message: error.message,
            });
            results.push({ store_id: store.id, ok: false, error: error.message, attempt });
        }
    }

    return {
        periodKey,
        periodStart,
        periodEnd,
        results,
    };
}

module.exports = {
    REPORT_RECIPIENTS,
    sendSalesReportEmail,
    sendDailySalesReportsForAllStores,
    sendMonthlySalesReportsForAllStores,
    getDayBounds,
    getLastCompletedPeriod,
    getPeriodKey,
};
