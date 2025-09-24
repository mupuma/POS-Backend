class ShipmentDetailLotNumberDTO {
    constructor(data = {}) {
        this.sequenceNumber = data.sequenceNumber || 0;
        this.lineNumber = data.lineNumber || 0;
        this.lotNumber = data.lotNumber || '';
        this.expiryDate = data.expiryDate || null;
        this.transactionQuantity = data.transactionQuantity || 0;
        this.lotQuantityInStockingUOM = data.lotQuantityInStockingUOM || 0;
    }

    toJSON() {
        return {
            sequenceNumber: this.sequenceNumber,
            lineNumber: this.lineNumber,
            lotNumber: this.lotNumber,
            expiryDate: this.expiryDate,
            transactionQuantity: this.transactionQuantity,
            lotQuantityInStockingUOM: this.lotQuantityInStockingUOM
        };
    }
}