const fs = require('fs');
const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');

// Properly configured Sequelize instance
const sequelize = new Sequelize('pos_backend', 'sa', 'Admin123', {
    host: 'localhost',
    dialect: 'mysql',
    logging: console.log, // Add logging to see SQL queries
});

const db = {};

// First: Load all models
fs.readdirSync(__dirname)
    .filter(file => file !== 'index.js' && file.endsWith('.js'))
    .forEach(file => {
        console.log(`Loading model: ${file}`);
        try {
            const modelDef = require(path.join(__dirname, file));
            
            let model;
            if (typeof modelDef === 'function') {
                model = modelDef(sequelize, DataTypes);
            } else if (modelDef.default && typeof modelDef.default === 'function') {
                model = modelDef.default(sequelize, DataTypes);
            } else {
                model = modelDef;
            }
            
            db[model.name] = model;
            console.log(`Model ${model.name} loaded successfully`);
        } catch (error) {
            console.error(`Error loading model ${file}:`, error);
        }
    });

// Second: Setup associations after all models are loaded
Object.keys(db).forEach(modelName => {
    if (db[modelName].associate) {
        console.log(`Setting up associations for ${modelName}`);
        try {
            db[modelName].associate(db);
        } catch (error) {
            console.error(`Error setting up associations for ${modelName}:`, error);
        }
    }
});

db.sequelize = sequelize;
db.Sequelize = Sequelize;

module.exports = db;