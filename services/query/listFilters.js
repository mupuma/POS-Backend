const { Op } = require('sequelize');

function parseDateWithOptionalTime(dateStr, timeStr, endOfDay = false) {
    if (!dateStr) {
        return null;
    }

    const base = new Date(dateStr);
    if (Number.isNaN(base.getTime())) {
        return null;
    }

    if (timeStr && /^\d{1,2}:\d{2}$/.test(String(timeStr).trim())) {
        const [hours, minutes] = String(timeStr).trim().split(':').map(Number);
        base.setHours(hours, minutes, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
        return base;
    }

    if (endOfDay) {
        base.setHours(23, 59, 59, 999);
    } else {
        base.setHours(0, 0, 0, 0);
    }

    return base;
}

function buildListQueryFilters(req, options = {}) {
    const {
        dateField = 'sale_date',
        amountField = 'total_amount',
        searchFields = [],
    } = options;

    const where = {};
    const q = String(req.query.q || req.query.query || req.query.receipt_no || '').trim();

    const startDate = parseDateWithOptionalTime(req.query.start_date, req.query.start_time, false);
    const endDate = parseDateWithOptionalTime(req.query.end_date, req.query.end_time, true);

    if (startDate && endDate) {
        where[dateField] = { [Op.between]: [startDate, endDate] };
    } else if (startDate) {
        where[dateField] = { [Op.gte]: startDate };
    } else if (endDate) {
        where[dateField] = { [Op.lte]: endDate };
    }

    const minAmount = req.query.min_amount != null ? Number(req.query.min_amount) : null;
    const maxAmount = req.query.max_amount != null ? Number(req.query.max_amount) : null;

    if (minAmount != null && !Number.isNaN(minAmount) && maxAmount != null && !Number.isNaN(maxAmount)) {
        where[amountField] = { [Op.between]: [minAmount, maxAmount] };
    } else if (minAmount != null && !Number.isNaN(minAmount)) {
        where[amountField] = { [Op.gte]: minAmount };
    } else if (maxAmount != null && !Number.isNaN(maxAmount)) {
        where[amountField] = { [Op.lte]: maxAmount };
    }

    if (q && searchFields.length > 0) {
        where[Op.or] = searchFields.map((field) => ({
            [field]: { [Op.like]: `%${q}%` },
        }));
    }

    return where;
}

module.exports = {
    buildListQueryFilters,
    parseDateWithOptionalTime,
};
