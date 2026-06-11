const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

function generateInvoiceNumber(sdcid, receiptNo) {
    return `INV${String(sdcid).substring(3)}/${receiptNo}`;
}

function normalizeZraSalesData(salesResponse) {
    const outer = salesResponse?.data || null;
    const inner = outer?.data || null;

    return {
        rcptNo: inner?.rcptNo ?? outer?.rcptNo ?? null,
        sdcId: inner?.sdcId ?? outer?.sdcId ?? null,
        rcptSign: inner?.rcptSign ?? outer?.rcptSign ?? null,
        intrlData: inner?.intrlData ?? outer?.intrlData ?? null,
        qrCodeUrl: inner?.qrCodeUrl ?? outer?.qrCodeUrl ?? null,
        vsdcRcptPbctDate: inner?.vsdcRcptPbctDate ?? outer?.vsdcRcptPbctDate ?? null,
        resultCd: outer?.resultCd ?? null,
        resultMsg: outer?.resultMsg ?? null,
        raw: salesResponse?.data || null,
    };
}

const limitStr = (v, n) => (v == null ? null : String(v).slice(0, n));

async function generateQrCode(qrcodeUrl, receiptNo, saveDirectory = './qrcodes') {
    if (!fs.existsSync(saveDirectory)) {
        fs.mkdirSync(saveDirectory, { recursive: true });
    }

    const fileName = `qrcode_${receiptNo}.png`;
    const filePath = path.resolve(saveDirectory, fileName);
    await QRCode.toFile(filePath, qrcodeUrl, {
        width: 150,
        margin: 2,
    });

    return filePath;
}

/**
 * Build Sequelize update payload from a successful ZRA saveSales response.
 * @param {string|null} cisInvcNo Pre-assigned CIS invoice number stored on the local sale
 * @param {object} salesResponse Response from sendSalesData
 * @returns {Promise<{ success: boolean, updates?: object, saveSalesData?: object, error?: string }>}
 */
async function buildSaleUpdatesFromZraResponse(cisInvcNo, salesResponse) {
    if (!salesResponse?.success) {
        const error = typeof salesResponse?.error === 'string'
            ? salesResponse.error
            : JSON.stringify(salesResponse?.error || 'Unknown ZRA error');
        return { success: false, error };
    }

    const saveSalesData = normalizeZraSalesData(salesResponse);
    let qrFilePath = null;

    if (saveSalesData.qrCodeUrl && saveSalesData.rcptNo) {
        try {
            qrFilePath = await generateQrCode(
                saveSalesData.qrCodeUrl,
                saveSalesData.rcptNo,
                './qrcodes'
            );
        } catch (qrError) {
            console.error('QR Code generation failed:', qrError);
        }
    }

    const computedInvoiceNoRaw = (saveSalesData.sdcId && saveSalesData.rcptNo)
        ? generateInvoiceNumber(saveSalesData.sdcId, saveSalesData.rcptNo)
        : null;

    return {
        success: true,
        saveSalesData,
        updates: {
            invnumber: limitStr(cisInvcNo, 50),
            receipt_no: limitStr(saveSalesData.rcptNo, 50),
            sdcid: limitStr(saveSalesData.sdcId, 50),
            receiptsig: limitStr(saveSalesData.rcptSign, 50),
            intrldata: limitStr(saveSalesData.intrlData, 100),
            qrcode_url: limitStr(saveSalesData.qrCodeUrl, 255),
            vsdcrcpdate: limitStr(saveSalesData.vsdcRcptPbctDate, 100),
            invoice_no: limitStr(computedInvoiceNoRaw, 100),
            qrfilepath: limitStr(qrFilePath, 255),
            zra_status: 'sent',
            zra_error: null,
            next_retry_at: null,
            last_retry_at: new Date(),
        },
    };
}

module.exports = {
    generateInvoiceNumber,
    normalizeZraSalesData,
    buildSaleUpdatesFromZraResponse,
};
