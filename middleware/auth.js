const jwt = require('jsonwebtoken');
const { user } = require('../models');

module.exports = async (req, res, next) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '');

        if (!token) {
            return res.status(401).json({ message: 'Access denied' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const foundUser = await user.findByPk(decoded.id);
        if (!foundUser) {
            return res.status(401).json({ message: 'Invalid token' });
        }
        req.user = foundUser;
        next();
    } catch (error) {
        res.status(401).json({ message: 'Invalid token' });
    }
};