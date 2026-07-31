const fs = require('fs');
const path = require('path');
const { protectLogDirectory } = require('./logFileProtection');

function resolveLogRoot() {
    if (process.env.POS_LOG_DIR) {
        return path.resolve(process.env.POS_LOG_DIR);
    }
    // Packaged .exe: logs sit next to pos-backend.exe (not process.cwd()).
    if (process.pkg) {
        return path.join(path.dirname(process.execPath), 'logs');
    }
    // Dev (node server.js): always POS-Backend/logs regardless of cwd.
    return path.join(__dirname, '..', 'logs');
}

const LOG_ROOT = resolveLogRoot();

function getDateKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function ensureLogRoot() {
    if (!fs.existsSync(LOG_ROOT)) {
        fs.mkdirSync(LOG_ROOT, { recursive: true });
    }
}

function resolveCategory(action, entityType) {
    const normalizedAction = String(action || '').toLowerCase();
    const normalizedEntity = String(entityType || '').toLowerCase();

    if (normalizedAction.startsWith('auth.') || normalizedEntity === 'auth') {
        return 'auth';
    }
    if (normalizedAction.startsWith('sale.') || normalizedEntity === 'sale') {
        return 'sales';
    }
    if (normalizedAction.includes('credit_note') || normalizedEntity === 'credit_note') {
        return 'credit-notes';
    }
    return 'audit';
}

function getCategoryLogPath(category, dateKey = getDateKey()) {
    ensureLogRoot();
    return path.join(LOG_ROOT, `${category}-${dateKey}.log`);
}

function getReadableSalesLogPath(dateKey = getDateKey()) {
    ensureLogRoot();
    return path.join(LOG_ROOT, `sales-readable-${dateKey}.log`);
}

function formatMoney(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) {
        return '-';
    }
    return `K${amount.toFixed(2)}`;
}

function formatTimestamp(iso) {
    return String(iso || '')
        .replace('T', ' ')
        .replace(/\.\d+Z$/, ' UTC');
}

function getReadableCreditNotesLogPath(dateKey = getDateKey()) {
    ensureLogRoot();
    return path.join(LOG_ROOT, `credit-notes-readable-${dateKey}.log`);
}

function formatCreditNotesReadableBlock(record) {
    const details = record.details || {};
    const outcome = String(record.outcome || 'success').toUpperCase();
    const receipt = details.receipt_number || record.target_identifier || '-';
    const cashier = record.actor_name || record.actor_identifier || '-';
    const role = record.actor_role ? ` (${record.actor_role})` : '';
    const store = record.store_id != null ? `Store ${record.store_id}` : 'Store -';
    const lines = [
        `${'='.repeat(78)}`,
        `${formatTimestamp(record.timestamp)} | ${outcome} | Credit Note: ${receipt}`,
        `  Cashier: ${cashier}${role} | ${store}`,
    ];

    if (details.original_receipt_number || details.original_sale_id) {
        lines.push(
            `  Original sale: ${details.original_receipt_number || '-'} (#${details.original_sale_id ?? '-'})`
        );
    }

    if (details.reason) {
        lines.push(`  Reason: ${details.reason}`);
    }

    if (details.invnumber) {
        lines.push(`  CIS credit note: ${details.invnumber}`);
    }

    lines.push(
        `  Total: ${formatMoney(details.total_amount)} | Tax: ${formatMoney(details.tax_amount)} | Subtotal: ${formatMoney(details.subtotal)}`,
        `  Payment: ${details.payment_method || '-'} | Items: ${details.item_count ?? (Array.isArray(details.items) ? details.items.length : '-')}`,
    );

    if (details.zra_status) {
        lines.push(`  ZRA: ${details.zra_status}${details.zra_error ? ` (${details.zra_error})` : ''}`);
    }
    if (details.sdcid || details.receipt_no || details.invoice_no) {
        lines.push(
            `  SDC id: ${details.sdcid || '-'} | ZRA receipt: ${details.receipt_no || '-'} | ZRA invoice: ${details.invoice_no || '-'}`
        );
    }

    if (outcome === 'FAILURE' && details.reason) {
        lines.push(`  Reason: ${details.reason}`);
    }

    if (Array.isArray(details.items) && details.items.length > 0) {
        lines.push('  Lines:');
        for (const item of details.items) {
            const name = item.name || `Product #${item.product_id ?? '?'}`;
            const qty = item.quantity ?? '?';
            const unit = formatMoney(item.unit_price);
            const total = formatMoney(item.total_price);
            lines.push(`    - ${name} x${qty} @ ${unit} = ${total}`);
        }
    }

    lines.push(`${'='.repeat(78)}`, '');
    return lines.join('\n');
}

function formatSalesReadableBlock(record) {
    const details = record.details || {};
    const outcome = String(record.outcome || 'success').toUpperCase();
    const receipt = details.receipt_number || record.target_identifier || '-';
    const cashier = record.actor_name || record.actor_identifier || '-';
    const role = record.actor_role ? ` (${record.actor_role})` : '';
    const store = record.store_id != null ? `Store ${record.store_id}` : 'Store -';
    const lines = [
        `${'='.repeat(78)}`,
        `${formatTimestamp(record.timestamp)} | ${outcome} | Receipt: ${receipt}`,
        `  Cashier: ${cashier}${role} | ${store}`,
    ];

    if (details.cis_invoice_no) {
        lines.push(`  Invoice: ${details.cis_invoice_no}`);
    }

    lines.push(
        `  Total: ${formatMoney(details.total_amount)} | Tax: ${formatMoney(details.tax_amount)} | Discount: ${formatMoney(details.discount_amount)}`,
        `  Payment: ${details.payment_method || '-'} | Items: ${details.item_count ?? (Array.isArray(details.items) ? details.items.length : '-')}`,
    );

    if (details.payments_breakdown && typeof details.payments_breakdown === 'object') {
        const parts = Object.entries(details.payments_breakdown)
            .filter(([, amount]) => Number(amount) > 0)
            .map(([method, amount]) => `${method}=${formatMoney(amount)}`);
        if (parts.length > 0) {
            lines.push(`  Breakdown: ${parts.join(', ')}`);
        }
    }

    if (details.zra_status) {
        const zraLine = `  ZRA: ${details.zra_status}${details.zra_error ? ` (${details.zra_error})` : ''}`;
        lines.push(zraLine);
    }
    if (details.receipt_no || details.invoice_no) {
        lines.push(`  ZRA receipt: ${details.receipt_no || '-'} | ZRA invoice: ${details.invoice_no || '-'}`);
    }

    if (outcome === 'FAILURE' && details.reason) {
        lines.push(`  Reason: ${details.reason}`);
    }

    if (Array.isArray(details.items) && details.items.length > 0) {
        lines.push('  Lines:');
        for (const item of details.items) {
            const name = item.name || `Product #${item.product_id ?? '?'}`;
            const qty = item.quantity ?? '?';
            const unit = formatMoney(item.unit_price);
            const total = formatMoney(item.total_price);
            lines.push(`    - ${name} x${qty} @ ${unit} = ${total}`);
        }
    }

    lines.push(`${'='.repeat(78)}`, '');
    return lines.join('\n');
}

function buildRecord(entry, category) {
    return {
        timestamp: (entry.occurred_at instanceof Date
            ? entry.occurred_at
            : entry.occurred_at
                ? new Date(entry.occurred_at)
                : new Date()
        ).toISOString(),
        category,
        action: entry.action || null,
        outcome: entry.outcome || 'success',
        entity_type: entry.entityType || entry.entity_type || null,
        actor_user_id: entry.actor_user_id ?? null,
        actor_identifier: entry.actor_identifier ?? null,
        actor_name: entry.actor_name ?? null,
        actor_role: entry.actor_role ?? null,
        target_user_id: entry.target_user_id ?? null,
        target_identifier: entry.target_identifier ?? null,
        target_name: entry.target_name ?? null,
        store_id: entry.store_id ?? null,
        ip_address: entry.ip_address ?? null,
        user_agent: entry.user_agent ?? null,
        details: entry.details ?? null,
    };
}

function appendLine(filePath, line) {
    ensureLogRoot();
    fs.appendFileSync(filePath, `${line}\n`, { encoding: 'utf8', flag: 'a' });
}

function appendText(filePath, text) {
    ensureLogRoot();
    fs.appendFileSync(filePath, text, { encoding: 'utf8', flag: 'a' });
}

function writeFileAuditLog(entry) {
    try {
        const category = resolveCategory(entry.action, entry.entityType || entry.entity_type);
        const record = buildRecord(entry, category);
        const line = JSON.stringify(record);
        const dateKey = getDateKey(new Date(record.timestamp));

        appendLine(getCategoryLogPath(category, dateKey), line);
        if (category !== 'audit') {
            appendLine(getCategoryLogPath('audit', dateKey), line);
        }
        if (category === 'sales') {
            appendText(getReadableSalesLogPath(dateKey), formatSalesReadableBlock(record));
        }
        if (category === 'credit-notes') {
            appendText(getReadableCreditNotesLogPath(dateKey), formatCreditNotesReadableBlock(record));
        }
    } catch (error) {
        console.error('Failed to write file audit log:', error.message);
    }
}

function getLogRoot() {
    ensureLogRoot();
    return LOG_ROOT;
}

function initLogDirectory() {
    ensureLogRoot();
    let protection = { protected: false, reason: 'not-attempted' };
    try {
        protection = protectLogDirectory(LOG_ROOT);
    } catch (error) {
        protection = { protected: false, reason: error.message };
        console.warn('Failed to lock POS audit log directory:', error.message);
    }
    const dateKey = getDateKey();
    return {
        root: getLogRoot(),
        protection,
        salesJson: getCategoryLogPath('sales', dateKey),
        salesReadable: getReadableSalesLogPath(dateKey),
        creditNotesReadable: getReadableCreditNotesLogPath(dateKey),
        audit: getCategoryLogPath('audit', dateKey),
        auth: getCategoryLogPath('auth', dateKey),
        creditNotes: getCategoryLogPath('credit-notes', dateKey),
    };
}

module.exports = {
    writeFileAuditLog,
    getLogRoot,
    resolveCategory,
    initLogDirectory,
    getReadableSalesLogPath,
    getReadableCreditNotesLogPath,
};
