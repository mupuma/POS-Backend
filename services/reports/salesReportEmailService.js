const fs = require('fs').promises;
const path = require('path');
const reportsRouter = require('../../routes/reports');

const SALES_REPORT_RECIPIENT = 'brightonbanda13@gmail.com';

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

function buildSubject({ storeLabel, startDate, endDate, recordCount, totalAmount }) {
    const startLabel = formatReportDate(startDate);
    const endLabel = formatReportDate(endDate);
    const period = startLabel === endLabel ? startLabel : `${startLabel} to ${endLabel}`;
    const amount = Number(totalAmount || 0).toLocaleString('en-ZM', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });

    return `[DAPP POS] Daily Sales Report — ${storeLabel} — ${period} — ${recordCount} transaction${recordCount === 1 ? '' : 's'}, ZMW ${amount}`;
}

function getDayBounds(dateStr) {
    return {
        startDate: new Date(`${dateStr}T00:00:00.000`),
        endDate: new Date(`${dateStr}T23:59:59.999`),
    };
}

async function sendSalesReportEmail({ storeId = null, store = null, startDate, endDate }) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        return { ok: false, error: 'SMTP credentials are not configured' };
    }

    const reportData = await reportsRouter.generateSalesReport(startDate, endDate, storeId, {});
    const recordCount = reportData.length;
    const totalAmount = reportData.reduce((sum, row) => sum + Number(row.total_amount || 0), 0);
    const storeLabel = resolveStoreLabel(store);
    const subject = buildSubject({ storeLabel, startDate, endDate, recordCount, totalAmount });

    const workbook = await reportsRouter.createExcelReport('sales', reportData, startDate, endDate);

    const tempDir = path.join(__dirname, '../../temp');
    await fs.mkdir(tempDir, { recursive: true });

    const fileName = `sales_report_${formatReportDate(startDate).replace(/\s+/g, '_')}.xlsx`;
    const tempFilePath = path.join(tempDir, fileName);
    await workbook.xlsx.writeFile(tempFilePath);

    try {
        const transporter = reportsRouter.createEmailTransporter();
        await transporter.sendMail({
            from: `"${process.env.COMPANY_NAME || 'DAPP POS'}" <${process.env.SMTP_USER}>`,
            to: SALES_REPORT_RECIPIENT,
            subject,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #4472C4;">Daily Sales Report</h2>
                    <p>Hello,</p>
                    <p>Attached is the automated daily sales report for <strong>${storeLabel}</strong>.</p>
                    <ul>
                        <li><strong>Period:</strong> ${formatReportDate(startDate)} to ${formatReportDate(endDate)}</li>
                        <li><strong>Transactions:</strong> ${recordCount}</li>
                        <li><strong>Total sales:</strong> ZMW ${Number(totalAmount || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</li>
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
        recipient: SALES_REPORT_RECIPIENT,
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
                storeId: store.id,
                store,
                startDate,
                endDate,
            });
            results.push({ store_id: store.id, ...result });
        } catch (error) {
            results.push({ store_id: store.id, ok: false, error: error.message });
        }
    }

    return results;
}

module.exports = {
    SALES_REPORT_RECIPIENT,
    sendSalesReportEmail,
    sendDailySalesReportsForAllStores,
    getDayBounds,
};
