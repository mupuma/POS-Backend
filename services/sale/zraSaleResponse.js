const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

function generateInvoiceNumber(sdcid, receiptNo) {
    return `INV${String(sdcid).substring(3)}/${receiptNo}`;
}

function normalizeZraSalesData(salesResponse) {
    const outer = salesResponse?.data || null;
    const inner = outer?.data || null;
    const recovered = salesResponse?.sdcRecovery?.found ? salesResponse.sdcRecovery.data : null;

    return {
        rcptNo: inner?.rcptNo ?? outer?.rcptNo ?? recovered?.rcptNo ?? null,
        sdcId: inner?.sdcId ?? outer?.sdcId ?? recovered?.sdcId ?? null,
        rcptSign: inner?.rcptSign ?? outer?.rcptSign ?? recovered?.rcptSign ?? null,
        intrlData: inner?.intrlData ?? outer?.intrlData ?? recovered?.intrlData ?? null,
        qrCodeUrl: inner?.qrCodeUrl ?? outer?.qrCodeUrl ?? recovered?.qrCodeUrl ?? null,
        vsdcRcptPbctDate: inner?.vsdcRcptPbctDate ?? outer?.vsdcRcptPbctDate ?? recovered?.vsdcRcptPbctDate ?? null,
        resultCd: outer?.resultCd ?? null,
        resultMsg: outer?.resultMsg ?? null,
        recoverySource: recovered ? salesResponse.sdcRecovery.source : null,
        recoveryReason: recovered ? salesResponse.sdcRecovery.reason : null,
        raw: salesResponse?.data || null,
    };
}

const limitStr = (v, n) => (v == null ? null : String(v).slice(0, n));

function getZraResultMessage(response) {
    if (response == null) return '';
    if (typeof response === 'string') return response;
    if (response instanceof Error) return response.message || '';

    const data = response.data || response.error || response;
    if (typeof data === 'string') return data;
    if (!data || typeof data !== 'object') return '';

    return [
        data.resultCd,
        data.resultMsg,
        data.message,
        data.error,
        data.data?.resultCd,
        data.data?.resultMsg,
        data.data?.message,
        data.data?.error,
    ]
        .filter((value) => value != null)
        .map((value) => String(value))
        .join(' ');
}

function isZraSaleAlreadyExistsResponse(response) {
    return /\b(already\s+exist(?:s|ed)?|already\s+registered|duplicate|exists\s+already)\b/i
        .test(getZraResultMessage(response));
}

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
function requiresComplianceRefresh(saleInstance) {
    const zraStatus = saleInstance?.zra_status;
    const hasRequiredRefs = Boolean(saleInstance?.sdcid && saleInstance?.receipt_no);
    const hasComplianceFields = Boolean(
        saleInstance?.receiptsig || saleInstance?.intrldata || saleInstance?.qrcode_url || saleInstance?.vsdcrcpdate
    );

    return zraStatus === 'sent'
        ? (!hasRequiredRefs || !hasComplianceFields)
        : true;
}

async function buildSaleUpdatesFromZraResponse(cisInvcNo, salesResponse) {
    if (!salesResponse?.success) {
        const error = typeof salesResponse?.error === 'string'
            ? salesResponse.error
            : JSON.stringify(salesResponse?.error || 'Unknown ZRA error');
        return { success: false, error };
    }

    const saveSalesData = normalizeZraSalesData(salesResponse);
    let qrFilePath = null;

    const hasRecoveredSdcData = Boolean(salesResponse?.sdcRecovery?.found);
    if (saveSalesData.resultCd && String(saveSalesData.resultCd) !== '000' && !hasRecoveredSdcData) {
        const detail = saveSalesData.resultMsg ? ` (${saveSalesData.resultMsg})` : '';
        return {
            success: false,
            error: `ZRA rejected sales data with result code ${saveSalesData.resultCd}${detail}`,
            saveSalesData,
        };
    }

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

    const hasRequiredZraRefs = Boolean(saveSalesData.sdcId && saveSalesData.rcptNo);
    if (!hasRequiredZraRefs) {
        const detail = saveSalesData.resultMsg ? ` (${saveSalesData.resultMsg})` : '';
        return {
            success: false,
            error: `ZRA did not return SDC data${detail}`,
            saveSalesData,
        };
    }

    const computedInvoiceNoRaw = generateInvoiceNumber(saveSalesData.sdcId, saveSalesData.rcptNo);

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
    getZraResultMessage,
    isZraSaleAlreadyExistsResponse,
    normalizeZraSalesData,
    buildSaleUpdatesFromZraResponse,
    requiresComplianceRefresh,
};
