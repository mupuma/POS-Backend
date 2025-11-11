const axios = require('axios');

/**
 * Sage OE Orders Service
 * Creates Sage OE Orders (one per sale) instead of AR Batches/Shipments
 */
class SageOrdersService {
  constructor() {
    this.timeout = 60000; // 60s default
  }

  _to2(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return 0;
    return Number(x.toFixed(2));
  }

  _normalizeItem(item) {
    const quantity = Number(item.quantity ?? 0);
    const unit_price = Number(item.unit_price ?? 0);
    const code = item.product?.formatted_product_code || item.formatted_product_code || item.product?.product_code || item.product_code || (item.product_id ? String(item.product_id) : '');
    const description = item.product?.name || item.name || 'Item';
    return { quantity, unit_price: this._to2(unit_price), code, description };
  }

  _buildOrderFromSale(saleData, user, date) {
    const utcDate = new Date().toISOString();
    const orderDate = date ? new Date(date).toISOString() : utcDate;

    const items = (saleData.items || []).map((raw, idx) => {
      const it = this._normalizeItem(raw);
      return {
        LineNumber: (idx + 1) * 32,
        LineType: 'Item',
        Item: it.code,
        Description: it.description,
        Category: user?.store?.store_number || '',
        Location: user?.store?.store_number || '',
        StockItem: true,
        QuantityOrdered: it.quantity,
        OrderUnitOfMeasure: 'EACH',
        OrderUnitConversion: 1,
        OrderUnitPrice: it.unit_price,
        PriceOverride: true,
        PricingUnitOfMeasure: 'EACH',
        PricingUnitPrice: it.unit_price,
        PricingUnitConversion: 1,
        DetailNumber: idx + 1,
        TaxAuthority1:  'VATZMW',
        TaxClass1: 1,
        TaxIncluded1: true,
        UpdateOperation: 'Unspecified'
      };
    });

    const totalIncl = this._to2((saleData.salesData?.total_amount) ?? items.reduce((s, l) => s + (l.OrderUnitPrice * l.QuantityOrdered), 0));

    const order = {
      OrderUniquifier: 0,
      OrderNumber: '*** NEW ***',
      CustomerNumber: user?.store?.store_customer_number || saleData.salesData?.customer?.customer_number || '1101',
      CustomerGroupCode: user?.store?.currency || 'ZMW',
      ShipToName: saleData.salesData?.customer?.name || user?.store?.store_location || 'POS Customer',
      ShipToAddressLine1: '',
      ShipToCity: '',
      CustomerDiscountLevel: 'Base',
      DefaultPriceListCode: user?.store?.price_list_code || '01',
      TermsCode: user?.store?.terms_code || 'COD',
      OrderType: 'Active',
      OrderDate: orderDate,
      ExpectedShipDate: orderDate,
      OrderFiscalYear: String(new Date(orderDate).getUTCFullYear()),
      OrderFiscalPeriod: `Num${new Date(orderDate).getUTCMonth() + 1}`,
      DefaultLocationCode: user?.store?.store_number || '',
      OnHold: false,
      OrderHomeCurrency: user?.store?.currency || 'ZMW',
      OrderRateType: 'SP',
      OrderSourceCurrency: user?.store?.currency || 'ZMW',
      OrderRateDate: orderDate,
      OrderRate: 1,
      OrderRateDateMatching: 3,
      OrderRateOperator: 1,
      OrderRateOverrideFlag: false,
      TaxGroup: user?.store?.store_tax_group || 'VATZMW',
      TaxAuthority1: user?.store?.store_tax_group || 'VATZMW',
      TaxClass1: 1,
      OrderCompleted: 'IncompleteNotIncluded',
      PostInvoice: false,
      TaxReportingTRCurrency: user?.store?.currency || 'ZMW',
      TRRateType: 'SP',
      TRRateDate: orderDate,
      TRRate: 1,
      TRRateDateMatching: 1,
      TRRateOperator: 1,
      OrderDetails: items,
      OrderTotal: totalIncl,
      OrderInclTaxTotal: totalIncl,
      NumberOfLinesOnOrder: items.length,
      UpdateOperation: 'Unspecified'
    };

    return order;
  }

  async createOrdersForSales(salesDataArray, user, date) {
    const username = process.env.SAGE_USERNAME || 'ADMIN';
    const password = process.env.SAGE_PASSWORD || 'Admin123!';
    const baseURL = process.env.SAGE_BASE_URL;

    const auth = `${username}:${password}`;
    const encodedAuth = Buffer.from(auth, 'utf-8').toString('base64');
    const authorization = `Basic ${encodedAuth}`;

    const results = [];
    let successCount = 0;

    for (const saleData of salesDataArray) {
      const order = this._buildOrderFromSale(saleData, user, date);

      try {
        const response = await axios.post(
          `${baseURL}/OE/OEOrders`,
          order,
          {
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'Authorization': authorization,
            },
            timeout: this.timeout
          }
        );
        results.push({ success: true, status: response.status, data: response.data, receiptNumber: saleData.receiptNumber || null });
        successCount++;
      } catch (error) {
        results.push({ success: false, error: error.message, status: error.response?.status, detail: error.response?.data?.error?.message || null, receiptNumber: saleData.receiptNumber || null });
      }
    }

    return {
      success: successCount === salesDataArray.length,
      ordersAttempted: salesDataArray.length,
      ordersSucceeded: successCount,
      results
    };
  }

  async createConsolidatedOrder(salesDataArray, user, date) {
    const username = process.env.SAGE_USERNAME || 'ADMIN';
    const password = process.env.SAGE_PASSWORD || 'Admin123!';
    const baseURL = process.env.SAGE_BASE_URL;

    const auth = `${username}:${password}`;
    const encodedAuth = Buffer.from(auth, 'utf-8').toString('base64');
    const authorization = `Basic ${encodedAuth}`;

    const utcDate = new Date().toISOString();
    const orderDate = date ? new Date(date).toISOString() : utcDate;

    // Flatten all items across sales into a single order details list
    let detailIdx = 0;
    const orderDetails = [];
    for (const saleData of salesDataArray) {
      for (const raw of (saleData.items || [])) {
        const it = this._normalizeItem(raw);
        orderDetails.push({
          LineNumber: (detailIdx + 1) * 32,
          LineType: 'Item',
          Item: it.code,
          Description: it.description,
          Location: user?.store?.store_number || '',
          StockItem: true,
          QuantityOrdered: it.quantity,
          OrderUnitOfMeasure: 'EACH',
          OrderUnitConversion: 1,
          OrderUnitPrice: it.unit_price,
          PriceOverride: true,
          PricingUnitOfMeasure: 'EACH',
          PricingUnitPrice: it.unit_price,
          PricingUnitConversion: 1,
          DetailNumber: detailIdx + 1,
          TaxAuthority1: user?.store?.store_tax_group || 'VATZMW',
          TaxClass1: 1,
          TaxIncluded1: true,
          UpdateOperation: 'Unspecified'
        });
        detailIdx++;
      }
    }

    const totalFromSales = salesDataArray.reduce((sum, s) => sum + (Number(s.salesData?.total_amount) || 0), 0);
    const fallbackFromLines = orderDetails.reduce((sum, l) => sum + (Number(l.OrderUnitPrice) * Number(l.QuantityOrdered)), 0);
    const orderTotal = this._to2(totalFromSales || fallbackFromLines);

    const order = {
      OrderUniquifier: 0,
      OrderNumber: '*** NEW ***',
      CustomerNumber: user?.store?.store_customer_number || salesDataArray[0]?.salesData?.customer?.customer_number || '1101',
      CustomerGroupCode: user?.store?.currency || 'ZMW',
      ShipToName: user?.store?.store_location || salesDataArray[0]?.salesData?.customer?.name || 'POS Customer',
      ShipToAddressLine1: '',
      ShipToCity: '',
      CustomerDiscountLevel: 'Base',
      DefaultPriceListCode: user?.store?.price_list_code || '01',
      TermsCode: user?.store?.terms_code || 'COD',
      OrderType: 'Active',
      OrderDate: orderDate,
      ExpectedShipDate: orderDate,
      OrderFiscalYear: String(new Date(orderDate).getUTCFullYear()),
      OrderFiscalPeriod: `Num${new Date(orderDate).getUTCMonth() + 1}`,
      DefaultLocationCode: user?.store?.store_number || '',
      OnHold: false,
      OrderHomeCurrency: user?.store?.currency || 'ZMW',
      OrderRateType: 'SP',
      OrderSourceCurrency: user?.store?.currency || 'ZMW',
      OrderRateDate: orderDate,
      OrderRate: 1,
      OrderRateDateMatching: 3,
      OrderRateOperator: 1,
      OrderRateOverrideFlag: false,
      TaxGroup: user?.store?.store_tax_group || 'VATZMW',
      TaxAuthority1: user?.store?.store_tax_group || 'VATZMW',
      TaxClass1: 1,
      OrderCompleted: 'IncompleteNotIncluded',
      PostInvoice: false,
      TaxReportingTRCurrency: user?.store?.currency || 'ZMW',
      TRRateType: 'SP',
      TRRateDate: orderDate,
      TRRate: 1,
      TRRateDateMatching: 1,
      TRRateOperator: 1,
      OrderDetails: orderDetails,
      OrderTotal: orderTotal,
      OrderInclTaxTotal: orderTotal,
      NumberOfLinesOnOrder: orderDetails.length,
      UpdateOperation: 'Unspecified'
    };

    console.log(order)
    try {
      const response = await axios.post(
        `${baseURL}/OE/OEOrders`,
        order,
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
        orderDetailsCount: orderDetails.length,
        salesProcessed: salesDataArray.length,
        orderTotal
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        status: error.response?.status,
        details: error.response?.data?.error?.message || error.response?.data || null
      };
    }
  }
}

module.exports = SageOrdersService;
