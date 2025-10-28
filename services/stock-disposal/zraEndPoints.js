const { store } = require('../../models');
const axios = require('axios');

/**
 * ZRA Integration Service
 * Handles communication with ZRA VSDC system for sales transactions
 */
class ZRAIntegrationServiceStockDisposal {
    constructor() {
        this.baseURL = process.env.ZRA_BASE_URL|| 'http://localhost:8082/sandboxvsdc';
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
     * Transform sale data to ZRA stock items format
     * @param {object} saleData
     * @param {array} items
     * @param {object} user
     * @returns {object}
     */
    transformToZRAStockItemsDataDiscarding(saleData, items, user) {
        const currentDate = this.formatZRADate();

        let totalTaxableAmount = 0;
        let totalTaxAmount = 0;

        const itemList = items.map((item, index) => {
            const appliedTaxRate2 = saleData.tax_rate || 16;
            const taxExclusiveTotal = (item.tax_exclusive_total != null)
                ? parseFloat(item.tax_exclusive_total)
                : (parseFloat(item.total_price) / (1 + (appliedTaxRate2 / 100)));
            const {
                taxableAmount,
                taxAmount,
                taxInclusiveAmount
            } = this.calculateVATAmounts(taxExclusiveTotal, appliedTaxRate2);

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
            custBhfId: process.env.ZRA_BHF_ID || "000",
            sarTyCd: "15",
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

    transformToZRAStockItemsDataReplenishing(saleData, items, user) {
        const currentDate = this.formatZRADate();

        let totalTaxableAmount = 0;
        let totalTaxAmount = 0;

        const itemList = items.map((item, index) => {
            const appliedTaxRate2 = saleData.tax_rate || 16;
            const taxExclusiveTotal = (item.tax_exclusive_total != null)
                ? parseFloat(item.tax_exclusive_total)
                : (parseFloat(item.total_price) / (1 + (appliedTaxRate2 / 100)));
            const {
                taxableAmount,
                taxAmount,
                taxInclusiveAmount
            } = this.calculateVATAmounts(taxExclusiveTotal, appliedTaxRate2);

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
            custBhfId: process.env.ZRA_BHF_ID || "000",
            sarTyCd: "04",
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
     * @param remainingQty
     * @returns {object}
     */
    transformToZRAStockMasterData(items, user, remainingQty) {
        const stockItemList = items.map(item => ({
            itemCd: item.product?.product_code || `ITEM${item.product_id}`,
            itemClsCd: item.product?.product_class_code || "50102518",
            // Remaining stock quantity should come from inventory; we no longer read product-level stock
            rsdQty: remainingQty
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

}

module.exports = ZRAIntegrationServiceStockDisposal;