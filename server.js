const app = require('./app');
const db = require('./models');

const PORT = process.env.PORT || 3000;

// Sync database and start server
db.sequelize.sync()
    .then(() => {
        console.log('Database connected');
        const server = app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });

        // Graceful shutdown
        process.on('SIGINT', () => {
            console.log('Shutting down gracefully...');
            server.close(() => {
                console.log('Server closed');
                db.sequelize.close().then(() => {
                    console.log('Database connection closed');
                    process.exit(0);
                });
            });
        });
    })
    .catch(err => {
        console.error('Database connection failed:', err);
        process.exit(1);
    });