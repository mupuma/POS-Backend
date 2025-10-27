const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { user, store } = require('../models');
const auth = require('../middleware/auth');

const router = express.Router();

// Register new user (admin only)
router.post('/register', auth, async (req, res) => {
    try {
        const { username, password, full_name, role } = req.body;

        // Check if user is admin
        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Only admins can create users' });
        }

        // Check if user already exists
        const existingUser = await user.findOne({ where: { username } });
        if (existingUser) {
            return res.status(400).json({ message: 'Username already exists' });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        // Create user
        const newUser = await user.create({
            username,
            password_hash,
            full_name,
            role: role || 'cashier'
        });

        res.status(201).json({
            message: 'User created successfully',
            user: {
                id: newUser.id,
                username: newUser.username,
                full_name: newUser.full_name,
                role: newUser.role
            }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Login
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Validate input
        if (!username || !password) {
            return res.status(400).json({ message: 'Username and password are required' });
        }

        // Find user with store information
        const foundUser = await user.findOne({
            where: {
                username,
                is_active: true
            },
            include: [{
                model: store,
                attributes: ['id', 'store_location', 'store_mobile_no', 'store_number']
            }]
        });

        if (!foundUser) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Check password
        const isMatch = await bcrypt.compare(password, foundUser.password_hash);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Create JWT token
        const payload = {
            id: foundUser.id,
            username: foundUser.username,
            role: foundUser.role,
            store_id: foundUser.store_id
        };

        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '24h' });

        res.json({
            message: 'Login successful',
            token,
            user: {
                id: foundUser.id,
                username: foundUser.username,
                full_name: foundUser.full_name,
                role: foundUser.role,
                store_id: foundUser.store_id,
                store: foundUser.store ? {
                    id: foundUser.store.id,
                    store_location: foundUser.store.store_location,
                    store_mobile_no: foundUser.store.store_mobile_no,
                    store_number: foundUser.store.store_number
                } : null
            }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get current user info
router.get('/me', auth, async (req, res) => {
    try {
        res.json({
            user: {
                id: req.user.id,
                username: req.user.username,
                full_name: req.user.full_name,
                role: req.user.role
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

router.post('/verify-admin', auth, async (req, res) => {
    try {
        const { password, username } = req.body; // or email

        // Validate input
        if (!password || !username) {
            return res.status(400).json({ message: 'Username and password are required' });
        }

        // Find the admin user
        const foundUser = await user.findOne({
            where: {
                username: username, // or email: email
                is_active: true,
                role: 'admin' // Ensure they have admin privileges
            }
        });

        if (!foundUser) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Check password
        const isMatch = await bcrypt.compare(password, foundUser.password_hash);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Send success response
        return res.status(200).json({
            message: 'Admin verified successfully',
            isAdmin: true,
           success:true,

        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});
// Change password
router.put('/change-password', auth, async (req, res) => {
    try {
        const { current_password, new_password } = req.body;

        if (!current_password || !new_password) {
            return res.status(400).json({ message: 'Both current and new passwords are required' });
        }

        // Verify current password
        const isMatch = await bcrypt.compare(current_password, req.user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ message: 'Current password is incorrect' });
        }

        // Hash new password
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(new_password, salt);

        // Update password
        await user.update(
            { password_hash },
            { where: { id: req.user.id } }
        );

        res.json({ message: 'Password changed successfully' });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;