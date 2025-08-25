class ShipmentDetailOptionalFieldDTO {
    constructor(data = {}) {
        this.sequenceNumber = data.sequenceNumber || 0;
        this.lineNumber = data.lineNumber || 0;
        this.optionalField = data.optionalField || '';
        this.value = data.value || '';
        this.shipmentDetailOptionalFieldType = data.shipmentDetailOptionalFieldType || 'Text';
        this.length = data.length || 0;
        this.decimals = data.decimals || 0;
        this.allowBlank = data.allowBlank !== undefined ? data.allowBlank : true;
        this.validate = data.validate !== undefined ? data.validate : true;
        this.valueSet = data.valueSet || 'No';
        this.typedValueFieldIndex = data.typedValueFieldIndex || 0;
        this.textValue = data.textValue || '';
        this.amountValue = data.amountValue || 0;
        this.numberValue = data.numberValue || 0;
        this.integerValue = data.integerValue || 0;
        this.yesNoValue = data.yesNoValue !== undefined ? data.yesNoValue : true;
        this.dateValue = data.dateValue || null;
        this.timeValue = data.timeValue || null;
        this.optionalFieldDescription = data.optionalFieldDescription || '';
        this.valueDescription = data.valueDescription || '';
    }

    toJSON() {
        return {
            sequenceNumber: this.sequenceNumber,
            lineNumber: this.lineNumber,
            optionalField: this.optionalField,
            value: this.value,
            shipmentDetailOptionalFieldType: this.shipmentDetailOptionalFieldType,
            length: this.length,
            decimals: this.decimals,
            allowBlank: this.allowBlank,
            validate: this.validate,
            valueSet: this.valueSet,
            typedValueFieldIndex: this.typedValueFieldIndex,
            textValue: this.textValue,
            amountValue: this.amountValue,
            numberValue: this.numberValue,
            integerValue: this.integerValue,
            yesNoValue: this.yesNoValue,
            dateValue: this.dateValue,
            timeValue: this.timeValue,
            optionalFieldDescription: this.optionalFieldDescription,
            valueDescription: this.valueDescription
        };
    }
}