const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { user, store } = require('../models');
const auth = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// Register new user (admin only)
router.post('/register', auth, async (req, res) => {
    const startedAt = new Date();
    const siteId = process.env.SITE_ID || 'unknown-site';

    try {
        const { username, password, full_name, role } = req.body;

        logger.info('user_registration_started', {
            siteId,
            requestingUserId: req.user?.id,
            requestingUserRole: req.user?.role,
            newUsername: username,
            newUserRole: role || 'cashier',
            startedAt
        });

        // Check if user is admin
        if (req.user.role !== 'admin') {
            logger.warn('user_registration_unauthorized', {
                siteId,
                requestingUserId: req.user?.id,
                requestingUserRole: req.user?.role,
                attemptedUsername: username
            });
            return res.status(403).json({ message: 'Only admins can create users' });
        }

        // Check if user already exists
        const existingUser = await user.findOne({ where: { username } });
        if (existingUser) {
            logger.warn('user_registration_duplicate', {
                siteId,
                username,
                requestingUserId: req.user?.id
            });
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

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('user_registration_completed', {
            siteId,
            newUserId: newUser.id,
            newUsername: newUser.username,
            newUserRole: newUser.role,
            requestingUserId: req.user?.id,
            durationMs
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
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('user_registration_error', {
            siteId,
            requestingUserId: req.user?.id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

// Login
router.post('/login', async (req, res) => {
    const startedAt = new Date();
    const siteId = process.env.SITE_ID || 'unknown-site';

    try {
        const { username, password } = req.body;

        logger.info('login_attempt', {
            siteId,
            username,
            startedAt
        });

        // Validate input
        if (!username || !password) {
            logger.warn('login_missing_credentials', {
                siteId,
                hasUsername: !!username,
                hasPassword: !!password
            });
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
            logger.warn('login_user_not_found', {
                siteId,
                username
            });
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Check password
        const isMatch = await bcrypt.compare(password, foundUser.password_hash);
        if (!isMatch) {
            logger.warn('login_invalid_password', {
                siteId,
                username,
                userId: foundUser.id
            });
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

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('login_success', {
            siteId,
            userId: foundUser.id,
            username: foundUser.username,
            role: foundUser.role,
            storeId: foundUser.store_id,
            durationMs
        });

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
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('login_error', {
            siteId,
            username: req.body?.username,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

// Get current user info
router.get('/me', auth, async (req, res) => {
    const startedAt = new Date();
    const siteId = process.env.SITE_ID || 'unknown-site';

    try {
        logger.info('get_user_info', {
            siteId,
            userId: req.user?.id,
            username: req.user?.username
        });

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('get_user_info_completed', {
            siteId,
            userId: req.user?.id,
            durationMs
        });

        res.json({
            user: {
                id: req.user.id,
                username: req.user.username,
                full_name: req.user.full_name,
                role: req.user.role
            }
        });
    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('get_user_info_error', {
            siteId,
            userId: req.user?.id,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

router.post('/verify-admin', auth, async (req, res) => {
    const startedAt = new Date();
    const siteId = process.env.SITE_ID || 'unknown-site';

    try {
        const { password, username } = req.body;

        logger.info('admin_verification_started', {
            siteId,
            requestingUserId: req.user?.id,
            adminUsername: username,
            startedAt
        });

        // Validate input
        if (!password || !username) {
            logger.warn('admin_verification_missing_credentials', {
                siteId,
                requestingUserId: req.user?.id,
                hasUsername: !!username,
                hasPassword: !!password
            });
            return res.status(400).json({ message: 'Username and password are required' });
        }

        // Find the admin user
        const foundUser = await user.findOne({
            where: {
                username: username,
                is_active: true,
                role: 'admin'
            }
        });

        if (!foundUser) {
            logger.warn('admin_verification_user_not_found', {
                siteId,
                requestingUserId: req.user?.id,
                adminUsername: username
            });
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Check password
        const isMatch = await bcrypt.compare(password, foundUser.password_hash);
        if (!isMatch) {
            logger.warn('admin_verification_invalid_password', {
                siteId,
                requestingUserId: req.user?.id,
                adminUsername: username,
                adminUserId: foundUser.id
            });
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('admin_verification_success', {
            siteId,
            requestingUserId: req.user?.id,
            adminUserId: foundUser.id,
            adminUsername: foundUser.username,
            durationMs
        });

        // Send success response
        return res.status(200).json({
            message: 'Admin verified successfully',
            isAdmin: true,
            success: true,
        });

    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('admin_verification_error', {
            siteId,
            requestingUserId: req.user?.id,
            adminUsername: req.body?.username,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

// Change password
router.put('/change-password', auth, async (req, res) => {
    const startedAt = new Date();
    const siteId = process.env.SITE_ID || 'unknown-site';

    try {
        const { current_password, new_password } = req.body;

        logger.info('password_change_started', {
            siteId,
            userId: req.user?.id,
            username: req.user?.username,
            startedAt
        });

        if (!current_password || !new_password) {
            logger.warn('password_change_missing_fields', {
                siteId,
                userId: req.user?.id,
                hasCurrentPassword: !!current_password,
                hasNewPassword: !!new_password
            });
            return res.status(400).json({ message: 'Both current and new passwords are required' });
        }

        // Verify current password
        const isMatch = await bcrypt.compare(current_password, req.user.password_hash);
        if (!isMatch) {
            logger.warn('password_change_invalid_current', {
                siteId,
                userId: req.user?.id,
                username: req.user?.username
            });
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

        const durationMs = Date.now() - startedAt.getTime();
        logger.info('password_change_completed', {
            siteId,
            userId: req.user?.id,
            username: req.user?.username,
            durationMs
        });

        res.json({ message: 'Password changed successfully' });

    } catch (error) {
        const durationMs = Date.now() - startedAt.getTime();
        logger.error('password_change_error', {
            siteId,
            userId: req.user?.id,
            username: req.user?.username,
            error: error.message,
            stack: error.stack,
            durationMs
        });
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;