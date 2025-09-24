const axios = require('axios');
const ZRAIntegrationService = require('./generateSmartInvoice');

/**
 * Accounts Receivable Batch Service - Consolidated Daily Batches
 * Creates one AR batch per day containing all invoices for that day
 */
class AccountsReceivableBatch {
    constructor() {
        this.baseURL = 'http://localhost/Sage300WebApi/v1.0/-/INFDAT/AR/ARInvoiceBatches';
        this.timeout = 30000; // 30 seconds
    }

    // Helper method to normalize an item based on sales.js structure
    _normalizeItem(item) {
        const quantity = item.quantity ?? 0;
        const unit_price = item.unit_price ?? 0;
        const total_price = item.total_price ?? quantity * unit_price; // tax-exclusive total as in sales.js
        const name = item.product?.name || item.name || 'Product';
        const code = item.product?.product_code || item.product_code || (item.product_id ? String(item.product_id) : '');
        return { quantity, unit_price, total_price, name, code, product: item.product || null };
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
                const { taxableAmount, taxAmount, taxInclusiveAmount } = zra.calculateVATAmounts(it.total_price, taxRate);
                return {
                    index,
                    quantity: it.quantity,
                    unit_price: it.unit_price,
                    taxExclusiveTotal: taxableAmount,
                    taxAmount,
                    taxInclusiveTotal: taxInclusiveAmount,
                    name: it.name,
                    code: it.code,
                };
            });

            const saleBeforeTax = lines.reduce((sum, l) => sum + l.taxExclusiveTotal, 0);
            const saleTax = lines.reduce((sum, l) => sum + l.taxAmount, 0);
            const saleIncludingTax = saleBeforeTax + saleTax;

            const invoicePaymentSchedules = [{
                BatchNumber: 0,
                EntryNumber: entryNumber,
                PaymentNumber: 1,
                DueDate: utcDate,
                AmountDue: saleIncludingTax,
                FunctionalAmountDue: saleIncludingTax,
                UpdateOperation: "Unspecified"
            }];

            const invoiceDetails = lines.map((line, idx) => ({
                BatchNumber: 0,
                EntryNumber: entryNumber,
                LineNumber: (idx + 1) * 20,
                ItemNumber: line.code,
                Description: line.name,
                Quantity: line.quantity,
                Price: line.unit_price,
                ExtendedAmountWithoutTIP: line.taxExclusiveTotal,
                ExtendedAmountWithTIP: line.taxInclusiveTotal,
                RevenueAccount: '51230',
                UpdateOperation: "Unspecified",
                TaxTotal: line.taxAmount,
                TaxBase1: line.taxExclusiveTotal,
                TaxAmount1: line.taxAmount,
                FunctionalTaxBase1: line.taxExclusiveTotal,
                FunctionalTaxAmount1: line.taxAmount,
                TaxAmount1Total: line.taxAmount
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
                TransactionType: "InvoiceItemIssued",
                InvoiceDescription: sale?.notes || `Receipt: ${sale?.receipt_number || entryNumber}`,
                InvoicePrinted: "No",
                CurrencyCode: sale?.currency || "ZMW",
                Terms: "COD",
                Taxable: taxRate > 0 ? "Yes" : "No",
                TaxGroup: "OUTZMW",
                InvoiceType: "Item",
                AmountDue: saleIncludingTax,
                TaxBase1: saleBeforeTax,
                FunctionalTaxBase1: saleBeforeTax,
                TaxAmount1: saleTax,
                TaxAmount1Total: saleTax,
                FunctionalTaxAmount1: saleTax,
                DocumentTotalBeforeTax: saleBeforeTax,
                DocumentTotalIncludingTax: saleIncludingTax,
                ProcessCommand: "CalculateTaxes",
                InvoiceDetails: invoiceDetails,
                InvoicePaymentSchedules: invoicePaymentSchedules,
                UpdateOperation: "Unspecified"
            };

            allInvoices.push(invoice);
            entryNumber++;
        }

        // Calculate batch totals
        const batchTotalBeforeTax = allInvoices.reduce((sum, inv) => sum + inv.DocumentTotalBeforeTax, 0);
        const batchTotalTax = allInvoices.reduce((sum, inv) => sum + inv.TaxAmount1Total, 0);
        const batchTotalIncludingTax = batchTotalBeforeTax + batchTotalTax;

        const consolidatedBatch = {
            BatchNumber: 0,
            BatchDate: utcDate,
            DateLastEdited: utcDate,
            Description: description,
            BatchType: "Entered",
            BatchStatus: "Open",
            BatchTotal: batchTotalIncludingTax,
            DefaultInvoiceType: "Item",
            ProcessCommand: "UnlockBatchResource",
            Invoices: allInvoices
        };

        console.log(`Creating consolidated AR batch for ${salesDataArray.length} sales with total: ${batchTotalIncludingTax}`);

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

            console.log(`Consolidated AR Batch created successfully. Status: ${response.status}`);
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
                response: error.response?.data,
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

    // Keep the update method as is (might be needed for individual updates)
    async updateSageArBatch(batchNumber, entryNo, salesData, items, batchTotal) {
        const updateURL = `${this.baseURL}/${batchNumber}`;

        const utcDate = new Date().toISOString();
        const zra = new ZRAIntegrationService();
        const taxRate = salesData?.tax_rate ?? 16;

        const lines = (items || []).map((raw, index) => {
            const it = this._normalizeItem(raw);
            const { taxableAmount, taxAmount, taxInclusiveAmount } = zra.calculateVATAmounts(it.total_price, taxRate);
            return {
                index,
                quantity: it.quantity,
                unit_price: it.unit_price,
                taxExclusiveTotal: taxableAmount,
                taxAmount,
                taxInclusiveTotal: taxInclusiveAmount,
                name: it.name,
                code: it.code,
            };
        });

        const totalBeforeTax = lines.reduce((sum, l) => sum + l.taxExclusiveTotal, 0);
        const totalTax = lines.reduce((sum, l) => sum + l.taxAmount, 0);
        const totalIncludingTax = totalBeforeTax + totalTax;
        const taxableAmount = totalBeforeTax;

        const invoicePaymentSchedules = [{
            BatchNumber: batchNumber,
            EntryNumber: entryNo,
            PaymentNumber: 1,
            DueDate: utcDate,
            AmountDue: totalIncludingTax,
            FunctionalAmountDue: totalIncludingTax,
            UpdateOperation: "Unspecified"
        }];

        const invoiceDetails = lines.map((line, idx) => ({
            BatchNumber: batchNumber,
            EntryNumber: entryNo,
            LineNumber: (idx + 1) * 20,
            ItemNumber: line.code,
            Description: line.name,
            Quantity: line.quantity,
            Price: line.unit_price,
            ExtendedAmountWithoutTIP: line.taxExclusiveTotal,
            ExtendedAmountWithTIP: line.taxInclusiveTotal,
            RevenueAccount: '',
            UpdateOperation: "Unspecified",
            TaxTotal: line.taxAmount,
            TaxBase1: line.taxExclusiveTotal,
            TaxAmount1: line.taxAmount,
            FunctionalTaxBase1: line.taxExclusiveTotal,
            FunctionalTaxAmount1: line.taxAmount,
            TaxAmount1Total: line.taxAmount
        }));

        const invoices = {
            BatchNumber: batchNumber,
            EntryNumber: entryNo,
            CustomerNumber: "WALK-IN",
            DateGenerated: utcDate,
            PostingDate: utcDate,
            DueDate: utcDate,
            AsOfDate: utcDate,
            DocumentDate: utcDate,
            DocumentType: "Invoice",
            TransactionType: "InvoiceSummaryIssued",
            InvoiceDescription: salesData.notes,
            InvoicePrinted: "No",
            CurrencyCode: salesData?.currency || "ZMW",
            Terms: "COD",
            Taxable: taxRate > 0 ? "Yes" : "No",
            TaxGroup: "OUTZMW",
            InvoiceType: "Summary",
            AmountDue: totalIncludingTax,
            TaxBase1: taxableAmount,
            FunctionalTaxBase1: taxableAmount,
            TaxAmount1: totalTax,
            TaxAmount1Total: totalTax,
            FunctionalTaxAmount1: totalTax,
            DocumentTotalBeforeTax: totalBeforeTax,
            DocumentTotalIncludingTax: totalIncludingTax,
            ProcessCommand: "CalculateTaxes",
            InvoiceDetails: invoiceDetails,
            InvoicePaymentSchedules: invoicePaymentSchedules,
            UpdateOperation: "Unspecified"
        };

        const sageBatch = {
            BatchNumber: 0,
            BatchDate: utcDate,
            DateLastEdited: utcDate,
            BatchType: "Entered",
            BatchStatus: "Open",
            BatchTotal: batchTotal + totalIncludingTax,
            DefaultInvoiceType: "Summary",
            ProcessCommand: "UnlockBatchResource",
            Invoices: invoices
        };

        try {
            const username = process.env.SAGE_USERNAME || "ADMIN";
            const password = process.env.SAGE_PASSWORD || "Admin123!";

            const auth = `${username}:${password}`;
            const encodedAuth = Buffer.from(auth, "utf-8").toString("base64");
            const authorization = `Basic ${encodedAuth}`;

            const response = await axios.patch(
                updateURL,
                sageBatch,
                {
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "Authorization": authorization,
                    },
                    timeout: this.timeout
                }
            );

            console.log(`AR Batch updated successfully. Status: ${response.status}`);
            return {
                success: true,
                status: response.status,
                data: response.data,
                batchNumber: batchNumber,
                entryNumber: entryNo
            };
        } catch (error) {
            console.error('Error updating AR Invoice Batch:', {
                message: error.message,
                response: error.response?.data,
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
}

module.exports = AccountsReceivableBatch;