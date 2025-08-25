class ShipmentDetailSerialNumberDTO {
    constructor(data = {}) {
        this.sequenceNumber = data.sequenceNumber || 0;
        this.lineNumber = data.lineNumber || 0;
        this.serialNumber = data.serialNumber || '';
        this.serialQuantity = data.serialQuantity || 0;
    }

    toJSON() {
        return {
            sequenceNumber: this.sequenceNumber,
            lineNumber: this.lineNumber,
            serialNumber: this.serialNumber,
            serialQuantity: this.serialQuantity
        };
    }
}