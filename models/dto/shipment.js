class ShipmentDTO {
    constructor(data = {}) {
        this.sequenceNumber = data.sequenceNumber || 0;
        this.transactionNumber = data.transactionNumber || 0;
        this.shipmentNumber = data.shipmentNumber || '';
        this.description = data.description || '';
        this.shipDate = data.shipDate || null;
        this.fiscalYear = data.fiscalYear || '';
        this.fiscalPeriod = data.fiscalPeriod || 'Num1';
        this.reference = data.reference || '';
        this.entryType = data.entryType || 'Shipment';
        this.customerNumber = data.customerNumber || '';
        this.customerName = data.customerName || '';
        this.contact = data.contact || '';
        this.sourceCurrency = data.sourceCurrency || '';
        this.priceList = data.priceList || '';
        this.exchangeRate = data.exchangeRate || 0;
        this.rateType = data.rateType || '';
        this.rateDate = data.rateDate || null;
        this.rateOperation = data.rateOperation || 'Multiply';
        this.rateOverride = data.rateOverride !== undefined ? data.rateOverride : true;
        this.serialNumberUniquifier = data.serialNumberUniquifier || 0;
        this.jobRelated = data.jobRelated !== undefined ? data.jobRelated : true;
        this.icUniqueDocumentNumber = data.icUniqueDocumentNumber || 0;
        this.recordStatus = data.recordStatus || 'Entered';
        this.recordDeleted = data.recordDeleted !== undefined ? data.recordDeleted : true;
        this.nextDetailLineNumber = data.nextDetailLineNumber || 0;
        this.recordPrinted = data.recordPrinted !== undefined ? data.recordPrinted : true;
        this.numberOfOptionalFields = data.numberOfOptionalFields || 0;
        this.enteredBy = data.enteredBy || '';
        this.postingDate = data.postingDate || null;
        this.customerExists = data.customerExists !== undefined ? data.customerExists : true;
        this.postSequenceNumber = data.postSequenceNumber || 0;

        // Initialize nested DTOs
        this.shipmentDetails = (data.shipmentDetails || [])
            .map(detail => new ShipmentDetailDTO(detail));
        this.shipmentOptionalFields = (data.shipmentOptionalFields || [])
            .map(field => new ShipmentOptionalFieldDTO(field));
    }

    toJSON() {
        return {
            sequenceNumber: this.sequenceNumber,
            transactionNumber: this.transactionNumber,
            shipmentNumber: this.shipmentNumber,
            description: this.description,
            shipDate: this.shipDate,
            fiscalYear: this.fiscalYear,
            fiscalPeriod: this.fiscalPeriod,
            reference: this.reference,
            entryType: this.entryType,
            customerNumber: this.customerNumber,
            customerName: this.customerName,
            contact: this.contact,
            sourceCurrency: this.sourceCurrency,
            priceList: this.priceList,
            exchangeRate: this.exchangeRate,
            rateType: this.rateType,
            rateDate: this.rateDate,
            rateOperation: this.rateOperation,
            rateOverride: this.rateOverride,
            serialNumberUniquifier: this.serialNumberUniquifier,
            jobRelated: this.jobRelated,
            icUniqueDocumentNumber: this.icUniqueDocumentNumber,
            recordStatus: this.recordStatus,
            recordDeleted: this.recordDeleted,
            nextDetailLineNumber: this.nextDetailLineNumber,
            recordPrinted: this.recordPrinted,
            numberOfOptionalFields: this.numberOfOptionalFields,
            enteredBy: this.enteredBy,
            postingDate: this.postingDate,
            customerExists: this.customerExists,
            postSequenceNumber: this.postSequenceNumber,
            shipmentDetails: this.shipmentDetails.map(d => d.toJSON()),
            shipmentOptionalFields: this.shipmentOptionalFields.map(f => f.toJSON())
        };
    }
}