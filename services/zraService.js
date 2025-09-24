const axios = require('axios');
const QRCode = require('qrcode');

class ZRAService {
    constructor() {
        // Determine environment: sandbox vs production
        this.baseURL = process.env.ZRA_ENVIRONMENT === 'production'
            ? process.env.ZRA_PRODUCTION_BASE_URL
            : process.env.ZRA_BASE_URL;

        this.timeout = parseInt(process.env.ZRA_TIMEOUT) || 30000;
        this.retryAttempts = parseInt(process.env.ZRA_RETRY_ATTEMPTS) || 3;
        this.retryDelay = parseInt(process.env.ZRA_RETRY_DELAY) || 2000;

        this.api = axios.create({
            baseURL: this.baseURL,
            timeout: this.timeout,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Authenticate to ZRA (sandbox or production)
    async authenticate() {
        try {
            const res = await this.api.post(process.env.ZRA_AUTH_ENDPOINT, {
                tpin: process.env.ZRA_TPIN,
                sdcId: process.env.ZRA_SDC_ID
            });
            const token = res.data.token;
            this.api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
            return token;
        } catch (err) {
            console.error('ZRA Authentication failed:', err.response?.data || err.message);
            throw err;
        }
    }

    // Main integration function
    async processZRAIntegration(saleData, saleItems, user) {
        const results = { success: false, responses: [], errors: [] };

        if (process.env.ZRA_ENABLED !== 'true') {
            return { success: true, responses: [{ endpoint: 'all', success: true, message: 'ZRA integration disabled' }] };
        }

        try {
            // Authenticate first
            await this.authenticate();

            const storeConfig = {
                zra_tpin: process.env.ZRA_TPIN,
                zra_bhf_id: process.env.ZRA_BHF_ID
            };

            const salesData = await this.transformToZRASalesData(saleData, saleItems, user, storeConfig);
            const stockItemsData = this.transformToZRAStockItemsData(saleData, saleItems, user, storeConfig);
            const stockMasterData = this.transformToZRAStockMasterData(saleItems, user, storeConfig);

            const endpoints = [
                { name: 'saveSales', url: process.env.ZRA_SALES_ENDPOINT, data: salesData },
                { name: 'saveStockItems', url: process.env.ZRA_STOCK_ITEMS_ENDPOINT, data: stockItemsData },
                { name: 'saveStockMaster', url: process.env.ZRA_STOCK_MASTER_ENDPOINT, data: stockMasterData }
            ];

            for (const endpoint of endpoints) {
                try {
                    const response = await this.callZRAApi(endpoint.url, endpoint.data, endpoint.name);
                    results.responses.push({
                        endpoint: endpoint.name,
                        success: true,
                        data: response.data,
                        status: response.status
                    });
                } catch (error) {
                    const errorResponse = this.handleZRAError(error, endpoint.name);
                    results.responses.push(errorResponse);
                    results.errors.push(errorResponse);
                }
            }

            // Grab saveSales response (critical)
            const saveSalesResp = results.responses.find(r => r.endpoint === 'saveSales' && r.success);
            if (saveSalesResp) {
                const data = saveSalesResp.data || {};
                results.invoiceNo = data.invoiceNo || data.invNumber || null;
                results.receiptNo = data.receiptNo || data.receipt_no || null;
                results.qrCodeUrl = data.qrCodeUrl || data.qrcode_url || null;

                // Generate local QR if not provided
                if (!results.qrCodeUrl && results.invoiceNo) {
                    try {
                        results.qrCodeBase64 = await this.generateSaleQR({
                            store: { tpin: storeConfig.zra_tpin, bhfId: storeConfig.zra_bhf_id },
                            cis_invoice_no: results.invoiceNo,
                            receiptsig: this.generateReceiptSignature(),
                            total_amount: salesData.totAmt,
                            tax_amount: salesData.totTaxAmt,
                            sales_date: salesData.salesDt
                        });
                        results.qrCodeGenerated = true;
                    } catch (qrError) {
                        console.warn('Failed to generate QR code:', qrError.message);
                        results.qrCodeError = qrError.message;
                    }
                }

                results.success = true;
            }

            return results;

        } catch (error) {
            console.error('ZRA Integration error:', error);
            results.errors.push({ endpoint: 'general', success: false, error: error.message });
            return results;
        }
    }

    async callZRAApi(endpoint, data, endpointName) {
        let lastError;
        for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
            try {
                console.log(`Calling ZRA ${endpointName} (Attempt ${attempt}/${this.retryAttempts})`);
                const response = await this.api.post(endpoint, data);
                console.log(`ZRA ${endpointName} successful:`, response.status);
                return response;
            } catch (error) {
                lastError = error;
                console.warn(`ZRA ${endpointName} attempt ${attempt} failed:`, error.message);
                if (attempt < this.retryAttempts) await new Promise(r => setTimeout(r, this.retryDelay));
            }
        }
        throw lastError;
    }

    handleZRAError(error, endpointName) {
        const details = {
            endpoint: endpointName,
            success: false,
            error: error.message,
            status: error.response?.status,
            data: error.response?.data
        };
        if (error.response) {
            if (error.response.status === 404) details.error = `Endpoint not found: ${endpointName}`;
            else if (error.response.status >= 500) details.error = `ZRA server error: ${error.response.status}`;
        } else if (error.code === 'ECONNREFUSED') details.error = 'Cannot connect to ZRA service';
        else if (error.code === 'ETIMEDOUT') details.error = 'ZRA service timeout';
        return details;
    }

    generateReceiptSignature() {
        const timestamp = Date.now().toString(36);
        const randomStr = Math.random().toString(36).substring(2, 10);
        return `SIG${timestamp}${randomStr}`.toUpperCase();
    }

    async generateSaleQR(sale) {
        const qrPayload = {
            tpin: sale.store?.tpin,
            bhfId: sale.store?.bhfId,
            cisInvcNo: sale.cis_invoice_no,
            rcptSign: sale.receiptsig,
            totAmt: sale.total_amount,
            taxAmt: sale.tax_amount,
            salesDt: sale.sales_date
        };
        return await QRCode.toDataURL(JSON.stringify(qrPayload));
    }

    // --- Invoice number generator
    generateCISInvoiceNumber(saleData) {
        const prefix = process.env.INVOICE_PREFIX || 'INV';
        const seq = String(saleData.receipt_sequence || process.env.INVOICE_START_NUMBER || 1).padStart(6, '0');
        const storeCode = process.env.INVOICE_STORE_CODE || 'STORE001';
        return `${prefix}${seq}/${storeCode}`;
    }

    // --- Payment method mapping
    getPaymentMethodCode(method) {
        const codes = { cash: '01', card: '02', mobile_money: '03', bank_transfer: '04', credit: '05' };
        return codes[method] || '01';
    }

    // --- Transform sales, stock items, stock master
    transformToZRASalesData(saleData, saleItems, user, storeConfig) {
        const now = new Date();
        const dateStr = now.toISOString().slice(0,10).replace(/-/g,'');
        const timeStr = now.toTimeString().slice(0,8).replace(/:/g,'');
        const vatRate = parseFloat(process.env.ZRA_VAT_RATE) || 16;

        const totTaxableAmt = saleItems.reduce((sum,i)=>sum + i.unit_price*i.quantity,0);
        const totVAT = parseFloat((totTaxableAmt * (vatRate/100)).toFixed(2));
        const totAmount = parseFloat((totTaxableAmt + totVAT).toFixed(2));

        return {
            tpin: storeConfig.zra_tpin,
            bhfId: storeConfig.zra_bhf_id,
            orgInvcNo: 0,
            cisInvcNo: this.generateCISInvoiceNumber(saleData),
            custTpin: saleData.customer?.tpin || null,
            custNm: saleData.customer?.name || 'Walk-in Customer',
            salesTyCd: "N",
            rcptTyCd: "S",
            pmtTyCd: this.getPaymentMethodCode(saleData.payment_method),
            salesSttsCd: "02",
            cfmDt: `${dateStr}${timeStr}`,
            salesDt: dateStr,
            totItemCnt: saleItems.length,
            taxblAmtA: totTaxableAmt,
            taxAmtA: totVAT,
            totTaxblAmt: totTaxableAmt,
            totTaxAmt: totVAT,
            totAmt: totAmount,
            regrId: user.username,
            regrNm: user.full_name,
            modrId: user.username,
            modrNm: user.full_name,
            saleCtyCd: "1",
            currencyTyCd: "ZMW",
            exchangeRt: "1",
            itemList: saleItems.map((item,i)=>this.transformSaleItem(item,i))
        };
    }

    transformSaleItem(item,index){
        const product = item.product || {};
        const vatRate = parseFloat(process.env.ZRA_VAT_RATE) || 16;
        const taxableAmount = parseFloat((item.unit_price * item.quantity).toFixed(2));
        const vatAmount = parseFloat((taxableAmount * (vatRate / 100)).toFixed(2));
        const totalAmount = parseFloat((taxableAmount + vatAmount).toFixed(2));
        return {
            itemSeq: index+1,
            itemCd: product.product_code || `ITEM${product.id}`,
            itemClsCd: product.product_class_code || process.env.ZRA_DEFAULT_PRODUCT_CLASS || '50102518',
            itemNm: product.name || 'Unknown Product',
            qty: item.quantity,
            prc: item.unit_price,
            vatCatCd: product.vat_category_code || "A",
            vatTaxblAmt: taxableAmount,
            vatAmt: vatAmount,
            totAmt: totalAmount
        };
    }

    transformToZRAStockItemsData(saleData,saleItems,user,storeConfig){
        const dateStr = new Date().toISOString().slice(0,10).replace(/-/g,'');
        const vatRate = parseFloat(process.env.ZRA_VAT_RATE) || 16;
        const totTaxableAmt = saleItems.reduce((sum,i)=>sum + i.unit_price*i.quantity,0);
        const totVAT = parseFloat((totTaxableAmt * (vatRate/100)).toFixed(2));
        const totAmount = parseFloat((totTaxableAmt + totVAT).toFixed(2));
        return {
            tpin: storeConfig.zra_tpin,
            bhfId: storeConfig.zra_bhf_id,
            sarNo: Math.floor(100000 + Math.random()*900000),
            orgSarNo: 0,
            regTyCd: "M",
            custTpin: saleData.customer?.tpin || null,
            custNm: saleData.customer?.name || null,
            sarTyCd: "13",
            ocrnDt: dateStr,
            totItemCnt: saleItems.length,
            totTaxblAmt: totTaxableAmt,
            totTaxAmt: totVAT,
            totAmt: totAmount,
            regrId: user.username,
            regrNm: user.full_name,
            modrId: user.username,
            modrNm: user.full_name,
            itemList: saleItems.map((item,i)=>this.transformStockItem(item,i))
        };
    }

    transformStockItem(item,index){
        const product = item.product || {};
        const vatRate = parseFloat(process.env.ZRA_VAT_RATE) || 16;
        const taxableAmount = parseFloat((item.unit_price * item.quantity).toFixed(2));
        const vatAmount = parseFloat((taxableAmount * (vatRate/100)).toFixed(2));
        const totalAmount = parseFloat((taxableAmount + vatAmount).toFixed(2));
        return {
            itemSeq: index+1,
            itemCd: product.product_code || `ITEM${product.id}`,
            itemClsCd: product.product_class_code || process.env.ZRA_DEFAULT_PRODUCT_CLASS || '50102518',
            itemNm: product.name || 'Unknown Product',
            qty: item.quantity,
            prc: item.unit_price,
            taxblAmt: taxableAmount,
            vatCatCd: product.vat_category_code || "A",
            taxAmt: vatAmount,
            totAmt: totalAmount
        };
    }

    transformToZRAStockMasterData(saleItems,user,storeConfig){
        return {
            tpin: storeConfig.zra_tpin,
            bhfId: storeConfig.zra_bhf_id,
            regrId: user.username,
            regrNm: user.full_name,
            modrId: user.username,
            modrNm: user.full_name,
            stockItemList: saleItems.map(item=>{
                const product = item.product || {};
                return {
                    itemCd: product.product_code || `ITEM${product.id}`,
                    itemClsCd: product.product_class_code || process.env.ZRA_DEFAULT_PRODUCT_CLASS || '50102518',
                    rsdQty: Math.max(0,(product.stock_quantity || 0) - item.quantity)
                };
            })
        };
    }
}

module.exports = ZRAService;