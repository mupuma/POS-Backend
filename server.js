const app = require('./app');
const db = require('./models');

const PORT = process.env.PORT || 3000;

// Sync database and start server
db.sequelize.sync()
    .then(() => {
        console.log('Database connected');
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    })
    .catch(err => {
        console.error('Database connection failed:', err);
    });