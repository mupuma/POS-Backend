const axios = require('axios');

/**
 * ZRA Integration Service
 * Handles communication with ZRA VSDC system for sales transactions
 */
class ZRAIntegrationService {
    constructor() {
        this.baseURL = 'http://localhost:8080/zrasandboxvsdc';
        this.timeout = 30000; // 30 seconds timeout
    }

    /**
     * Format date to ZRA format (YYYYMMDDHHMMSS)
     * @param {Date} date
     * @returns {string}
     */
    formatZRADateTime(date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');

        return `${year}${month}${day}${hours}${minutes}${seconds}`;
    }

    /**
     * Format date to ZRA date format (YYYYMMDD)
     * @param {Date} date
     * @returns {string}
     */
    formatZRADate(date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');

        return `${year}${month}${day}`;
    }

    /**
     * Calculate VAT amounts based on tax rate
     * @param {number} amount
     * @param {number} taxRate
     * @returns {object}
     */
    calculateVATAmounts(amount, taxRate = 16) {
        const taxAmount = (amount * taxRate) / (100 + taxRate);
        const taxableAmount = amount - taxAmount;

        return {
            taxableAmount: parseFloat(taxableAmount.toFixed(4)),
            taxAmount: parseFloat(taxAmount.toFixed(4))
        };
    }

    /**
     * Generate receipt number for ZRA
     * @returns {string}
     */
    generateCISInvoiceNumber() {
        const timestamp = Date.now();

        return `CIS001-${timestamp}`;
    }

    /**
     * Transform sale data to ZRA sales format
     * @param {object} saleData
     * @param {array} items
     * @param {object} user
     * @returns {object}
     */
    transformToZRASalesData(saleData, items, user) {
        const currentDateTime = this.formatZRADateTime();
        const currentDate = this.formatZRADate();

        // Calculate totals
        let totalTaxableAmountA = 0;
        let totalTaxAmountA = 0;
        let totalAmount = 0;

        const itemList = items.map((item, index) => {
            const { taxableAmount, taxAmount } = this.calculateVATAmounts(
                item.total_price,
                saleData.tax_rate || 16
            );

            totalTaxableAmountA += taxableAmount;
            totalTaxAmountA += taxAmount;
            totalAmount += item.total_price;

            return {
                itemSeq: index + 1,
                itemCd: item.product?.code || `ITEM${item.product_id}`,
                itemClsCd: item.product?.class_code || "50102518",
                itemNm: item.product?.name || "Product",
                bcd: "",
                pkgUnitCd: "BA",
                pkg: 0,
                qtyUnitCd: "BE",
                qty: item.quantity,
                prc: item.unit_price,
                splyAmt: item.total_price,
                dcRt: 0,
                dcAmt: 0,
                isrccCd: "",
                isrccNm: "",
                isrcRt: 0,
                isrcAmt: 0,
                vatCatCd: "A",
                exciseTxCatCd: null,
                tlCatCd: null,
                iplCatCd: null,
                vatTaxblAmt: taxableAmount,
                vatAmt: taxAmount,
                exciseTaxblAmt: 0,
                tlTaxblAmt: 0,
                iplTaxblAmt: 0,
                iplAmt: 0,
                tlAmt: 0,
                exciseTxAmt: 0,
                totAmt: item.total_price
            };
        });

        return {
            tpin: process.env.ZRA_TPIN || "9999999999",
            bhfId: process.env.ZRA_BHF_ID || "000",
            orgInvcNo: 0,
            cisInvcNo: this.generateCISInvoiceNumber(),
            custTpin: saleData.customer?.tpin || "8888888888",
            custNm: saleData.customer?.name || "Walk-in Customer",
            salesTyCd: "N",
            rcptTyCd: "S",
            pmtTyCd: this.mapPaymentMethod(saleData.payment_method),
            salesSttsCd: "02",
            cfmDt: currentDateTime,
            salesDt: currentDate,
            stockRlsDt: null,
            cnclReqDt: null,
            cnclDt: null,
            rfdDt: null,
            rfdRsnCd: null,
            totItemCnt: items.length,
            taxblAmtA: totalTaxableAmountA,
            taxblAmtB: 0,
            taxblAmtC1: 0,
            taxblAmtC2: 0,
            taxblAmtC3: 0,
            taxblAmtD: 0,
            taxblAmtRvat: 0,
            taxblAmtE: 0,
            taxblAmtF: 0,
            taxblAmtIpl1: 0,
            taxblAmtIpl2: 0,
            taxblAmtTl: 0,
            taxblAmtEcm: 0,
            taxblAmtExeeg: 0,
            taxblAmtTot: 0,
            taxRtA: saleData.tax_rate || 16,
            taxRtB: 16,
            taxRtC1: 0,
            taxRtC2: 0,
            taxRtC3: 0,
            taxRtD: 0,
            tlAmt: 0,
            taxRtRvat: 16,
            taxRtE: 0,
            taxRtF: 10,
            taxRtIpl1: 5,
            taxRtIpl2: 0,
            taxRtTl: 1.5,
            taxRtEcm: 5,
            taxRtExeeg: 3,
            taxRtTot: 0,
            taxAmtA: totalTaxAmountA,
            taxAmtB: 0,
            taxAmtC1: 0,
            taxAmtC2: 0,
            taxAmtC3: 0,
            taxAmtD: 0,
            taxAmtRvat: 0,
            taxAmtE: 0,
            taxAmtF: 0,
            taxAmtIpl1: 0,
            taxAmtIpl2: 0,
            taxAmtTl: 0,
            taxAmtEcm: 0,
            taxAmtExeeg: 0,
            taxAmtTot: 0,
            totTaxblAmt: totalTaxableAmountA,
            totTaxAmt: totalTaxAmountA,
            totAmt: saleData.total_amount,
            prchrAcptcYn: "N",
            remark: saleData.notes || "",
            regrId: user.username || "admin",
            regrNm: user.full_name || "admin",
            modrId: user.username || "admin",
            modrNm: user.full_name || "admin",
            saleCtyCd: "1",
            lpoNumber: null,
            currencyTyCd: "ZMW",
            exchangeRt: "1",
            destnCountryCd: "",
            dbtRsnCd: "",
            invcAdjustReason: "",
            itemList
        };
    }

    /**
     * Transform sale data to ZRA stock items format
     * @param {object} saleData
     * @param {array} items
     * @param {object} user
     * @returns {object}
     */
    transformToZRAStockItemsData(saleData, items, user) {
        const currentDate = this.formatZRADate();

        let totalTaxableAmount = 0;
        let totalTaxAmount = 0;
        let totalAmount = 0;

        const itemList = items.map((item, index) => {
            const { taxableAmount, taxAmount } = this.calculateVATAmounts(
                item.total_price,
                saleData.tax_rate || 16
            );

            totalTaxableAmount += taxableAmount;
            totalTaxAmount += taxAmount;
            totalAmount += item.total_price;

            return {
                itemSeq: index + 1,
                itemCd: item.product?.code || `ITEM${item.product_id}`,
                itemClsCd: item.product?.class_code || "50102517",
                itemNm: item.product?.name || "Product",
                bcd: null,
                pkgUnitCd: "BA",
                pkg: 0,
                qtyUnitCd: "BE",
                qty: item.quantity,
                itemExprDt: null,
                prc: item.unit_price,
                splyAmt: item.total_price,
                totDcAmt: 0,
                iplCatCd: null,
                tlCatCd: null,
                exciseCatCd: null,
                taxblAmt: parseFloat(taxableAmount.toFixed(2)),
                vatCatCd: "A",
                taxAmt: parseFloat(taxAmount.toFixed(2)),
                iplAmt: null,
                tlAmt: null,
                exciseTxAmt: null,
                totAmt: item.total_price
            };
        });

        return {
            tpin: process.env.ZRA_TPIN || "1002010901",
            bhfId: process.env.ZRA_BHF_ID || "000",
            sarNo: Math.floor(Math.random() * 1000) + 1, // Generate random SAR number
            orgSarNo: 0,
            regTyCd: "M",
            custTpin: null,
            custNm: null,
            custBhfId: "000",
            sarTyCd: "13",
            ocrnDt: currentDate,
            totItemCnt: items.length,
            totTaxblAmt: parseFloat(totalTaxableAmount.toFixed(4)),
            totTaxAmt: parseFloat(totalTaxAmount.toFixed(4)),
            totAmt: totalAmount,
            remark: null,
            regrId: user.username || "Admin",
            regrNm: user.full_name || "Admin",
            modrNm: user.full_name || "Admin",
            modrId: user.username || "Admin",
            itemList
        };
    }

    /**
     * Transform sale data to ZRA stock master format
     * @param {array} items
     * @param {object} user
     * @returns {object}
     */
    transformToZRAStockMasterData(items, user) {
        const stockItemList = items.map(item => ({
            itemCd: item.product?.code || `ITEM${item.product_id}`,
            rsdQty: (item.product?.stock_quantity || 0) - item.quantity
        }));

        return {
            tpin: process.env.ZRA_TPIN || "1000426601",
            bhfId: process.env.ZRA_BHF_ID || "000",
            regrId: user.username || "Admin",
            regrNm: user.full_name || "Admin",
            modrNm: user.full_name || "Admin",
            modrId: user.username || "Admin",
            stockItemList
        };
    }

    /**
     * Map payment method to ZRA payment type code
     * @param {string} paymentMethod
     * @returns {string}
     */
    mapPaymentMethod(paymentMethod) {
        const paymentMapping = {
            'cash': '01',
            'card': '02',
            'mobile_money': '03',
            'bank_transfer': '04',
            'cheque': '05'
        };

        return paymentMapping[paymentMethod?.toLowerCase()] || '01';
    }

    /**
     * Send sales data to ZRA
     * @param {object} salesData
     * @returns {Promise}
     */
    async sendSalesData(salesData) {
        try {
            const response = await axios.post(
                `${this.baseURL}/trnsSales/saveSales`,
                salesData,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: this.timeout
                }
            );

            return {
                success: true,
                data: response.data,
                endpoint: 'saveSales'
            };
        } catch (error) {
            console.error('ZRA Sales API Error:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data || error.message,
                endpoint: 'saveSales'
            };
        }
    }

    /**
     * Send stock items data to ZRA
     * @param {object} stockItemsData
     * @returns {Promise}
     */
    async sendStockItemsData(stockItemsData) {
        try {
            const response = await axios.post(
                `${this.baseURL}/stock/saveStockItems`,
                stockItemsData,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: this.timeout
                }
            );

            return {
                success: true,
                data: response.data,
                endpoint: 'saveStockItems'
            };
        } catch (error) {
            console.error('ZRA Stock Items API Error:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data || error.message,
                endpoint: 'saveStockItems'
            };
        }
    }

    /**
     * Send stock master data to ZRA
     * @param {object} stockMasterData
     * @returns {Promise}
     */
    async sendStockMasterData(stockMasterData) {
        try {
            const response = await axios.post(
                `${this.baseURL}/stockMaster/saveStockMaster`,
                stockMasterData,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: this.timeout
                }
            );

            return {
                success: true,
                data: response.data,
                endpoint: 'saveStockMaster'
            };
        } catch (error) {
            console.error('ZRA Stock Master API Error:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data || error.message,
                endpoint: 'saveStockMaster'
            };
        }
    }

    /**
     * Process complete ZRA integration for a sale
     * @param {object} saleData
     * @param {array} items
     * @param {object} user
     * @returns {Promise}
     */
    async processZRAIntegration(saleData, items, user) {
        const results = {
            success: false,
            responses: [],
            errors: []
        };

        try {
            // Transform data for each endpoint
            const salesData = this.transformToZRASalesData(saleData, items, user);
            const stockItemsData = this.transformToZRAStockItemsData(saleData, items, user);
            const stockMasterData = this.transformToZRAStockMasterData(items, user);

            // Send requests to all three endpoints
            const [salesResponse, stockItemsResponse, stockMasterResponse] = await Promise.allSettled([
                this.sendSalesData(salesData),
                this.sendStockItemsData(stockItemsData),
                this.sendStockMasterData(stockMasterData)
            ]);

            // Process results
            [salesResponse, stockItemsResponse, stockMasterResponse].forEach((response, index) => {
                const endpointNames = ['saveSales', 'saveStockItems', 'saveStockMaster'];

                if (response.status === 'fulfilled') {
                    results.responses.push({
                        endpoint: endpointNames[index],
                        ...response.value
                    });

                    if (!response.value.success) {
                        results.errors.push({
                            endpoint: endpointNames[index],
                            error: response.value.error
                        });
                    }
                } else {
                    results.errors.push({
                        endpoint: endpointNames[index],
                        error: response.reason.message
                    });
                }
            });

            // Determine overall success
            results.success = results.errors.length === 0;

            return results;

        } catch (error) {
            console.error('ZRA Integration Error:', error);
            results.errors.push({
                endpoint: 'general',
                error: error.message
            });

            return results;
        }
    }
}

module.exports = ZRAIntegrationService;