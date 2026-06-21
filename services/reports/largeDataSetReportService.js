const { pool, executeWithRetry, streamQuery } = require('../../config/database');
const ExcelJS = require('exceljs');
const NodeCache = require('node-cache');
const { Readable } = require('stream');

// Cache for frequently accessed reports
const reportCache = new NodeCache({
    stdTTL: 300,
    checkperiod: 60,
    maxKeys: 50,
    useClones: false
});

class LargeDatasetReportService {
    constructor() {
        this.BATCH_SIZE = 1000;
        this.STREAM_BATCH_SIZE = 500;
        this.MAX_EXECUTION_TIME = 270000; // 4.5 minutes
        this.CACHE_DURATION = 180; // 3 minutes
    }

    /**
     * Chunk array into smaller arrays
     */
    chunkArray(array, size) {
        const chunks = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    /**
     * Main method to stream sales data with returns
     */
    async streamSalesData(startDate, endDate, storeId, options = {}) {
        const startTime = Date.now();
        const {
            category_id,
            product_id,
            batchSize = this.BATCH_SIZE,
            includeReturns = true,
            page = 0,
            limit = 1000
        } = options;

        const results = {
            data: {
                sales: [],
                returns: [],
                summary: this.initializeSummary(),
                pagination: {
                    currentPage: parseInt(page),
                    totalPages: 0,
                    totalRecords: 0,
                    hasMore: false
                }
            },
            progress: {
                processed: 0,
                total: 0,
                percentage: 0
            }
        };

        try {
            // Get total count with filters
            const totalCount = await this.getTotalSalesCount(
                startDate, 
                endDate, 
                storeId, 
                category_id, 
                product_id
            );
            
            results.data.pagination.totalRecords = totalCount;
            results.data.pagination.totalPages = Math.ceil(totalCount / batchSize);
            results.data.pagination.hasMore = page < results.data.pagination.totalPages - 1;
            results.progress.total = totalCount;

            // Get sales data in batches
            const offset = parseInt(page) * parseInt(batchSize);
            const salesData = await this.getSalesBatch(
                startDate,
                endDate,
                storeId,
                offset,
                parseInt(batchSize),
                category_id,
                product_id
            );

            // Process sales
            const processedSales = await this.processSalesBatch(salesData, results.data.summary);
            results.data.sales = processedSales;
            results.progress.processed += processedSales.length;

            // Get returns for these sales if needed
            if (includeReturns && processedSales.length > 0) {
                const saleIds = processedSales.map(s => s.id);
                const returnsData = await this.getReturnsForSales(saleIds);
                const processedReturns = await this.processReturnsBatch(returnsData, results.data.summary);
                results.data.returns = processedReturns;
                results.progress.processed += processedReturns.length;
            }

            // Calculate progress
            results.progress.percentage = results.progress.total > 0 
                ? Math.min(((results.progress.processed / results.progress.total) * 100), 100)
                : 0;

            // Check execution time
            if (Date.now() - startTime > this.MAX_EXECUTION_TIME) {
                console.warn('Report generation approaching timeout limit');
            }

            return results;

        } catch (error) {
            console.error('Stream sales data error:', error);
            throw error;
        }
    }

    /**
     * Initialize summary object
     */
    initializeSummary() {
        return {
            total_sales: 0,
            total_returns: 0,
            total_revenue: 0,
            total_tax: 0,
            total_discounts: 0,
            items_sold: 0,
            items_returned: 0,
            payment_methods: {},
            categories: {},
            daily_breakdown: {}
        };
    }

    /**
     * Get total count of sales with filters
     */
    async getTotalSalesCount(startDate, endDate, storeId, category_id, product_id) {
        let sql = `
            SELECT COUNT(DISTINCT s.id) as total
            FROM sales s
            LEFT JOIN sale_items si ON s.id = si.sale_id
            LEFT JOIN products p ON si.product_id = p.id
            WHERE s.sale_date BETWEEN ? AND ?
        `;

        const params = [startDate, endDate];

        if (storeId) {
            sql += ' AND s.store_id = ?';
            params.push(storeId);
        }

        if (category_id) {
            sql += ' AND p.category_id = ?';
            params.push(category_id);
        }

        if (product_id) {
            sql += ' AND si.product_id = ?';
            params.push(product_id);
        }

        const result = await executeWithRetry(sql, params);
        return result[0]?.total || 0;
    }

    /**
     * Get sales batch with pagination
     */
    async getSalesBatch(startDate, endDate, storeId, offset, limit, category_id, product_id) {
        let sql = `
            SELECT 
                s.id, s.invoice_no, s.receipt_no, 
                s.total_amount, s.subtotal, s.tax_amount, s.discount_amount,
                s.payment_method, s.payments_breakdown,
                s.sale_date, s.created_at, s.updated_at,
                u.id as cashier_id, u.full_name as cashier_name,
                c.id as customer_id, c.name as customer_name,
                st.id as store_id, st.store_number, st.store_location,
                GROUP_CONCAT(
                    JSON_OBJECT(
                        'id', si.id,
                        'product_id', si.product_id,
                        'quantity', si.quantity,
                        'unit_price', si.unit_price,
                        'total_price', si.total_price,
                        'product_name', p.name,
                        'product_class_code', p.product_class_code,
                        'category_id', cat.id,
                        'category_name', cat.name
                    )
                ) as items_json
            FROM sales s
            LEFT JOIN users u ON s.user_id = u.id
            LEFT JOIN customers c ON s.customer_id = c.id
            LEFT JOIN stores st ON s.store_id = st.id
            LEFT JOIN sale_items si ON s.id = si.sale_id
            LEFT JOIN products p ON si.product_id = p.id
            LEFT JOIN categories cat ON p.category_id = cat.id
            WHERE s.sale_date BETWEEN ? AND ?
        `;

        const params = [startDate, endDate];

        if (storeId) {
            sql += ' AND s.store_id = ?';
            params.push(storeId);
        }

        if (category_id) {
            sql += ' AND p.category_id = ?';
            params.push(category_id);
        }

        if (product_id) {
            sql += ' AND si.product_id = ?';
            params.push(product_id);
        }

        sql += ` GROUP BY s.id ORDER BY s.sale_date DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));

        return await executeWithRetry(sql, params);
    }

    /**
     * Get returns for specific sales
     */
    async getReturnsForSales(saleIds) {
        if (!saleIds || saleIds.length === 0) return [];

        const sql = `
            SELECT 
                cn.id, cn.credit_note_number, cn.total_amount,
                cn.subtotal, cn.tax_amount, cn.discount_amount,
                cn.payment_method, cn.credit_note_date,
                cn.created_at, cn.sale_id,
                u.id as cashier_id, u.full_name as cashier_name,
                c.id as customer_id, c.name as customer_name,
                GROUP_CONCAT(
                    JSON_OBJECT(
                        'id', cni.id,
                        'product_id', cni.product_id,
                        'quantity', cni.quantity,
                        'unit_price', cni.unit_price,
                        'total_price', cni.total_price,
                        'product_name', p.name,
                        'product_class_code', p.product_class_code
                    )
                ) as items_json
            FROM credit_notes cn
            LEFT JOIN users u ON cn.user_id = u.id
            LEFT JOIN customers c ON cn.customer_id = c.id
            LEFT JOIN credit_note_items cni ON cn.id = cni.credit_note_id
            LEFT JOIN products p ON cni.product_id = p.id
            WHERE cn.sale_id IN (?)
            GROUP BY cn.id
        `;

        return await executeWithRetry(sql, [saleIds]);
    }

    /**
     * Process sales batch
     */
    async processSalesBatch(salesRows, summary) {
        const processedSales = [];

        for (const row of salesRows) {
            try {
                // Parse items JSON - handle both array and string formats
                let items = [];
                if (row.items_json) {
                    try {
                        // Remove leading/trailing commas and parse
                        const cleanJson = row.items_json.replace(/^,|,$/g, '');
                        if (cleanJson) {
                            items = JSON.parse(`[${cleanJson}]`);
                        }
                    } catch (e) {
                        // If parsing fails, try as single object
                        try {
                            const single = JSON.parse(row.items_json);
                            items = Array.isArray(single) ? single : [single];
                        } catch (e2) {
                            console.error(`Failed to parse items for sale ${row.id}:`, e2.message);
                            items = [];
                        }
                    }
                }

                // Parse payments breakdown
                let paymentsBreakdown = {};
                if (row.payments_breakdown) {
                    try {
                        paymentsBreakdown = typeof row.payments_breakdown === 'string' 
                            ? JSON.parse(row.payments_breakdown) 
                            : row.payments_breakdown;
                    } catch (e) {
                        paymentsBreakdown = {};
                    }
                }

                const saleObj = {
                    id: row.id,
                    invoice_no: row.invoice_no || '',
                    receipt_no: row.receipt_no || '',
                    total_amount: parseFloat(row.total_amount) || 0,
                    subtotal: parseFloat(row.subtotal) || 0,
                    tax_amount: parseFloat(row.tax_amount) || 0,
                    discount_amount: parseFloat(row.discount_amount) || 0,
                    payment_method: row.payment_method || 'unknown',
                    payments_breakdown: paymentsBreakdown,
                    sale_date: row.sale_date,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                    cashier: {
                        id: row.cashier_id,
                        full_name: row.cashier_name || 'System'
                    },
                    customer: {
                        id: row.customer_id,
                        name: row.customer_name || 'Walk-in Customer'
                    },
                    store: {
                        id: row.store_id,
                        number: row.store_number || '',
                        location: row.store_location || ''
                    },
                    items: items.map(item => ({
                        id: item.id,
                        product_id: item.product_id,
                        quantity: parseInt(item.quantity) || 0,
                        unit_price: parseFloat(item.unit_price) || 0,
                        total_price: parseFloat(item.total_price) || 0,
                        product: {
                            name: item.product_name || 'Unknown Product',
                            product_class_code: item.product_class_code || '',
                            category: {
                                id: item.category_id,
                                name: item.category_name || 'Uncategorized'
                            }
                        }
                    }))
                };

                processedSales.push(saleObj);
                this.updateSalesSummary(saleObj, summary);

            } catch (error) {
                console.error(`Error processing sale ${row.id}:`, error.message);
            }
        }

        return processedSales;
    }

    /**
     * Process returns batch
     */
    async processReturnsBatch(returnRows, summary) {
        const processedReturns = [];

        for (const row of returnRows) {
            try {
                // Parse items JSON
                let items = [];
                if (row.items_json) {
                    try {
                        const cleanJson = row.items_json.replace(/^,|,$/g, '');
                        if (cleanJson) {
                            items = JSON.parse(`[${cleanJson}]`);
                        }
                    } catch (e) {
                        try {
                            const single = JSON.parse(row.items_json);
                            items = Array.isArray(single) ? single : [single];
                        } catch (e2) {
                            console.error(`Failed to parse items for return ${row.id}:`, e2.message);
                            items = [];
                        }
                    }
                }

                const returnObj = {
                    id: row.id,
                    credit_note_number: row.credit_note_number || '',
                    total_amount: parseFloat(row.total_amount) || 0,
                    subtotal: parseFloat(row.subtotal) || 0,
                    tax_amount: parseFloat(row.tax_amount) || 0,
                    discount_amount: parseFloat(row.discount_amount) || 0,
                    payment_method: row.payment_method || 'unknown',
                    credit_note_date: row.credit_note_date,
                    created_at: row.created_at,
                    sale_id: row.sale_id,
                    cashier: {
                        id: row.cashier_id,
                        full_name: row.cashier_name || 'System'
                    },
                    customer: {
                        id: row.customer_id,
                        name: row.customer_name || 'Walk-in Customer'
                    },
                    items: items.map(item => ({
                        id: item.id,
                        product_id: item.product_id,
                        quantity: parseInt(item.quantity) || 0,
                        unit_price: parseFloat(item.unit_price) || 0,
                        total_price: parseFloat(item.total_price) || 0,
                        product: {
                            name: item.product_name || 'Unknown Product',
                            product_class_code: item.product_class_code || ''
                        }
                    }))
                };

                processedReturns.push(returnObj);
                this.updateReturnsSummary(returnObj, summary);

            } catch (error) {
                console.error(`Error processing return ${row.id}:`, error.message);
            }
        }

        return processedReturns;
    }

    /**
     * Update sales summary
     */
    updateSalesSummary(sale, summary) {
        summary.total_sales += 1;
        summary.total_revenue += sale.total_amount;
        summary.total_tax += sale.tax_amount;
        summary.total_discounts += sale.discount_amount;

        // Count items
        sale.items.forEach(item => {
            summary.items_sold += item.quantity;
        });

        // Payment methods
        const payments = sale.payments_breakdown || {};
        if (Object.keys(payments).length > 0) {
            Object.entries(payments).forEach(([method, amount]) => {
                const key = method.toString().toLowerCase();
                summary.payment_methods[key] = (summary.payment_methods[key] || 0) + parseFloat(amount || 0);
            });
        } else if (sale.payment_method) {
            const key = sale.payment_method.toString().toLowerCase();
            summary.payment_methods[key] = (summary.payment_methods[key] || 0) + sale.total_amount;
        }

        // Categories
        sale.items.forEach(item => {
            const catId = item.product?.category?.id || 'uncategorized';
            const catName = item.product?.category?.name || 'Uncategorized';

            if (!summary.categories[catId]) {
                summary.categories[catId] = {
                    category_id: catId,
                    category_name: catName,
                    items_quantity: 0,
                    revenue: 0,
                    transaction_count: 0
                };
            }
            summary.categories[catId].items_quantity += item.quantity;
            summary.categories[catId].revenue += item.total_price;
            summary.categories[catId].transaction_count += 1;
        });

        // Daily breakdown
        const dateKey = sale.sale_date ? new Date(sale.sale_date).toISOString().split('T')[0] : 'unknown';
        if (!summary.daily_breakdown[dateKey]) {
            summary.daily_breakdown[dateKey] = {
                date: dateKey,
                sales_count: 0,
                revenue: 0,
                tax: 0
            };
        }
        summary.daily_breakdown[dateKey].sales_count += 1;
        summary.daily_breakdown[dateKey].revenue += sale.total_amount;
        summary.daily_breakdown[dateKey].tax += sale.tax_amount;
    }

    /**
     * Update returns summary
     */
    updateReturnsSummary(returnObj, summary) {
        summary.total_returns += 1;
        summary.total_revenue -= returnObj.total_amount;
        summary.total_tax -= returnObj.tax_amount;
        summary.total_discounts -= returnObj.discount_amount;

        returnObj.items.forEach(item => {
            summary.items_returned += item.quantity;
        });

        // Payment methods (negative for returns)
        if (returnObj.payment_method) {
            const key = returnObj.payment_method.toString().toLowerCase();
            summary.payment_methods[key] = (summary.payment_methods[key] || 0) - returnObj.total_amount;
        }
    }

    /**
     * Generate Excel report
     */
    async generateExcelReport(reportType, data, startDate, endDate) {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet(`${reportType.toUpperCase()} Report`);

        // Setup worksheet
        this.setupWorksheet(worksheet, reportType, startDate, endDate);

        // Get data based on report type
        let dataArray = [];
        let summary = null;

        switch (reportType) {
            case 'sales':
                dataArray = data.sales || [];
                summary = data.summary || null;
                break;
            case 'products':
                dataArray = data.products || [];
                break;
            case 'inventory':
                dataArray = data.inventories || [];
                break;
            case 'returns':
                dataArray = data.returns || [];
                summary = data.summary || null;
                break;
            default:
                dataArray = data;
        }

        // Process data in chunks
        const chunkSize = 500;
        for (let i = 0; i < dataArray.length; i += chunkSize) {
            const chunk = dataArray.slice(i, i + chunkSize);
            const rows = chunk.map(item => this.formatRowForExcel(reportType, item));
            
            // Add rows to worksheet
            rows.forEach(row => {
                worksheet.addRow(row);
            });

            // Apply formatting to rows
            const startRow = worksheet.rowCount - rows.length + 1;
            for (let j = 0; j < rows.length; j++) {
                const rowIndex = startRow + j;
                this.formatRow(worksheet.getRow(rowIndex), reportType);
            }
        }

        // Add summary if available
        if (summary) {
            this.addSummarySection(worksheet, summary, reportType);
        }

        return workbook;
    }

    /**
     * Setup worksheet with headers and styling
     */
    setupWorksheet(worksheet, reportType, startDate, endDate) {
        // Title
        worksheet.mergeCells('A1:G1');
        const titleCell = worksheet.getCell('A1');
        titleCell.value = `${reportType.toUpperCase()} REPORT`;
        titleCell.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
        titleCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4472C4' }
        };
        titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
        worksheet.getRow(1).height = 35;

        // Date range
        worksheet.mergeCells('A2:G2');
        const dateCell = worksheet.getCell('A2');
        dateCell.value = `Period: ${new Date(startDate).toLocaleDateString()} - ${new Date(endDate).toLocaleDateString()}`;
        dateCell.font = { size: 12 };
        dateCell.alignment = { horizontal: 'center' };
        dateCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF0F0F0' }
        };
        worksheet.getRow(2).height = 25;

        worksheet.addRow([]);

        // Headers
        const columns = this.getReportColumns(reportType);
        worksheet.columns = columns;

        const headerRow = worksheet.getRow(4);
        headerRow.eachCell((cell) => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
            cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF4472C4' }
            };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
            cell.border = {
                top: { style: 'thin' },
                left: { style: 'thin' },
                bottom: { style: 'thin' },
                right: { style: 'thin' }
            };
        });
        headerRow.height = 25;
    }

    /**
     * Get column definitions for report type
     */
    getReportColumns(reportType) {
        const columnMap = {
            sales: [
                { header: 'Sale ID', key: 'id', width: 12 },
                { header: 'Invoice No', key: 'invoice_no', width: 20 },
                { header: 'Receipt No', key: 'receipt_no', width: 20 },
                { header: 'Total Amount', key: 'total_amount', width: 15 },
                { header: 'Subtotal', key: 'subtotal', width: 15 },
                { header: 'Tax', key: 'tax_amount', width: 12 },
                { header: 'Discount', key: 'discount_amount', width: 12 },
                { header: 'Payment Method', key: 'payment_method', width: 15 },
                { header: 'Cashier', key: 'cashier_name', width: 20 },
                { header: 'Customer', key: 'customer_name', width: 20 },
                { header: 'Store', key: 'store_name', width: 20 },
                { header: 'Items', key: 'items_count', width: 10 },
                { header: 'Date', key: 'sale_date', width: 20 }
            ],
            products: [
                { header: 'Product ID', key: 'product_id', width: 12 },
                { header: 'Product Name', key: 'product_name', width: 30 },
                { header: 'Category', key: 'category_name', width: 20 },
                { header: 'Classification', key: 'product_class_code', width: 15 },
                { header: 'Unit Price', key: 'unit_price', width: 12 },
                { header: 'Total Sold', key: 'total_sold', width: 12 },
                { header: 'Total Revenue', key: 'total_revenue', width: 15 }
            ],
            inventory: [
                { header: 'Product ID', key: 'product_id', width: 12 },
                { header: 'Product Name', key: 'product_name', width: 30 },
                { header: 'Category', key: 'category_name', width: 20 },
                { header: 'Stock Qty', key: 'stock_quantity', width: 12 },
                { header: 'Min Stock', key: 'min_stock_level', width: 12 },
                { header: 'Status', key: 'stock_status', width: 15 },
                { header: 'Last Updated', key: 'last_updated', width: 20 }
            ],
            returns: [
                { header: 'Return ID', key: 'id', width: 12 },
                { header: 'Credit Note', key: 'credit_note_number', width: 20 },
                { header: 'Total Amount', key: 'total_amount', width: 15 },
                { header: 'Subtotal', key: 'subtotal', width: 15 },
                { header: 'Tax', key: 'tax_amount', width: 12 },
                { header: 'Payment Method', key: 'payment_method', width: 15 },
                { header: 'Cashier', key: 'cashier_name', width: 20 },
                { header: 'Items', key: 'items_count', width: 10 },
                { header: 'Date', key: 'credit_note_date', width: 20 }
            ]
        };

        return columnMap[reportType] || columnMap.sales;
    }

    /**
     * Format row data for Excel
     */
    formatRowForExcel(reportType, data) {
        const formats = {
            sales: () => ({
                id: data.id || '',
                invoice_no: data.invoice_no || '',
                receipt_no: data.receipt_no || '',
                total_amount: data.total_amount || 0,
                subtotal: data.subtotal || 0,
                tax_amount: data.tax_amount || 0,
                discount_amount: data.discount_amount || 0,
                payment_method: data.payment_method || '',
                cashier_name: data.cashier?.full_name || '',
                customer_name: data.customer?.name || '',
                store_name: data.store?.number || data.store?.location || '',
                items_count: data.items?.length || 0,
                sale_date: data.sale_date ? new Date(data.sale_date) : null
            }),
            products: () => ({
                product_id: data.product_id || '',
                product_name: data.product_name || '',
                category_name: data.category_name || '',
                product_class_code: data.product_class_code || '',
                unit_price: data.unit_price || 0,
                total_sold: data.total_sold || 0,
                total_revenue: data.total_revenue || 0
            }),
            inventory: () => ({
                product_id: data.product_id || '',
                product_name: data.product_name || '',
                category_name: data.category_name || '',
                stock_quantity: data.stock_quantity || 0,
                min_stock_level: data.min_stock_level || 0,
                stock_status: data.stock_status || 'In Stock',
                last_updated: data.updated_at ? new Date(data.updated_at) : null
            }),
            returns: () => ({
                id: data.id || '',
                credit_note_number: data.credit_note_number || '',
                total_amount: data.total_amount || 0,
                subtotal: data.subtotal || 0,
                tax_amount: data.tax_amount || 0,
                payment_method: data.payment_method || '',
                cashier_name: data.cashier?.full_name || '',
                items_count: data.items?.length || 0,
                credit_note_date: data.credit_note_date ? new Date(data.credit_note_date) : null
            })
        };

        const formatFn = formats[reportType] || formats.sales;
        return formatFn();
    }

    /**
     * Format row styling
     */
    formatRow(row, reportType) {
        row.eachCell((cell, colNumber) => {
            // Add borders
            cell.border = {
                top: { style: 'thin', color: { argb: 'FFD3D3D3' } },
                left: { style: 'thin', color: { argb: 'FFD3D3D3' } },
                bottom: { style: 'thin', color: { argb: 'FFD3D3D3' } },
                right: { style: 'thin', color: { argb: 'FFD3D3D3' } }
            };

            // Format currency columns
            const currencyKeys = ['total_amount', 'subtotal', 'tax_amount', 'discount_amount', 
                                 'unit_price', 'total_revenue', 'total'];
            const header = row.worksheet.getRow(4).getCell(colNumber).value;
            if (header && currencyKeys.some(key => header.includes(key))) {
                if (typeof cell.value === 'number') {
                    cell.numFmt = '"$"#,##0.00';
                    cell.alignment = { horizontal: 'right' };
                }
            }

            // Format date columns
            if (header && (header.includes('Date') || header.includes('Updated'))) {
                if (cell.value instanceof Date) {
                    cell.numFmt = 'yyyy-mm-dd hh:mm:ss';
                }
            }

            // Center align ID columns
            if (header && (header.includes('ID') || header.includes('No'))) {
                cell.alignment = { horizontal: 'center' };
            }
        });
    }

    /**
     * Add summary section to Excel
     */
    addSummarySection(worksheet, summary, reportType) {
        worksheet.addRow([]);
        worksheet.addRow([]);

        // Summary title
        const summaryRow = worksheet.addRow(['SUMMARY']);
        summaryRow.getCell(1).font = { bold: true, size: 14 };
        worksheet.mergeCells(`A${worksheet.rowCount}:F${worksheet.rowCount}`);

        // Add summary data
        const summaryData = [
            ['Total Sales', summary.total_sales || 0],
            ['Total Returns', summary.total_returns || 0],
            ['Net Revenue', summary.total_revenue || 0],
            ['Total Tax', summary.total_tax || 0],
            ['Total Discounts', summary.total_discounts || 0],
            ['Items Sold', summary.items_sold || 0],
            ['Items Returned', summary.items_returned || 0],
            ['Net Items', (summary.items_sold || 0) - (summary.items_returned || 0)]
        ];

        summaryData.forEach(([label, value]) => {
            const row = worksheet.addRow([label, value]);
            row.getCell(1).font = { bold: true };
            if (typeof value === 'number') {
                row.getCell(2).numFmt = '"$"#,##0.00';
                row.getCell(2).alignment = { horizontal: 'right' };
            }
        });

        // Payment methods breakdown
        if (summary.payment_methods && Object.keys(summary.payment_methods).length > 0) {
            worksheet.addRow([]);
            const paymentRow = worksheet.addRow(['PAYMENT METHODS BREAKDOWN']);
            paymentRow.getCell(1).font = { bold: true, size: 12 };
            worksheet.mergeCells(`A${worksheet.rowCount}:F${worksheet.rowCount}`);

            Object.entries(summary.payment_methods).forEach(([method, amount]) => {
                if (Math.abs(amount) > 0.01) { // Only show non-zero amounts
                    const row = worksheet.addRow([method.toUpperCase(), amount]);
                    row.getCell(1).font = { bold: true };
                    row.getCell(2).numFmt = '"$"#,##0.00';
                    row.getCell(2).alignment = { horizontal: 'right' };
                }
            });
        }

        // Apply styling to summary
        const startRow = worksheet.rowCount - summaryData.length - 2;
        for (let i = startRow; i <= worksheet.rowCount; i++) {
            const row = worksheet.getRow(i);
            row.eachCell((cell) => {
                cell.border = {
                    top: { style: 'thin' },
                    left: { style: 'thin' },
                    bottom: { style: 'thin' },
                    right: { style: 'thin' }
                };
            });
        }
    }

    /**
     * Get report data from cache or generate
     */
    async getCachedOrGenerate(cacheKey, generateFn) {
        const cached = reportCache.get(cacheKey);
        if (cached) {
            console.log('Returning cached report data');
            return cached;
        }

        const data = await generateFn();
        reportCache.set(cacheKey, data, this.CACHE_DURATION);
        return data;
    }

    /**
     * Clear cache for a specific report
     */
    clearCache(reportType, userId, params) {
        const key = `${reportType}_${userId}_${JSON.stringify(params)}`;
        reportCache.del(key);
    }

    /**
     * Clear all cache
     */
    clearAllCache() {
        reportCache.flushAll();
    }
}

module.exports = new LargeDatasetReportService();