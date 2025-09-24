const { store } = require('../models');
const axios = require('axios');

/**
 * Sage Shipment Service - Consolidated Daily Batches
 * Handles communication with Sage 300 API for inventory transactions
 * Creates one batch per day containing all shipments for that day
 */
class SageShipment {
    constructor() {}

    _normalizeItem(item) {
        const quantity = item.quantity ?? 0;
        const unit_price = item.unit_price ?? 0;
        const code = item.product?.product_code || item.product_code || (item.product_id ? String(item.product_id) : '');
        return { quantity, unit_price, code };
    }

    /**
     * Creates a consolidated shipment batch for multiple sales
     * @param {Array} salesDataArray - Array of sale objects with their items
     * @param {Object} user - User/store information for the batch
     * @param {string} date - Date for the batch (YYYY-MM-DD format)
     */
    async createConsolidatedShipmentBatch(salesDataArray, user, date) {
        try {
            const utcDate = new Date().toISOString();
            const batchDate = date || utcDate.slice(0, 10);
            const description = `${user?.store?.store_location || 'STORE'} - ${batchDate} Daily Shipments`;

            let lineNumber = 1000;
            const allShipmentDetails = [];

            // Process each sale and its items
            for (const saleData of salesDataArray) {
                const { items = [], receiptNumber } = saleData;

                for (const rawItem of items) {
                    const it = this._normalizeItem(rawItem);

                    allShipmentDetails.push({
                        SequenceNumber: 0,
                        LineNumber: lineNumber,
                        ItemNumber: it.code,
                        Location: user?.store?.store_number || '',
                        Quantity: it.quantity,
                        UnitOfMeasure: "EACH",
                        UnitPrice: it.unit_price,
                        ExtendedPrice: 0,
                        UnitCost: 0,
                        ExtendedCost: 0,
                        Obsolete: "",
                        SerialNumbers: true,
                        SerialNumberUniquifier: 0,
                        Comments: receiptNumber ? `Receipt: ${receiptNumber}` : "",
                        PMContract: "",
                        PMProject: "",
                        PMCategory: "",
                        PMDetail: 0,
                        PMWIPAccount: "",
                        ManufacturersItemNumber: "",
                        CustomerItemNumber: "",
                        DetailLineNumber: 0,
                        NumberOfOptionalFields: 0,
                        GLControlAmountShipment: 0,
                        GLCostVarianceShipment: 0,
                        GLControlAmountShipmentRet: 0,
                        GLCostVarianceShipmentRetu: 0,
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
                        SerialLotQuantityToProcess: 0,
                        NumberOfLotsToGenerate: 0,
                        QuantityperLot: 0,
                        EntryType: 0,
                        AllocateFromSerial: "",
                        AllocateFromLot: "",
                        SerialLotWindowHandle: 0,
                        ShipmentDetailOptionalFields: [],
                        ShipmentDetailLotNumbers: [],
                        ShipmentDetailSerialNumbers: [],
                        UpdateOperation: "Unspecified"
                    });

                    lineNumber += 1000;
                }
            }

            const consolidatedShipment = {
                SequenceNumber: 0,
                TransactionNumber: 0,
                Description: description,
                ShipDate: utcDate,
                Reference: `Daily batch for ${salesDataArray.length} sales`,
                EntryType: "Shipment",
                CustomerNumber: "WALK-IN",
                SourceCurrency: "ZMW",
                PriceList: "ZMW",
                ExchangeRate: 1,
                RateType: "SP",
                RateDate: utcDate,
                RateOperation: "Multiply",
                RateOverride: false,
                SerialNumberUniquifier: 0,
                JobRelated: false,
                ICUniqueDocumentNumber: 0,
                RecordStatus: "Entered",
                RecordDeleted: false,
                NextDetailLineNumber: Math.floor(lineNumber / 1000) + 1,
                RecordPrinted: false,
                NumberOfOptionalFields: 0,
                EnteredBy: user?.full_name || "SYSTEM",
                PostingDate: utcDate,
                CustomerExists: true,
                PostSequenceNumber: 0,
                ProcessCommand: "NothingToProcess",
                ShipmentDetails: allShipmentDetails,
                ShipmentOptionalFields: [],
                UpdateOperation: "Unspecified"
            };

            const username = process.env.SAGE_USERNAME || "ADMIN";
            const password = process.env.SAGE_PASSWORD || "Admin123!";

            // Encode auth as Base64
            const auth = `${username}:${password}`;
            const encodedAuth = Buffer.from(auth, "utf-8").toString("base64");
            const authorization = `Basic ${encodedAuth}`;

            console.log(`Creating consolidated shipment batch for ${salesDataArray.length} sales with ${allShipmentDetails.length} items`);

            const response = await axios.post(
                "http://localhost/Sage300WebApi/v1.0/-/INFDAT/IC/ICShipments",
                consolidatedShipment,
                {
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "Authorization": authorization,
                    }
                }
            );

            return {
                success: true,
                status: response.status,
                data: response.data,
                itemsProcessed: allShipmentDetails.length,
                salesProcessed: salesDataArray.length
            };
        } catch (error) {
            console.error('Error creating consolidated shipment batch:', {
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
    async createShipmentBatch(salesData, items, user) {
        const salesArray = [{
            items: items,
            receiptNumber: salesData?.receipt_number
        }];

        return this.createConsolidatedShipmentBatch(salesArray, user);
    }
}

module.exports = SageShipment;