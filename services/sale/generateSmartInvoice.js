const { store, productinventory } = require('../../models');
const axios = require('axios');
const { writeZraSalesRequestLog } = require('./zraFullResponseLogger');
const { isZraSaleAlreadyExistsResponse, normalizeZraSalesData } = require('./zraSaleResponse');
const { fetchSdcSaleByCisInvoice } = require('./sdcSqliteRecovery');

/**
 * ZRA Integration Service
 * Handles communication with ZRA VSDC system for sales transactions
 */
class ZRAIntegrationService {
    constructor() {
        this.baseURL = process.env.ZRA_BASE_URL;
        // 30 seconds timeout
    }

    buildUrl(endpointPath) {
        const baseUrl = String(this.baseURL || '').replace(/\/+$/, '');
        const path = String(endpointPath || '').replace(/^\/+/, '');
        return `${baseUrl}/${path}`;
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
     * Reserve both local sale numbers with one locked store read and one update.
     * This shortens checkout and keeps the two sequences atomic.
     */
    async generateSaleNumbers(storeId, transaction = null) {
        const findOptions = { transaction };
        if (transaction) {
            findOptions.lock = transaction.LOCK.UPDATE;
        }
        const storeObj = await store.findByPk(storeId, findOptions);
        if (!storeObj) throw new Error('Store not found');

        const storeDigits = (storeObj.store_number || '').match(/(\d+)/)?.[1] || '1001';
        const increment = (current, prefix) => {
            const match = current && current.match(new RegExp(`^(${prefix}\\d+-)(\\d+)$`));
            return match
                ? `${match[1]}${parseInt(match[2], 10) + 1}`
                : `${prefix}${storeDigits}-1`;
        };
        const receiptNumber = increment(storeObj.receipt_number, 'RCP');
        const cisInvoiceNo = increment(storeObj.invoice_number, 'INV');
        await storeObj.update({
            receipt_number: receiptNumber,
            invoice_number: cisInvoiceNo,
        }, { transaction });
        return { receiptNumber, cisInvoiceNo };
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
    async generateCISInvoiceNumber(store_id, transaction = null) {
        try {
            const findOptions = { transaction };
            if (transaction) {
                findOptions.lock = transaction.LOCK.UPDATE;
            }

            let storeObj = await store.findByPk(store_id, findOptions);

            if (!storeObj) {
                throw new Error('Store not found');
            }

            const currentInvoice = storeObj.invoice_number;
            const match = currentInvoice && currentInvoice.match(/^(INV\d+-)(\d+)$/);

            if (!match) {
                const storeNumDigits = (storeObj.store_number || '').match(/(\d+)/)?.[1] || '1001';
                const fallback = `INV${storeNumDigits}-1`;
                await storeObj.update({ invoice_number: fallback }, { transaction });
                return fallback;
            }

            const prefix = match[1];
            const number = parseInt(match[2], 10);
            const newNumber = number + 1;
            const newInvoiceNumber = `${prefix}${newNumber}`;

            await storeObj.update({ invoice_number: newInvoiceNumber }, { transaction });

            return newInvoiceNumber;

        } catch (error) {
            console.error('Error generating CIS invoice number:', error);
            throw error;
        }
    }

    /**
     * Generate incremental Receipt Number per store
     * Format expected: RCP{storeDigits}-{n}, e.g., RCP1001-1
     * @param {number} store_id
     * @returns {Promise<string>}
     */
    async generateReceiptNumber(store_id, transaction = null) {
        try {
            const findOptions = { transaction };
            if (transaction) {
                findOptions.lock = transaction.LOCK.UPDATE;
            }

            let storeObj = await store.findByPk(store_id, findOptions);
            if (!storeObj) {
                throw new Error('Store not found');
            }

            const currentReceipt = storeObj.receipt_number;
            // Match pattern like RCP1001-1
            const match = currentReceipt && currentReceipt.match(/^(RCP\d+-)(\d+)$/);

            if (!match) {
                // If format is invalid or empty, derive from store_number if possible
                const storeNumDigits = (storeObj.store_number || '').match(/(\d+)/)?.[1] || '1001';
                const fallback = `RCP${storeNumDigits}-1`;
                await storeObj.update({ receipt_number: fallback }, { transaction });
                return fallback;
            }

            const prefix = match[1];
            const number = parseInt(match[2], 10);
            const newNumber = number + 1;
            const newReceiptNumber = `${prefix}${newNumber}`;

            await storeObj.update({ receipt_number: newReceiptNumber }, { transaction });
            return newReceiptNumber;
        } catch (error) {
            console.error('Error generating receipt number:', error);
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
    async transformToZRASalesData(saleData, items, user, cisInvcNo = null) {
        const currentDateTime = this.formatZRADateTime();
        const currentDate = this.formatZRADate();
        const customerTpin = String(saleData.customer?.tpin || '').trim();
        const customerName = String(
            saleData.customer?.legal_name
            || saleData.customer?.name
            || saleData.customer?.full_name
            || ''
        ).trim();

        // Use the pre-assigned CIS invoice number when retrying or after local sale save
        const cisInvoiceNo = cisInvcNo || await this.generateCISInvoiceNumber(user.store_id);

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
            custTpin: customerTpin || "1000000000",
            custNm: customerName || "Walk-in Customer",
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
                pkgUnitCd: "EA",
                pkg: 0,
                qtyUnitCd: "EA",
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
            custTpin: "1000000000",
            custNm: "Walk-in Customer",
            custBhfId: "000",
            sarTyCd: "11",
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

    buildSaleDetailsLookupPayload(salesData) {
        return {
            tpin: salesData?.tpin || process.env.ZRA_TPIN || "1002010901",
            bhfId: salesData?.bhfId || process.env.ZRA_BHF_ID || "000",
            cisInvcNo: salesData?.cisInvcNo || null,
        };
    }

    isTimeoutError(error) {
        return error?.code === 'ECONNABORTED'
            || error?.code === 'ETIMEDOUT'
            || /timeout|timed\s*out/i.test(error?.message || '');
    }

    isMissingSdcDataResponse(responseData) {
        const normalized = normalizeZraSalesData({ success: true, data: responseData });
        return String(normalized.resultCd || '000') === '000'
            && (!normalized.sdcId || !normalized.rcptNo || !normalized.rcptSign);
    }

    isRejectedSalesResponse(responseData) {
        const normalized = normalizeZraSalesData({ success: true, data: responseData });
        return Boolean(normalized.resultCd) && String(normalized.resultCd) !== '000';
    }

    async fetchExistingSaleDetails(salesData, { timeoutMs } = {}) {
        const payload = this.buildSaleDetailsLookupPayload(salesData);
        if (!payload.cisInvcNo) {
            return {
                success: false,
                endpoint: 'selectSales',
                error: 'Cannot look up existing ZRA sale without cisInvcNo',
                request: payload,
            };
        }

        const endpointPath = process.env.ZRA_SALE_DETAILS_ENDPOINT || '/trnsSales/selectSales';
        const url = this.buildUrl(endpointPath);
        try {
            const response = await axios.post(
                url,
                payload,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: Number(timeoutMs || process.env.ZRA_LOOKUP_TIMEOUT_MS || 8000),
                }
            );

            return {
                success: true,
                endpoint: 'selectSales',
                url,
                request: payload,
                data: response.data,
            };
        } catch (error) {
            return {
                success: false,
                endpoint: 'selectSales',
                url,
                request: payload,
                error: error.response?.data || error.message,
            };
        }
    }

    async fetchSaleFromSdcSqlite(salesData, { reason, timeoutMs } = {}) {
        const recovery = await fetchSdcSaleByCisInvoice(salesData?.cisInvcNo, {
            tpin: salesData?.tpin,
            bhfId: salesData?.bhfId,
            timeoutMs,
        });
        return {
            source: 'sdc_sqlite_recovery',
            reason,
            ...recovery,
        };
    }

    /**
     * Send sales data to ZRA
     * @param {object} salesData
     * @returns {Promise}
     */
    async sendSalesData(salesData, { timeoutMs, logKind = 'current' } = {}) {
        const url = this.buildUrl('/trnsSales/saveSales');
        const headers = {
            'Content-Type': 'application/json'
        };
        const requestLogContext = {
            source: 'zra_service.sendSalesData',
            logKind,
            endpoint: 'saveSales',
            method: 'POST',
            url,
            headers,
            cisInvoiceNo: salesData?.cisInvcNo || null,
            body: salesData,
        };
        let requestLogPath = null;
        try {
            // Validate data
            const validation = this.validateZRAData(salesData, 'sales');
            if (!validation.isValid) {
                requestLogPath = writeZraSalesRequestLog({
                    ...requestLogContext,
                    outcome: 'validation_failed',
                });
                return {
                    success: false,
                    error: `Validation failed: ${validation.errors.join(', ')}`,
                    endpoint: 'saveSales',
                    request: requestLogContext,
                    requestLogPath
                };
            }

            console.log('Sending sales data to ZRA:', JSON.stringify(salesData, null, 2));
            requestLogPath = writeZraSalesRequestLog({
                ...requestLogContext,
                outcome: 'sent_to_zra',
            });

            const response = await axios.post(
                url,
                salesData,
                {
                    headers,
                    // A stalled ZRA socket must not occupy the immediate worker
                    // indefinitely. The sale remains pending for the retry job.
                    timeout: Number(
                        timeoutMs || process.env.ZRA_SALES_TIMEOUT_MS || 8000
                    ),
                }
            );

            console.log('ZRA Sales Response:', response.data);
            let existingSaleLookup = null;
            if (isZraSaleAlreadyExistsResponse(response.data)) {
                existingSaleLookup = await this.fetchExistingSaleDetails(salesData, { timeoutMs });
                console.log('ZRA existing sale lookup:', existingSaleLookup.data || existingSaleLookup.error);
            }
            let sdcRecovery = null;
            if (isZraSaleAlreadyExistsResponse(response.data)) {
                sdcRecovery = await this.fetchSaleFromSdcSqlite(salesData, {
                    reason: 'zra_sale_already_exists',
                    timeoutMs,
                });
                console.log('SDC SQLite recovery after duplicate response:', sdcRecovery.found ? sdcRecovery.data : sdcRecovery.error || 'not found');
            } else if (this.isRejectedSalesResponse(response.data)) {
                sdcRecovery = await this.fetchSaleFromSdcSqlite(salesData, {
                    reason: 'zra_rejected_sales_response',
                    timeoutMs,
                });
                console.log('SDC SQLite recovery after rejected ZRA response:', sdcRecovery.found ? sdcRecovery.data : sdcRecovery.error || 'not found');
            } else if (this.isMissingSdcDataResponse(response.data)) {
                sdcRecovery = await this.fetchSaleFromSdcSqlite(salesData, {
                    reason: 'zra_success_missing_sdc_data',
                    timeoutMs,
                });
                console.log('SDC SQLite recovery after missing SDC data:', sdcRecovery.found ? sdcRecovery.data : sdcRecovery.error || 'not found');
            }

            return {
                success: true,
                data: response.data,
                endpoint: 'saveSales',
                existingSaleLookup,
                sdcRecovery,
                requestLogPath
            };
        } catch (error) {
            console.error('ZRA Sales API Error:', error.response?.data || error.message);
            const zraError = error.response?.data || error.message;
            let existingSaleLookup = null;
            if (isZraSaleAlreadyExistsResponse(zraError)) {
                existingSaleLookup = await this.fetchExistingSaleDetails(salesData, { timeoutMs });
                console.log('ZRA existing sale lookup:', existingSaleLookup.data || existingSaleLookup.error);
            }
            let sdcRecovery = null;
            sdcRecovery = await this.fetchSaleFromSdcSqlite(salesData, {
                reason: this.isTimeoutError(error)
                    ? 'zra_timeout'
                    : (isZraSaleAlreadyExistsResponse(zraError) ? 'zra_sale_already_exists' : 'zra_post_failed'),
                timeoutMs,
            });
            console.log('SDC SQLite recovery after ZRA error:', sdcRecovery.found ? sdcRecovery.data : sdcRecovery.error || 'not found');
            if (sdcRecovery?.found) {
                return {
                    success: true,
                    data: null,
                    endpoint: 'saveSales',
                    recoveredFrom: 'sdc_sqlite',
                    sdcRecovery,
                    existingSaleLookup,
                    request: requestLogContext,
                    requestLogPath
                };
            }
            return {
                success: false,
                error: zraError,
                endpoint: 'saveSales',
                sdcRecovery,
                existingSaleLookup,
                request: requestLogContext,
                requestLogPath
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
                this.buildUrl('/stock/saveStockItems'),
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
                this.buildUrl('/stockMaster/saveStockMaster'),
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
