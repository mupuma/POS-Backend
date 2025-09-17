const { store } = require('../models');
const axios = require('axios');

/**
 * Sage Shipment Service
 * Handles communication with Sage 300 API for inventory transactions
 */
class SageShipment {
    constructor() {}

    _normalizeItem(item) {
        const quantity = item.quantity ?? 0;
        const unit_price = item.unit_price ?? 0;
        const code = item.product?.product_code || item.product_code || (item.product_id ? String(item.product_id) : '');
        return { quantity, unit_price, code };
    }

    async createShipmentBatch(salesData, items, user) {
        try {
            const utcDate = new Date().toISOString();
            const date = utcDate.slice(0, 10);
            const description = `${user?.store?.store_location || 'STORE'} - ${date} Transactions`;

            const shipmentDetails = (items || []).map((raw, index) => {
                const it = this._normalizeItem(raw);
                return {
                    SequenceNumber: 0,
                    LineNumber: (index + 1) * 1000,
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
                    Comments: "",
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
                };
            });

            const shipment = {
                SequenceNumber: 0,
                TransactionNumber: 0,
                Description: description,
                ShipDate: utcDate,
                Reference: "",
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
                NextDetailLineNumber: (items?.length || 0) + 1,
                RecordPrinted: false,
                NumberOfOptionalFields: 0,
                EnteredBy: user?.full_name || "SYSTEM",
                PostingDate: utcDate,
                CustomerExists: true,
                PostSequenceNumber: 0,
                ProcessCommand: "NothingToProcess",
                ShipmentDetails: shipmentDetails,
                ShipmentOptionalFields: [],
                UpdateOperation: "Unspecified"
            };
            const username = process.env.SAGE_USERNAME || "ADMIN";
            const password = process.env.SAGE_PASSWORD || "Admin123!";

            // Encode auth as Base64
            const auth = `${username}:${password}`;
            const encodedAuth = Buffer.from(auth, "utf-8").toString("base64");
            const authorization = `Basic ${encodedAuth}`;

            const response = await axios.post(
                "http://localhost/Sage300WebApi/v1.0/-/INFDAT/IC/ICShipments",
                shipment,
                {
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "Authorization": authorization,
                    }
                }

            );

            return { success: true, status: response.status, data: response.data };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                status: error.response?.status,
                details: error.response?.data
            };
        }
    }
}
module.exports = SageShipment;
