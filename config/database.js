// const mysql = require('mysql2/promise');

// // Create connection pool (recommended for production)
// const pool = mysql.createPool({
//     host: 'localhost',
//     user: 'root',
//     password: 'root',
//     database: 'pos_backend',
//     port: '3306',

//     waitForConnections: true,
//     connectionLimit: 10,
//     queueLimit: 0,

// });



// // Test connection
// async function testConnection() {
//     try {
//         const [rows] = await pool.query('SELECT 1 as test');
//         console.log('✅ Database connected successfully');
//         return true;
//     } catch (error) {
//         console.error('❌ Database connection failed:', error.message);
//         return false;
//     }
// }
// module.exports = { pool, testConnection };






const mysql = require('mysql2/promise');

// Create connection pool with optimized settings for large datasets
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_NAME || 'pos_backend',
    port: process.env.DB_PORT || 3306,

    // Connection pool settings
    waitForConnections: true,
    connectionLimit: 20, // Increased for large datasets
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,

    // Timeout settings
    connectTimeout: 60000, // 60 seconds
    acquireTimeout: 60000,

    // For large queries
    maxAllowedPacket: 256 * 1024 * 1024, // 256MB

    // Support for big numbers
    supportBigNumbers: true,
    bigNumberStrings: true,

    // Timezone
    timezone: '+00:00'
});

// Query with timeout support
async function queryWithTimeout(sql, params, timeout = 300000) {
    const connection = await pool.getConnection();
    try {
        const [rows] = await connection.query({
            sql,
            values: params,
            timeout: timeout // 5 minutes default
        });
        return rows;
    } finally {
        connection.release();
    }
}

// Test connection
async function testConnection() {
    try {
        const [rows] = await pool.query('SELECT 1 as test');
        console.log('✅ Database connected successfully');
        return true;
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        return false;
    }
}

// Execute query with retry logic
async function executeWithRetry(sql, params, maxRetries = 3, timeout = 300000) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await queryWithTimeout(sql, params, timeout);
        } catch (error) {
            lastError = error;
            console.error(`Query attempt ${attempt} failed:`, error.message);
            
            if (attempt < maxRetries) {
                // Exponential backoff
                const delay = 1000 * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    throw lastError;
}

// Get total count with filters
async function getTotalCount(table, whereClause, params) {
    const sql = `SELECT COUNT(*) as total FROM ${table} ${whereClause}`;
    const result = await pool.query(sql, params);
    return result[0]?.total || 0;
}

// Streaming query - returns a readable stream
async function streamQuery(sql, params) {
    const connection = await pool.getConnection();
    const stream = connection.query(sql, params).stream();
    
    // Handle errors
    stream.on('error', (error) => {
        console.error('Stream error:', error);
        connection.release();
    });
    
    stream.on('end', () => {
        connection.release();
    });
    
    return stream;
}

module.exports = {
    pool,
    testConnection,
    queryWithTimeout,
    executeWithRetry,
    getTotalCount,
    streamQuery
};