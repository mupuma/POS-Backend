const fs = require('fs');
const path = require('path');
const { getLogRoot } = require('../fileAuditLogger');

function getDateKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function toSerializable(value) {
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
            response: value.response?.data,
            status: value.response?.status,
        };
    }

    if (value && typeof value.get === 'function') {
        return value.get({ plain: true });
    }

    return value;
}

function safeStringify(value) {
    const seen = new WeakSet();
    return JSON.stringify(value, (key, rawValue) => {
        const serializedValue = toSerializable(rawValue);
        if (serializedValue && typeof serializedValue === 'object') {
            if (seen.has(serializedValue)) {
                return '[Circular]';
            }
            seen.add(serializedValue);
        }
        return serializedValue;
    });
}

function cloneLogValue(value) {
    if (value == null) {
        return value;
    }
    return JSON.parse(safeStringify(value));
}

function resolveSalesLogKind(entry) {
    const explicitKind = String(entry?.logKind || '').toLowerCase();
    if (['current', 'retry'].includes(explicitKind)) {
        return explicitKind;
    }

    const source = String(entry?.source || '').toLowerCase();
    return source.includes('retry') ? 'retry' : 'current';
}

function getZraSalesLogPath(kind, type, timestamp) {
    return path.join(getLogRoot(), `zra-sales-${kind}-${type}-${getDateKey(timestamp)}.log`);
}

function writeZraSalesResponseLog(entry) {
    try {
        const timestamp = new Date();
        const logKind = resolveSalesLogKind(entry);
        const record = {
            timestamp: timestamp.toISOString(),
            source: entry.source || 'sales',
            log_kind: logKind,
            sale_id: entry.saleId ?? null,
            receipt_number: entry.receiptNumber ?? null,
            cis_invoice_no: entry.cisInvoiceNo ?? null,
            outcome: entry.outcome || 'failure',
            error: entry.error || null,
            normalized_response: entry.normalizedResponse || null,
            full_response: entry.fullResponse || null,
        };

        const filePath = getZraSalesLogPath(logKind, 'response', timestamp);
        fs.appendFileSync(filePath, `${safeStringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
        return filePath;
    } catch (error) {
        console.error('[sales] failed to write full ZRA response log', {
            saleId: entry?.saleId,
            error: error?.message || String(error),
        });
        return null;
    }
}

function buildPostmanRequest({ method, url, headers, body }) {
    const requestHeaders = cloneLogValue(headers || {});
    const requestBody = cloneLogValue(body);

    return {
        method,
        url,
        headers: requestHeaders,
        body: requestBody,
        postman: {
            method,
            url,
            header: Object.entries(requestHeaders || {}).map(([key, value]) => ({
                key,
                value: String(value),
            })),
            body: {
                mode: 'raw',
                raw: safeStringify(requestBody),
                options: {
                    raw: {
                        language: 'json',
                    },
                },
            },
        },
    };
}

function writeZraSalesRequestLog(entry) {
    try {
        const timestamp = new Date();
        const logKind = resolveSalesLogKind(entry);
        const request = buildPostmanRequest({
            method: entry.method || 'POST',
            url: entry.url,
            headers: entry.headers || { 'Content-Type': 'application/json' },
            body: entry.body || null,
        });
        const record = {
            timestamp: timestamp.toISOString(),
            source: entry.source || 'sales',
            log_kind: logKind,
            endpoint: entry.endpoint || 'saveSales',
            sale_id: entry.saleId ?? null,
            receipt_number: entry.receiptNumber ?? null,
            cis_invoice_no: entry.cisInvoiceNo ?? entry.body?.cisInvcNo ?? null,
            outcome: entry.outcome || 'request_created',
            request,
            copy_to_postman: {
                method: request.method,
                url: request.url,
                headers: cloneLogValue(request.headers),
                body: cloneLogValue(request.body),
            },
        };

        const filePath = getZraSalesLogPath(logKind, 'request', timestamp);
        fs.appendFileSync(filePath, `${safeStringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
        return filePath;
    } catch (error) {
        console.error('[sales] failed to write ZRA request log', {
            saleId: entry?.saleId,
            error: error?.message || String(error),
        });
        return null;
    }
}

module.exports = {
    writeZraSalesResponseLog,
    writeZraSalesRequestLog,
};
