const { store, productinventory } = require('../../models');
const axios = require('axios');

/**
 * ZRA Integration Service
 * Handles communication with ZRA VSDC system for sales transactions
 */
class ZRAIntegrationService {
    constructor() {
        this.baseURL = process.env.ZRA_BASE_URL;
        // 30 seconds timeout
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
     * Calculate VAT amounts for tax-exclusive amounts
     * @param {number} taxExclusiveAmount - Amount without tax
     * @param {number} taxRate - Tax rate percentage
     * @returns {object}
     */
    calculateVATAmounts(taxExclusiveAmount, taxRate = 16) {
        const taxableAmount = taxExclusiveAmount; // This is the tax-exclusive amount
        const taxAmount = (taxExclusiveAmount * taxRate) / 100;
        const taxInclusiveAmount = taxExclusiveAmount + taxAmount;

        return {
            taxableAmount: parseFloat(taxableAmount.toFixed(4)),
            taxAmount: parseFloat(taxAmount.toFixed(4)),
            taxInclusiveAmount: parseFloat(taxInclusiveAmount.toFixed(4))
        };
    }

    /**
     * Generate CIS invoice number for ZRA
     * @param {number} store_id
     * @returns {Promise<string>}
     */
    async generateCISInvoiceNumber(store_id) {
        try {
            // Retrieve the store record
            let storeObj = await store.findByPk(store_id);

            if (!storeObj) {
                throw new Error('Store not found');
            }

            // Get the current invoice number, e.g., "INV1001-1"
            const currentInvoice = storeObj.invoice_number;

            // Use regex to extract the prefix and the numeric part
            const match = currentInvoice.match(/^(INV\d+-)(\d+)$/);

            if (!match) {
                throw new Error('Invalid invoice number format');
            }

            const prefix = match[1]; // "INV1001-"
            const number = parseInt(match[2], 10); // 1

            // Increment the number
            const newNumber = number + 1;

            // Construct the new invoice number
            const newInvoiceNumber = `${prefix}${newNumber}`;

            // Update the store with the new invoice number
            await storeObj.update({ invoice_number: newInvoiceNumber });

            return newInvoiceNumber;

        } catch (error) {
            console.error('Error generating CIS invoice number:', error);
            throw error;
        }
    }

    /**
     * Transform sale data to ZRA sales format
     * @param {object} saleData
     * @param {array} items
     * @param {object} user
     * @returns {Promise<object>}
     */
    async transformToZRASalesData(saleData, items, user) {
        const currentDateTime = this.formatZRADateTime();
        const currentDate = this.formatZRADate();

        // Generate invoice number
        const cisInvoiceNo = await this.generateCISInvoiceNumber(user.store_id);

        // Calculate totals
        let totalTaxableAmountA = 0;
        let totalTaxAmountA = 0;

        const itemList = items.map((item, index) => {
            // Determine tax-exclusive total for calculations
            const appliedTaxRate = saleData.tax_rate || 16;
            const taxExclusiveTotal = (item.tax_exclusive_total != null)
                ? parseFloat(item.tax_exclusive_total)
                : (parseFloat(item.total_price) / (1 + (appliedTaxRate / 100)));
            const { taxableAmount, taxAmount, taxInclusiveAmount } = this.calculateVATAmounts(taxExclusiveTotal, appliedTaxRate);

            // Calculate tax-inclusive unit price
            const taxInclusiveUnitPrice = taxInclusiveAmount / item.quantity;

            // Add to totals
            totalTaxableAmountA += taxableAmount;
            totalTaxAmountA += taxAmount;

            return {
                itemSeq: index + 1,
                itemCd: item.product?.product_code || `ITEM${item.product_id}`,
                itemClsCd: item.product?.product_class_code || "50102518",
                itemNm: item.product?.name || "Product",
                bcd: "",
                pkgUnitCd: "BA",
                pkg: 0,
                qtyUnitCd: "BE",
                qty: item.quantity,
                prc: parseFloat(taxInclusiveUnitPrice.toFixed(4)),
                splyAmt: parseFloat(taxInclusiveAmount.toFixed(4)),
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
                totAmt: parseFloat(taxInclusiveAmount.toFixed(4))
            };
        });

        return {
            tpin: process.env.ZRA_TPIN || "1002010901",
            bhfId: process.env.ZRA_BHF_ID || "000",
            orgInvcNo: 0,
            cisInvcNo: cisInvoiceNo,
            custTpin: saleData.customer?.tpin || null,
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
            taxblAmtA: parseFloat(totalTaxableAmountA.toFixed(4)),
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
            taxAmtA: parseFloat(totalTaxAmountA.toFixed(4)),
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
            totTaxblAmt: parseFloat(totalTaxableAmountA.toFixed(4)),
            totTaxAmt: parseFloat(totalTaxAmountA.toFixed(4)),
            totAmt: parseFloat(saleData.total_amount.toFixed(4)),
            prchrAcptcYn: "N",
            remark: saleData.notes || "",
            regrId: "admin",
            regrNm: "admin",
            modrId: "admin",
            modrNm: "admin",
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

        const itemList = items.map((item, index) => {
            const appliedTaxRate2 = saleData.tax_rate || 16;
            const taxExclusiveTotal = (item.tax_exclusive_total != null)
                ? parseFloat(item.tax_exclusive_total)
                : (parseFloat(item.total_price) / (1 + (appliedTaxRate2 / 100)));
            const { taxableAmount, taxAmount, taxInclusiveAmount } = this.calculateVATAmounts(taxExclusiveTotal, appliedTaxRate2);

            const taxInclusiveUnitPrice = taxInclusiveAmount / item.quantity;

            totalTaxableAmount += taxableAmount;
            totalTaxAmount += taxAmount;

            return {
                itemSeq: index + 1,
                itemCd: item.product?.product_code || `ITEM${item.product_id}`,
                itemClsCd: item.product?.product_class_code || "50102518",
                itemNm: item.product?.name || "Product",
                bcd: null,
                pkgUnitCd: "BA",
                pkg: 0,
                qtyUnitCd: "BE",
                qty: item.quantity,
                itemExprDt: null,
                prc: parseFloat(taxInclusiveUnitPrice.toFixed(4)),
                splyAmt: parseFloat(taxInclusiveAmount.toFixed(4)),
                totDcAmt: 0,
                iplCatCd: null,
                tlCatCd: null,
                exciseCatCd: null,
                taxblAmt: parseFloat(taxableAmount.toFixed(4)),
                vatCatCd: "A",
                taxAmt: parseFloat(taxAmount.toFixed(4)),
                iplAmt: null,
                tlAmt: null,
                exciseTxAmt: null,
                totAmt: parseFloat(taxInclusiveAmount.toFixed(4))
            };
        });

        return {
            tpin: process.env.ZRA_TPIN || "1002010901",
            bhfId: process.env.ZRA_BHF_ID || "000",
            sarNo: Math.floor(Math.random() * 900000) + 100000, // Generate 6-digit random SAR number
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
            totAmt: parseFloat(saleData.total_amount.toFixed(4)),
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
    async transformToZRAStockMasterData(items, user) {
        // rsdQty should reflect current stock for the specific shop (store) for each item
        // Determine store_id from user or fallback to item-level store_id if present
        const storeId = user?.store_id;

        const stockItemList = await Promise.all(items.map(async (item) => {
            const productId = item.product_id || item.product?.id;

            let qty = 0;
            try {
                const whereClause = {
                    product_id: productId
                };
                if (storeId) {
                    whereClause.store_id = storeId;
                } else if (item.store_id) {
                    whereClause.store_id = item.store_id;
                }

                if (whereClause.store_id) {
                    const inv = await productinventory.findOne({ where: whereClause });
                    qty = inv?.stock_quantity ?? 0;
                } else {
                    // No store context — default to 0 to avoid sending incorrect totals
                    qty = 0;
                }
            } catch (e) {
                console.error('Error fetching inventory for stock master data:', e.message);
            }

            return {
                itemCd: item.product?.product_code || `ITEM${item.product_id}`,
                itemClsCd: item.product?.product_class_code || "50102518",
                rsdQty: qty
            };
        }));

        return {
            tpin: process.env.ZRA_TPIN || "1002010901",
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
     * Validate required data before sending to ZRA
     * @param {object} data
     * @param {string} type
     * @returns {object}
     */
    validateZRAData(data, type) {
        const errors = [];

        if (!data.tpin) errors.push('TPIN is required');
        if (!data.bhfId) errors.push('Branch ID is required');

        if (type === 'sales') {
            if (!data.cisInvcNo) errors.push('CIS Invoice Number is required');
            if (!data.itemList || data.itemList.length === 0) errors.push('Items are required');
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Send sales data to ZRA
     * @param {object} salesData
     * @returns {Promise}
     */
    async sendSalesData(salesData) {
        try {
            // Validate data
            const validation = this.validateZRAData(salesData, 'sales');
            if (!validation.isValid) {
                return {
                    success: false,
                    error: `Validation failed: ${validation.errors.join(', ')}`,
                    endpoint: 'saveSales'
                };
            }

            console.log('Sending sales data to ZRA:', JSON.stringify(salesData, null, 2));

            const response = await axios.post(
                `${this.baseURL}/trnsSales/saveSales`,
                salesData,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },

                }
            );

            console.log('ZRA Sales Response:', response.data);

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
            console.log('Sending stock items data to ZRA:', JSON.stringify(stockItemsData, null, 2));

            const response = await axios.post(
                `${this.baseURL}/stock/saveStockItems`,
                stockItemsData,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },

                }
            );

            console.log('ZRA Stock Items Response:', response.data);

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
            console.log('Sending stock master data to ZRA:', JSON.stringify(stockMasterData, null, 2));

            const response = await axios.post(
                `${this.baseURL}/stockMaster/saveStockMaster`,
                stockMasterData,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },

                }
            );

            console.log('ZRA Stock Master Response:', response.data);

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
            // Validate input data
            if (!saleData || !items || !user) {
                throw new Error('Missing required parameters: saleData, items, or user');
            }

            if (!Array.isArray(items) || items.length === 0) {
                throw new Error('Items array is required and cannot be empty');
            }

            // Transform data for each endpoint
            const salesData = await this.transformToZRASalesData(saleData, items, user);
            const stockItemsData = this.transformToZRAStockItemsData(saleData, items, user);
            const stockMasterData = await this.transformToZRAStockMasterData(items, user);

            // Send requests to all three endpoints sequentially to avoid race conditions
            const salesResponse = await this.sendSalesData(salesData);
            results.responses.push(salesResponse);

            if (!salesResponse.success) {
                results.errors.push({
                    endpoint: 'saveSales',
                    error: salesResponse.error
                });
            }

            const stockItemsResponse = await this.sendStockItemsData(stockItemsData);
            results.responses.push(stockItemsResponse);

            if (!stockItemsResponse.success) {
                results.errors.push({
                    endpoint: 'saveStockItems',
                    error: stockItemsResponse.error
                });
            }

            const stockMasterResponse = await this.sendStockMasterData(stockMasterData);
            results.responses.push(stockMasterResponse);

            if (!stockMasterResponse.success) {
                results.errors.push({
                    endpoint: 'saveStockMaster',
                    error: stockMasterResponse.error
                });
            }

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