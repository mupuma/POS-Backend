const axios = require('axios');

/**
 * Sage Internal Usage Service - Consolidated Daily Batches
 * Handles communication with Sage 300 API for internal usage transactions
 * Creates one batch per day containing all internal usage for that day
 */
class SageInternalUsage {
    constructor() {}

    _normalizeItem(item) {
        const quantity = item.quantity ?? 0;
        const unit_cost = item.unit_cost ?? 0;
        const code = item.product?.product_code || item.product_code || (item.product_id ? String(item.product_id) : '');
        const description = item.product?.name || item.product_name || '';
        const category = item.product?.category || item.category || '';
        return { quantity, unit_cost, code, description, category };
    }

    /**
     * Creates a consolidated internal usage batch for multiple transactions
     * @param {Array} usageDataArray - Array of usage objects with their items
     * @param {Object} user - User/store information for the batch
     * @param {string} date - Date for the batch (YYYY-MM-DD format)
     */
    async createConsolidatedInternalUsageBatch(usageDataArray, user, date) {
        try {
            const results = [];
            let allSucceeded = true;
            // Guard against duplicate internal usage within the same run
            const processedUsageNumbers = new Set();

            for (const usageData of usageDataArray) {
                const { items = [], usageNumber, employeeNumber, usageAccount } = usageData;

                // Skip if this usage has already been processed in this batch run
                if (usageNumber && processedUsageNumbers.has(usageNumber)) {
                    results.push({ usageNumber, success: true, skipped: true, reason: 'duplicate-in-run' });
                    continue;
                }
                if (usageNumber) processedUsageNumbers.add(usageNumber);

                const utcDate = new Date().toISOString();
                const batchDate = date || utcDate.slice(0, 10);
                const description = `${usageNumber} (${user?.store?.store_location || 'STORE'})`;

                // Build InternalUsageDetails for this transaction
                let lineNumber = 1000;
                const usageDetails = items.map(rawItem => {
                    const it = this._normalizeItem(rawItem);
                    const detail = {
                        SequenceNumber: 0,
                        LineNumber: lineNumber,
                        ItemNumber: it.code,
                        ItemDescription: it.description,
                        Category: it.category,
                        Location: user?.store?.store_number || '',
                        Quantity: it.quantity,
                        UnitOfMeasure: "EACH",
                        ConversionFactor: 1,
                        UnitCost: it.unit_cost,
                        ExtendedCost: 0,
                        SerialNumbers: true,
                        Comments: usageNumber ? `Usage: ${usageNumber}` : "",
                        ManufacturersItemNumber: "",
                        NumberOfOptionalFields: 0,
                        DetailLineNumber: 0,
                        UsageAccount:"",
                        EmployeeNumber:"",
                        SageFixedAssetsAttached: false,
                        NumberOfSerials: 0,
                        LotQuantity: 0,
                        Function: 0,
                        RevisionListLineNumber: 0,
                        InterprocessCommID: 0,
                        ForcePopupSN: true,
                        PopupSN: 0,
                        CloseSN: true,
                        LTSetID: 0,
                        ForcePopupLT: true,
                        PopupLT: 0,
                        CloseLT: true,
                        UnformattedItemNumber: it.code,
                        ProcessCommand: "NothingToProcess",
                        Database: "",
                        Company: "",
                        Template: "",
                        AssetDescription: "",
                        SeparateQuantities: false,
                        AssetQuantity: 0,
                        UOM: "EACH",
                        Amount: 0,
                        SerialLotQuantityToProcess: 0,
                        NumberOfLotsToGenerate: 0,
                        QuantityperLot: 0,
                        AllocateFromSerial: "",
                        AllocateFromLot: "",
                        SerialLotWindowHandle: 0
                    };
                    lineNumber += 1000;
                    return detail;
                });

                const consolidatedInternalUsage = {
                    SequenceNumber: 0,
                    TransactionNumber: 0,

                    Description: description,
                    EntryType: "InternalUsage",
                    InternalUsageDate: utcDate,
                    Reference: `Usage ${usageNumber}`,
                    ICUniqueDocumentNumber: 0,
                    NextDetailLineNumber: Math.floor(lineNumber / 1000) + 1,
                    RecordStatus: "Entered",
                    RecordDeleted: false,
                    RecordPrinted: false,
                    NumberOfOptionalFields: 0,
                    EmployeeNumber: employeeNumber || "",
                    EnteredBy: user?.full_name || "ADMIN",
                    PostingDate: utcDate,
                    PostSequenceNumber: 0,
                    IsCanadianPayrollActive: false,
                    IsUSPayrollActive: false,
                    InternalUsageDetails: usageDetails
                };

                try {
                    const username = process.env.SAGE_USERNAME || "ADMIN";
                    const password = process.env.SAGE_PASSWORD || "Admin123!";

                    const auth = `${username}:${password}`;
                    const encodedAuth = Buffer.from(auth, "utf-8").toString("base64");
                    const authorization = `Basic ${encodedAuth}`;
                    const baseUrl = process.env.SAGE_BASE_URL || "http://localhost/Sage300WebApi/v1.0/-/INDCOM";
                    const response = await axios.post(
                        `${baseUrl}/IC/ICInternalUsages`,
                        consolidatedInternalUsage,
                        {
                            headers: {
                                "Content-Type": "application/json",
                                "Accept": "application/json",
                                "Authorization": authorization,
                            }
                        }
                    );

                    results.push({
                        usageNumber,
                        success: true,
                        status: response.status,
                        data: response.data,
                        itemsProcessed: usageDetails.length
                    });
                } catch (error) {
                    const errMsg = error?.response?.data?.error || error?.message || '';
                    const status = error?.response?.status;
                    const isDuplicate =
                        status === 409 ||
                        (typeof errMsg === 'string' && /already exists|duplicate|usage number/i.test(errMsg));

                    if (isDuplicate) {
                        // Treat duplicates as idempotent success to avoid resending in loops
                        results.push({
                            usageNumber,
                            success: true,
                            status: status,
                            idempotent: true,
                            note: 'Duplicate internal usage detected; treated as success',
                            itemsProcessed: usageDetails.length
                        });
                    } else {
                        allSucceeded = false;
                        results.push({
                            usageNumber,
                            success: false,
                            status: status,
                            error: errMsg
                        });
                    }
                }
            }

            return {
                success: allSucceeded,
                usagesProcessed: usageDataArray.length,
                itemsProcessed: results.reduce((sum, r) => sum + (r.itemsProcessed || 0), 0),
                results
            };
        } catch (error) {
            console.error('Error creating internal usage batches:', {
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

    /**
     * Creates a single internal usage transaction
     * @param {Object} usageData - Usage data with usageNumber and optional employeeNumber
     * @param {Array} items - Array of items to be used internally
     * @param {Object} user - User/store information
     * @param {string} usageAccount - Optional GL account for usage
     */
    async createInternalUsage(usageData, items, user, usageAccount = '') {
        const usageArray = [{
            items: items,
            usageNumber: usageData?.usage_number || usageData?.usageNumber,
            employeeNumber: usageData?.employee_number || usageData?.employeeNumber || '',
            usageAccount: usageAccount
        }];

        return this.createConsolidatedInternalUsageBatch(usageArray, user);
    }
}

module.exports = SageInternalUsage;