const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/discounts', require('./routes/discounts'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/users', require('./routes/users'));

app.get('/', (req, res) => {
  res.json({ message: 'POS API is running!' });
});

module.exports = app;