const CreditNoteZRAIntegrationService = require('./generateSmartInvoiceCreditNote');
const { normalizeZraSalesData } = require('../sale/zraSaleResponse');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

async function generateQrCode(qrcodeUrl, receiptNo, saveDirectory = './qrcodes') {
  if (!fs.existsSync(saveDirectory)) {
    fs.mkdirSync(saveDirectory, { recursive: true });
  }

  const fileName = `qrcode_${receiptNo}.png`;
  const filePath = path.resolve(saveDirectory, fileName);
  await QRCode.toFile(filePath, qrcodeUrl, { width: 150, margin: 2 });
  return filePath;
}

const limitStr = (value, maxLength) => (value == null ? null : String(value).slice(0, maxLength));

function resolveOriginalSaleZraRefs(originalSale) {
  if (!originalSale) {
    return { orgSdcId: null, orgInvcNo: null };
  }

  const orgSdcId = originalSale.sdcid || originalSale.sdc_id || null;
  const orgInvcNo = originalSale.receipt_no || originalSale.receiptNo || null;

  return { orgSdcId, orgInvcNo };
}

function buildCreditNotePayload(creditNoteInstance, originalSale, returnItems) {
  return {
    subtotal: Number(creditNoteInstance.subtotal || 0),
    discount_amount: Number(creditNoteInstance.discount_amount || 0),
    tax_amount: Number(creditNoteInstance.tax_amount || 0),
    total_amount: Number(creditNoteInstance.total_amount || 0),
    tax_rate: 16,
    payment_method: creditNoteInstance.payment_method,
    amount_paid: Number(creditNoteInstance.amount_paid || 0),
    change_amount: Number(creditNoteInstance.change_amount || 0),
    notes: creditNoteInstance.notes,
    customer: originalSale?.customer || creditNoteInstance.customer || null,
    discount: originalSale?.discount || null,
  };
}

function mapReturnItems(items) {
  return (items || []).map((item) => ({
    product_id: item.product_id,
    quantity: Number(item.quantity),
    unit_price: Number(item.unit_price),
    total_price: Number(item.total_price),
    tax_exclusive_total: item.tax_exclusive_total != null
      ? Number(item.tax_exclusive_total)
      : Number(item.total_price) / 1.16,
    product: item.product || null,
  }));
}

async function buildCreditNoteUpdatesFromZraResponse(cisInvcNo, salesResponse) {
  if (!salesResponse?.success) {
    const error = typeof salesResponse?.error === 'string'
      ? salesResponse.error
      : JSON.stringify(salesResponse?.error || 'Unknown ZRA error');
    return { success: false, error };
  }

  const zraData = normalizeZraSalesData(salesResponse);
  const receivedSdc = zraData.rcptNo != null
    && zraData.sdcId != null
    && (zraData.resultCd == null || zraData.resultCd === '000');

  if (!receivedSdc) {
    const message = zraData.resultMsg
      ? `ZRA ${zraData.resultCd || ''}: ${zraData.resultMsg}`.trim()
      : 'ZRA did not return SDC data';
    return { success: false, error: message, zraData };
  }

  let qrFilePath = null;
  if (zraData.qrCodeUrl && zraData.rcptNo) {
    try {
      qrFilePath = await generateQrCode(zraData.qrCodeUrl, zraData.rcptNo, './qrcodes');
    } catch (qrError) {
      console.error('QR generation failed for credit note:', qrError.message);
    }
  }

  const invoiceNo = (zraData.sdcId && zraData.rcptNo)
    ? `CRN${String(zraData.sdcId).substring(3)}/${zraData.rcptNo}`
    : null;

  return {
    success: true,
    zraData,
    updates: {
      invnumber: limitStr(cisInvcNo, 50),
      receipt_no: limitStr(zraData.rcptNo, 50),
      sdcid: limitStr(zraData.sdcId, 50),
      receiptsig: zraData.rcptSign != null ? String(zraData.rcptSign) : null,
      intrldata: zraData.intrlData != null ? String(zraData.intrlData) : null,
      qrcode_url: limitStr(zraData.qrCodeUrl, 255),
      vsdcrcpdate: limitStr(zraData.vsdcRcptPbctDate, 100),
      invoice_no: limitStr(invoiceNo, 100),
      qrfilepath: limitStr(qrFilePath, 255),
      zra_status: 'sent',
      zra_error: null,
      next_retry_at: null,
      last_retry_at: new Date(),
    },
  };
}

/**
 * Submit one credit note to ZRA and return Sequelize update fields when successful.
 * Used by the create route (immediate fiscalisation) and ZraRetryJob (retries).
 */
async function submitCreditNoteToZra({
  creditNoteInstance,
  originalSale,
  returnItems,
  user,
  reasonCode = '03',
}) {
  const { orgSdcId, orgInvcNo } = resolveOriginalSaleZraRefs(originalSale);

  if (!orgSdcId || !orgInvcNo) {
    return {
      success: false,
      pending: true,
      error: 'Original sale is missing ZRA SDC id / receipt number; cannot register credit note with ZRA yet.',
    };
  }

  const creditNoteZraService = new CreditNoteZRAIntegrationService();
  const creditNoteData = buildCreditNotePayload(creditNoteInstance, originalSale, returnItems);
  const mappedItems = mapReturnItems(returnItems);
  const actingUser = user || creditNoteInstance.cashier || {
    store_id: null,
    id: creditNoteInstance.user_id,
  };

  const salesData = await creditNoteZraService.transformToZRACreditNoteSalesData(
    creditNoteData,
    mappedItems,
    actingUser,
    reasonCode,
    orgInvcNo,
    orgSdcId
  );

  const response = await creditNoteZraService.sendCreditNoteSalesData(salesData);
  const result = await buildCreditNoteUpdatesFromZraResponse(salesData.cisInvcNo, response);

  if (result.success) {
    return {
      success: true,
      updates: result.updates,
      salesData,
      zraData: result.zraData,
    };
  }

  return {
    success: false,
    pending: true,
    error: result.error || 'ZRA did not return SDC data',
    zraData: result.zraData || null,
  };
}

module.exports = {
  resolveOriginalSaleZraRefs,
  buildCreditNoteUpdatesFromZraResponse,
  submitCreditNoteToZra,
};
