class ShipmentDetailDTO {
    constructor(data = {}) {
        this.sequenceNumber = data.sequenceNumber || 0;
        this.lineNumber = data.lineNumber || 0;
        this.itemNumber = data.itemNumber || '';
        this.itemDescription = data.itemDescription || '';
        this.category = data.category || '';
        this.location = data.location || '';
        this.quantity = data.quantity || 0;
        this.unitOfMeasure = data.unitOfMeasure || '';
        this.conversionFactor = data.conversionFactor || 0;
        this.priceList = data.priceList || '';
        this.unitPrice = data.unitPrice || 0;
        this.extendedPrice = data.extendedPrice || 0;
        this.unitCost = data.unitCost || 0;
        this.extendedCost = data.extendedCost || 0;
        this.obsolete = data.obsolete || '';
        this.serialNumbers = data.serialNumbers !== undefined ? data.serialNumbers : true;
        this.serialNumberUniquifier = data.serialNumberUniquifier || 0;
        this.comments = data.comments || '';
        this.pmContract = data.pmContract || '';
        this.pmProject = data.pmProject || '';
        this.pmCategory = data.pmCategory || '';
        this.pmDetail = data.pmDetail || 0;
        this.pmWIPAccount = data.pmWIPAccount || '';
        this.manufacturersItemNumber = data.manufacturersItemNumber || '';
        this.customerItemNumber = data.customerItemNumber || '';
        this.detailLineNumber = data.detailLineNumber || 0;
        this.numberOfOptionalFields = data.numberOfOptionalFields || 0;
        this.glControlAmountShipment = data.glControlAmountShipment || 0;
        this.glCostVarianceShipment = data.glCostVarianceShipment || 0;
        this.glControlAmountShipmentRet = data.glControlAmountShipmentRet || 0;
        this.glCostVarianceShipmentRetu = data.glCostVarianceShipmentRetu || 0;
        this.numberOfSerials = data.numberOfSerials || 0;
        this.lotQuantity = data.lotQuantity || 0;
        this.function = data.function || 0;
        this.revisionListLineNumber = data.revisionListLineNumber || 0;
        this.interprocessCommID = data.interprocessCommID || 0;
        this.forcePopupSN = data.forcePopupSN !== undefined ? data.forcePopupSN : true;
        this.popupSN = data.popupSN || 0;
        this.closeSN = data.closeSN !== undefined ? data.closeSN : true;
        this.ltSetID = data.ltSetID || 0;
        this.forcePopupLT = data.forcePopupLT !== undefined ? data.forcePopupLT : true;
        this.popupLT = data.popupLT || 0;
        this.closeLT = data.closeLT !== undefined ? data.closeLT : true;
        this.unformattedItemNumber = data.unformattedItemNumber || '';
        this.processCommand = data.processCommand || 'NothingToProcess';
        this.serialLotQuantityToProcess = data.serialLotQuantityToProcess || 0;
        this.numberOfLotsToGenerate = data.numberOfLotsToGenerate || 0;
        this.quantityperLot = data.quantityperLot || 0;
        this.entryType = data.entryType || 0;
        this.allocateFromSerial = data.allocateFromSerial || '';
        this.allocateFromLot = data.allocateFromLot || '';
        this.serialLotWindowHandle = data.serialLotWindowHandle || 0;

        // Initialize nested DTOs
        this.shipmentDetailOptionalFields = (data.shipmentDetailOptionalFields || [])
            .map(field => new ShipmentDetailOptionalFieldDTO(field));
        this.shipmentDetailLotNumbers = (data.shipmentDetailLotNumbers || [])
            .map(lot => new ShipmentDetailLotNumberDTO(lot));
        this.shipmentDetailSerialNumbers = (data.shipmentDetailSerialNumbers || [])
            .map(serial => new ShipmentDetailSerialNumberDTO(serial));
    }

    toJSON() {
        return {
            sequenceNumber: this.sequenceNumber,
            lineNumber: this.lineNumber,
            itemNumber: this.itemNumber,
            itemDescription: this.itemDescription,
            category: this.category,
            location: this.location,
            quantity: this.quantity,
            unitOfMeasure: this.unitOfMeasure,
            conversionFactor: this.conversionFactor,
            priceList: this.priceList,
            unitPrice: this.unitPrice,
            extendedPrice: this.extendedPrice,
            unitCost: this.unitCost,
            extendedCost: this.extendedCost,
            obsolete: this.obsolete,
            serialNumbers: this.serialNumbers,
            serialNumberUniquifier: this.serialNumberUniquifier,
            comments: this.comments,
            pmContract: this.pmContract,
            pmProject: this.pmProject,
            pmCategory: this.pmCategory,
            pmDetail: this.pmDetail,
            pmWIPAccount: this.pmWIPAccount,
            manufacturersItemNumber: this.manufacturersItemNumber,
            customerItemNumber: this.customerItemNumber,
            detailLineNumber: this.detailLineNumber,
            numberOfOptionalFields: this.numberOfOptionalFields,
            glControlAmountShipment: this.glControlAmountShipment,
            glCostVarianceShipment: this.glCostVarianceShipment,
            glControlAmountShipmentRet: this.glControlAmountShipmentRet,
            glCostVarianceShipmentRetu: this.glCostVarianceShipmentRetu,
            numberOfSerials: this.numberOfSerials,
            lotQuantity: this.lotQuantity,
            function: this.function,
            revisionListLineNumber: this.revisionListLineNumber,
            interprocessCommID: this.interprocessCommID,
            forcePopupSN: this.forcePopupSN,
            popupSN: this.popupSN,
            closeSN: this.closeSN,
            ltSetID: this.ltSetID,
            forcePopupLT: this.forcePopupLT,
            popupLT: this.popupLT,
            closeLT: this.closeLT,
            unformattedItemNumber: this.unformattedItemNumber,
            processCommand: this.processCommand,
            serialLotQuantityToProcess: this.serialLotQuantityToProcess,
            numberOfLotsToGenerate: this.numberOfLotsToGenerate,
            quantityperLot: this.quantityperLot,
            entryType: this.entryType,
            allocateFromSerial: this.allocateFromSerial,
            allocateFromLot: this.allocateFromLot,
            serialLotWindowHandle: this.serialLotWindowHandle,
            shipmentDetailOptionalFields: this.shipmentDetailOptionalFields.map(f => f.toJSON()),
            shipmentDetailLotNumbers: this.shipmentDetailLotNumbers.map(l => l.toJSON()),
            shipmentDetailSerialNumbers: this.shipmentDetailSerialNumbers.map(s => s.toJSON())
        };
    }
}
