const mysql = require('mysql2/promise');

// Create connection pool (recommended for production)
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'Admin123',
    database: 'pos_backend',
    port: '3306',

    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,

});



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
module.exports = { pool, testConnection };