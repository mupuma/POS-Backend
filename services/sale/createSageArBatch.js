const axios = require('axios');
const ZRAIntegrationService = require('./generateSmartInvoice');

/**
 * Accounts Receivable Batch Service - Consolidated Daily Batches
 * Creates one AR batch per day containing all invoices for that day
 */
class AccountsReceivableBatch {
    constructor() {
        this.baseURL = 'http://localhost/Sage300WebApi/v1.0/-/INDCOM/AR/ARInvoiceBatches';
        this.timeout = 30000; // 30 seconds
    }

    // Round a value to 2 decimal places and return a number
    _to2(n) {
        const x = Number(n);
        if (!Number.isFinite(x)) return 0;
        return Number(x.toFixed(2));
    }

    // Helper method to normalize an item based on sales.js structure
    _normalizeItem(item) {
        const quantity = item.quantity ?? 0;
        const unit_price = item.unit_price ?? 0;
        const total_price = item.total_price ?? quantity * unit_price; // tax-exclusive total as in sales.js
        const name = item.product?.name || item.name || 'Product';
        const code = item.product?.product_code || item.product_code || (item.product_id ? String(item.product_id) : '');
        return { quantity, unit_price: this._to2(unit_price), total_price: this._to2(total_price), name, code, product: item.product || null };
    }

    /**
     * Creates a consolidated AR batch for multiple sales
     * @param {Array} salesDataArray - Array of sale objects with their items
     * @param {Object} user - User/store information for the batch
     * @param {string} date - Date for the batch (YYYY-MM-DD format)
     */
    async createConsolidatedArBatch(salesDataArray, user, date) {
        const utcDate = new Date().toISOString();
        const batchDate = date || utcDate.slice(0, 10);
        const description = `${user?.store?.store_location || 'STORE'} - ${batchDate} Daily Sales`;

        // Prepare tax calculator
        const zra = new ZRAIntegrationService();
        const taxRate = 16; // Default tax rate, can be made configurable

        const allInvoices = [];
        let entryNumber = 1;

        // Process each sale
        for (const saleData of salesDataArray) {
            const { items = [], salesData: sale } = saleData;

            // Calculate per-line taxes for this sale
            const lines = (items || []).map((raw, index) => {
                const it = this._normalizeItem(raw);
                // Determine tax-exclusive from provided totals (items may carry tax_exclusive_total now)
                const taxExclusiveTotalBase = (raw.tax_exclusive_total != null)
                    ? Number(raw.tax_exclusive_total)
                    : (Number(it.total_price) / (1 + (taxRate / 100)));
                const { taxableAmount, taxAmount, taxInclusiveAmount } = zra.calculateVATAmounts(taxExclusiveTotalBase, taxRate);
                return {
                    index,
                    quantity: it.quantity,
                    unit_price: this._to2(it.unit_price), // unit price is tax-inclusive for display; Sage line totals use fields below
                    taxExclusiveTotal: this._to2(taxableAmount),
                    taxAmount: this._to2(taxAmount),
                    taxInclusiveTotal: this._to2(taxInclusiveAmount),
                    name: it.name,
                    code: it.code,
                };
            });

            const saleBeforeTax = this._to2(lines.reduce((sum, l) => sum + l.taxExclusiveTotal, 0));
            const saleTax = this._to2(lines.reduce((sum, l) => sum + l.taxAmount, 0));
            const saleIncludingTax = this._to2(saleBeforeTax + saleTax);

            const invoicePaymentSchedules = [{
                BatchNumber: 0,
                EntryNumber: entryNumber,
                PaymentNumber: 1,
                DueDate: utcDate,
                AmountDue: this._to2(saleIncludingTax),
                FunctionalAmountDue: this._to2(saleIncludingTax),
                UpdateOperation: "Unspecified"
            }];

            const invoiceDetails = lines.map((line, idx) => ({
                BatchNumber: 0,
                EntryNumber: entryNumber,
                LineNumber: (idx + 1) * 20,

                Description: line.name,
                Quantity: line.quantity,
                Price: this._to2(line.unit_price),
                ExtendedAmountWithoutTIP: this._to2(line.taxExclusiveTotal),
                ExtendedAmountWithTIP: this._to2(line.taxInclusiveTotal),
                RevenueAccount: user?.store?.store_rev_account,
                UpdateOperation: "Unspecified",
                TaxTotal: this._to2(line.taxAmount),
                TaxBase1: this._to2(line.taxExclusiveTotal),
                TaxAmount1: this._to2(line.taxAmount),
                TaxIncluded1:"Yes",
                FunctionalTaxBase1: this._to2(line.taxExclusiveTotal),
                FunctionalTaxAmount1: this._to2(line.taxAmount),
                TaxAmount1Total: this._to2(line.taxAmount)

            }));

           const invoice = {
                BatchNumber: 0,
                EntryNumber: entryNumber,
                CustomerNumber: "WALK-IN",
                DateGenerated: utcDate,
                PostingDate: utcDate,
                DueDate: utcDate,
                AsOfDate: utcDate,
                DocumentDate: utcDate,
                DocumentType: "Invoice",
                TransactionType: "InvoiceSummaryIssued",
                InvoiceDescription: sale?.notes || `Receipt: ${sale?.receipt_number || entryNumber}`,
                InvoicePrinted: "No",
                CurrencyCode: sale?.currency || "ZMW",
                Terms: "COD",
                Taxable: taxRate > 0 ? "Yes" : "No",
                TaxGroup: "VATZMW",
                InvoiceType: "Summary",
                AmountDue: this._to2(saleIncludingTax),
                TaxBase1: this._to2(saleBeforeTax),
                FunctionalTaxBase1: this._to2(saleBeforeTax),
                TaxAmount1: this._to2(saleTax),
                TaxAmount1Total: this._to2(saleTax),
                FunctionalTaxAmount1: this._to2(saleTax),
                DocumentTotalBeforeTax: this._to2(saleBeforeTax),
                DocumentTotalIncludingTax: this._to2(saleIncludingTax),
                ProcessCommand: "CalculateTaxes",
                InvoiceDetails: invoiceDetails,
                InvoicePaymentSchedules: invoicePaymentSchedules,
                UpdateOperation: "Unspecified"
            }

            allInvoices.push(invoice);
            entryNumber++;
        }

        // Calculate batch totals
         const batchTotalBeforeTax = this._to2(allInvoices.reduce((sum, inv) => sum + this._to2(inv.DocumentTotalBeforeTax), 0));
        const batchTotalTax = this._to2(allInvoices.reduce((sum, inv) => sum + this._to2(inv.TaxAmount1Total), 0));
        const batchTotalIncludingTax = this._to2(allInvoices.reduce((sum, inv) => sum + this._to2(inv.DocumentTotalIncludingTax || 0), 0));

        const consolidatedBatch = {
            BatchNumber: 0,
            BatchDate: utcDate,
            DateLastEdited: utcDate,
            Description: description,
            BatchType: "Entered",
            BatchStatus: "Open",
            BatchTotal: this._to2(batchTotalIncludingTax),
            DefaultInvoiceType: "Item",
            ProcessCommand: "UnlockBatchResource",
            Invoices: allInvoices
        };

        console.log(`Creating consolidated AR batch for ${salesDataArray.length} sales with total: ${batchTotalIncludingTax}`);
        console.log(JSON.stringify(consolidatedBatch, null, 2));
        try {
            const username = process.env.SAGE_USERNAME || "ADMIN";
            const password = process.env.SAGE_PASSWORD || "Admin123!";

            // Encode auth as Base64
            const auth = `${username}:${password}`;
            const encodedAuth = Buffer.from(auth, "utf-8").toString("base64");
            const authorization = `Basic ${encodedAuth}`;

            const response = await axios.post(
                this.baseURL,
                consolidatedBatch,
                {
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "Authorization": authorization,
                    },
                    timeout: this.timeout
                }
            );
            console.log('Response data:', response);
            //console.log(`Consolidated AR Batch created successfully. Status: ${response.status}`);
            return {
                success: true,
                status: response.status,
                data: response.data,
                batchNumber: response.data?.BatchNumber ?? 0,
                invoicesProcessed: allInvoices.length,
                batchTotal: batchTotalIncludingTax
            };
        } catch (error) {
            console.error('Error creating consolidated AR Invoice Batch:', {
                message: error.message,
                response: error.response?.data.error.message,
                status: error.response?.status
            });

            return {
                success: false,
                error: error.message,
                status: error.response?.status,
                details: error.response?.data
            };
        }
    }

    // Keep the original method for backward compatibility
    async createSageArBatch(salesData, items, user) {
        const salesArray = [{
            items: items,
            salesData: salesData
        }];

        return this.createConsolidatedArBatch(salesArray, user);
    }

}

module.exports = AccountsReceivableBatch;