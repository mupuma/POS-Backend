const axios = require('axios');
const ZRAIntegrationService = require('./generateSmartInvoice');

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

    async createSageArBatch(salesData, items, user) {
        const utcDate = new Date().toISOString();
        const dateOnly = utcDate.slice(0, 10);
        const entryNo = 1;

        // Prepare tax calculator (reuse logic from generateSmartInvoice.js)
        const zra = new ZRAIntegrationService();
        const taxRate = salesData?.tax_rate ?? 16;

        // Calculate per-line taxes consistent with sales.js and generateSmartInvoice.js
        const lines = (items || []).map((raw, index) => {
            const it = this._normalizeItem(raw);
            const { taxableAmount, taxAmount, taxInclusiveAmount } = zra.calculateVATAmounts(it.total_price, taxRate);
            return {
                index,
                quantity: it.quantity,
                unit_price: it.unit_price,
                taxExclusiveTotal: taxableAmount, // same as it.total_price
                taxAmount,
                taxInclusiveTotal: taxInclusiveAmount,
                name: it.name,
                code: it.code,
            };
        });

        const totalBeforeTax = lines.reduce((sum, l) => sum + l.taxExclusiveTotal, 0);
        const totalTax = lines.reduce((sum, l) => sum + l.taxAmount, 0);
        const totalIncludingTax = totalBeforeTax + totalTax;
        const taxableAmount = totalBeforeTax; // same by definition in our model

        const description = `${user?.store?.store_location || 'STORE'} - ${dateOnly} Sales Transactions`;



        const invoicePaymentSchedules = [{
            BatchNumber: 0,
            EntryNumber: entryNo,
            PaymentNumber: 1,
            DueDate: utcDate,
            AmountDue: totalIncludingTax,
            FunctionalAmountDue: totalIncludingTax,
            UpdateOperation: "Unspecified"
        }];

        const invoiceDetails = lines.map((line, idx) => ({
            BatchNumber: 0,
            EntryNumber: 1,
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

        const invoices = [{
            BatchNumber: 0,
            EntryNumber: 1,
            CustomerNumber: "WALK-IN",
            DateGenerated: utcDate,
            PostingDate: utcDate,
            DueDate: utcDate,
            AsOfDate: utcDate,
            DocumentDate: utcDate,
            DocumentType: "Invoice",
            TransactionType: "InvoiceItemIssued",
            InvoiceDescription: salesData.notes,
            InvoicePrinted: "No",
            CurrencyCode: salesData?.currency || "ZMW",
            Terms:  "COD",
            Taxable: taxRate > 0 ? "Yes" : "No",
            TaxGroup: "OUTZMW",
            InvoiceType: "Item",
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
        }];
        const sageBatch = {
              BatchNumber: 0,
              BatchDate: utcDate,
              DateLastEdited: utcDate,
              Description: description,
              BatchType: "Entered",
              BatchStatus: "Open",
              BatchTotal: totalIncludingTax, // Add the calculated batchTotal here
              DefaultInvoiceType: "Item",
              ProcessCommand: "UnlockBatchResource",
              Invoices: invoices
            };
        console.log('Prepared Sage AR Batch:', JSON.stringify(sageBatch, null, 2));
        try {
            const username = process.env.SAGE_USERNAME || "ADMIN";
            const password = process.env.SAGE_PASSWORD || "Admin123!";

            // Encode auth as Base64
            const auth = `${username}:${password}`;
            const encodedAuth = Buffer.from(auth, "utf-8").toString("base64");
            const authorization = `Basic ${encodedAuth}`;
            const response = await axios.post(
                this.baseURL,
                sageBatch,
                {
                     headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "Authorization": authorization,
                      },

                }
            );

            console.log(`AR Batch created successfully. Status: ${response.status}`);
            return {
                success: true,
                status: response.status,
                data: response.data,
                batchNumber: response.data?.BatchNumber ?? 0,
                entryNumber: entryNo
            };
        } catch (error) {
            console.error('Error creating AR Invoice Batch:', {
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

    async updateSageArBatch(batchNumber, entryNo, salesData, items, batchTotal) {
        // For updates, we typically use PUT method and include the existing batch data
        const updateURL = `${this.baseURL}/${batchNumber}`;
        
        const utcDate = new Date().toISOString();
        
       const dateOnly = utcDate.slice(0, 10);

        // Prepare tax calculator (reuse logic from generateSmartInvoice.js)
        const zra = new ZRAIntegrationService();
        const taxRate = salesData?.tax_rate ?? 16;

        // Calculate per-line taxes consistent with sales.js and generateSmartInvoice.js
        const lines = (items || []).map((raw, index) => {
            const it = this._normalizeItem(raw);
            const { taxableAmount, taxAmount, taxInclusiveAmount } = zra.calculateVATAmounts(it.total_price, taxRate);
            return {
                index,
                quantity: it.quantity,
                unit_price: it.unit_price,
                taxExclusiveTotal: taxableAmount, // same as it.total_price
                taxAmount,
                taxInclusiveTotal: taxInclusiveAmount,
                name: it.name,
                code: it.code,
            };
        });

        const totalBeforeTax = lines.reduce((sum, l) => sum + l.taxExclusiveTotal, 0);
        const totalTax = lines.reduce((sum, l) => sum + l.taxAmount, 0);
        const totalIncludingTax = totalBeforeTax + totalTax;
        const taxableAmount = totalBeforeTax; // same by definition in our model

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
            Terms:  "COD",
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
                      BatchTotal: batchTotal + totalIncludingTax, // Add the calculated batchTotal here
                      DefaultInvoiceType: "Summary",
                      ProcessCommand: "UnlockBatchResource",
                      Invoices: invoices
                    };
        try {
            const response = await axios.patch( // Changed to PUT for update
                updateURL,
                sageBatch,
                {
                    headers: { 'Content-Type': 'application/json' },
                    auth: {
                        username: 'ADMIN',
                        password: 'Admin123!'
                    },
                  
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