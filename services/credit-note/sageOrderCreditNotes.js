const axios = require('axios');

/**
 * Sage Credit Notes Service
 * Creates Credit Notes in Sage 300 OE module
 */
class SageCreditNotesService {
  constructor() {
    this.timeout = 60000; // 60s default
  }

  // Round a value to 4 decimal places and return a number
  _to2(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return 0;
    return Number(x.toFixed(4));
  }

  _normalizeItem(item) {
    const quantity = Number(item.quantity ?? 0);
    const unit_price = Number(item.unit_price ?? 0);
    const code = item.product?.formatted_product_code ||
                 item.formatted_product_code ||
                 item.product?.product_code ||
                 item.product_code ||
                 (item.product_id ? String(item.product_id) : '');
    const description = item.product?.name || item.name || 'Item';
    return {
      quantity,
      unit_price: this._to2(unit_price),
      code,
      description
    };
  }

  /**
   * Create a single credit note
   * @param {Object} returnData - Return/refund data
   * @param {Object} user - User/store information
   * @param {string} date - Credit note date
   * @param {string} orderNumber - Original order number (optional)
   * @param {string} invoiceNumber - Original invoice number (optional)
   */
  async createCreditNote(returnData, user, date, orderNumber = null, invoiceNumber = null) {
    const username = process.env.SAGE_USERNAME || 'ADMIN';
    const password = process.env.SAGE_PASSWORD || 'Admin123!';
    const baseURL = process.env.SAGE_BASE_URL;

    const auth = `${username}:${password}`;
    const encodedAuth = Buffer.from(auth, 'utf-8').toString('base64');
    const authorization = `Basic ${encodedAuth}`;

    const utcDate = new Date().toISOString();
    const creditNoteDate = date ? new Date(date).toISOString() : utcDate;

    // Build credit note details (line items)
    let detailIdx = 0;
    const creditDebitDetails = [];

    for (const raw of (returnData.items || [])) {
      const it = this._normalizeItem(raw);
      creditDebitDetails.push({
        LineNumber: (detailIdx + 1) * 32,
        LineType: 'Item',
        Item: it.code,
        Description: it.description,
        Location: user?.store?.store_number || '',
        Category: user?.store?.store_customer_number || '',
        StockItem: true,
        QuantityReturned: it.quantity,
        CreditDebitNoteUOM: 'EACH',
        UnitConversion: 1,
        UnitPrice: it.unit_price,
        PriceOverride: true,
        PricingUnit: 'EACH',
        PricingUnitPrice: it.unit_price,
        PricingUnitConversion: 1,
        DetailNumber: detailIdx + 1,
        ReturnType: 'ItemsReturnedToInventory',
        TaxAuthority1: user?.store?.store_tax_group || 'VATZMW',
        TaxClass1: 1,
        TaxIncluded1: true,
        UpdateOperation: 'Unspecified'
      });
      detailIdx++;
    }

    // Calculate total
    const totalFromReturn = Number(returnData.total_amount) || 0;
    const fallbackFromLines = creditDebitDetails.reduce(
      (sum, l) => sum + (Number(l.UnitPrice) * Number(l.QuantityReturned)),
      0
    );
    const creditNoteTotal = this._to2(totalFromReturn || fallbackFromLines);

    // Optional fields
    const creditNoteOptionalFields = {
      CNUniquifier: 0,
      OptionalField: "ISAUTOMATIC",
      Value: "YES",
      YesNoValue: true,
      UpdateOperation: "Unspecified"
    };

    const creditNote = {
      CNUniquifier: 0,
      CreditDebitNoteNumber: '*** NEW ***',
      CustomerNumber: user?.store?.store_customer_number ||
                      returnData.customer?.customer_number ||
                      '1101',
      DefaultPriceListCode: user?.store?.price_list_code || '01',
      CreditDebitNoteType: 'CreditNote',

      // Dates
      CreditDebitNoteDate: creditNoteDate,
      ReturnDate: creditNoteDate,

      // Fiscal period
      CreditDebitNoteFiscalYear: String(new Date(creditNoteDate).getUTCFullYear()),
      CreditDebitNoteFiscalPeriod: `Num${new Date(creditNoteDate).getUTCMonth() + 1}`,

      // Description and reference
      Description: `${user?.store?.store_location || 'POS'} Credit Note - ${creditNoteDate}`,
      Reference: returnData.reference || `RETURN-${Date.now()}`,

      // Location and shipping
      DefaultLocationCode: user?.store?.store_number || '',
      ShipToName: user?.store?.store_location ||
                  returnData.customer?.name ||
                  'POS Customer',

      // Currency settings
      CreditDebitNoteHomeCurrency: user?.store?.currency || 'ZMW',
      CreditDebitNoteRateType: 'SP',
      CreditDebitNoteSourceCurr: user?.store?.currency || 'ZMW',
      CreditDebitNoteRateDate: creditNoteDate,
      CreditDebitNoteRate: 1,
      CreditDebitNoteRateOperator: 1,
      CNDNRateOverrideFlag: false,

      // Tax settings
      TaxGroup: user?.store?.store_tax_group || 'VATZMW',
      TaxAuthority1: user?.store?.store_tax_group || 'VATZMW',
      TaxClass1: 1,
      RecalculateTax: true,

      // Tax reporting currency
      TaxReportingTRCurrency: user?.store?.currency || 'ZMW',
      TRRateType: 'SP',
      TRRateDate: creditNoteDate,
      TRRate: 1,
      TRRateDateMatching: 1,
      TRRateOperator: 1,

      // Totals
      CreditDebitNoteTotal: creditNoteTotal,
      CreditDebitNoteTotBeforeTax: creditNoteTotal,
      CreditDebitNoteItemTotalAmt: creditNoteTotal,
      NoOfLinesInCreditDebitNote: creditDebitDetails.length,

      // Status
      CreditDebitNoteStatus: 'Documentshippednotcosted',

      // Optional fields and details
      CreditDebitNoteOptionalFields: [creditNoteOptionalFields],
      CreditDebitDetails: creditDebitDetails,

      UpdateOperation: 'Unspecified'
    };

    console.log('Credit Note Payload:', JSON.stringify(creditNote, null, 2));

    try {
      const response = await axios.post(
        `${baseURL || 'http://10.40.0.42/Sage300WebApi/v1.0/-/DAPTST'}/OE/OECreditDebitNotes`,
        creditNote,
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': authorization,
          },
          timeout: this.timeout
        }
      );

      return {
        success: true,
        status: response.status,
        data: response.data,
        creditNoteNumber: response.data?.CreditDebitNoteNumber,
        detailsCount: creditDebitDetails.length,
        creditNoteTotal
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        status: error.response?.status,
        details: error.response?.data?.error?.message ||
                 error.response?.data ||
                 null
      };
    }
  }

  /**
   * Create multiple credit notes (batch processing)
   * @param {Array} returnsDataArray - Array of return/refund data
   * @param {Object} user - User/store information
   * @param {string} date - Credit note date
   */
  async createBatchCreditNotes(returnsDataArray, user, date) {
    const results = [];

    for (const returnData of returnsDataArray) {
      const result = await this.createCreditNote(
        returnData,
        user,
        date,
        returnData.orderNumber,
        returnData.invoiceNumber
      );
      results.push(result);
    console.log(result)

    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;
    return {
      success: failureCount === 0,
      totalProcessed: results.length,
      successCount,
      failureCount,
      results
    };
  }
}

module.exports = SageCreditNotesService;