const fs = require('fs');
const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');
const config = require('../config/config.json');

const env = process.env.NODE_ENV || 'development';
const dbConfig = config[env];

const sequelize = new Sequelize(
    process.env.DB_NAME || dbConfig.database,
    process.env.DB_USER || dbConfig.username,
    process.env.DB_PASSWORD || dbConfig.password,
    {
        host: process.env.DB_HOST || dbConfig.host,
        dialect: dbConfig.dialect,
        port: process.env.DB_PORT || dbConfig.port,
        logging: false,
        pool: {
            max: Number(process.env.DB_POOL_MAX || 15),
            min: Number(process.env.DB_POOL_MIN || 2),
            acquire: Number(process.env.DB_POOL_ACQUIRE_MS || 30000),
            idle: Number(process.env.DB_POOL_IDLE_MS || 10000),
        },
    }
);

const db = {};

// Load models
fs.readdirSync(__dirname)
    .filter(file => file !== 'index.js' && file.endsWith('.js'))
    .forEach(file => {
        const model = require(path.join(__dirname, file))(sequelize, DataTypes);
        db[model.name] = model;
    });

// Setup associations
Object.keys(db).forEach(modelName => {
    if (db[modelName].associate) {
        db[modelName].associate(db);
    }
});

db.sequelize = sequelize;
db.Sequelize = Sequelize;

module.exports = db;
