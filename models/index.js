const fs = require('fs');
const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');

// Properly configured Sequelize instance
const sequelize = new Sequelize('pos_backend', 'sa', 'Admin123', {
    host: 'localhost',
    dialect: 'mysql',
    // Add additional options like pool configuration if needed
});

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