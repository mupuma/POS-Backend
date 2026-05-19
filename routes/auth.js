const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const { user, store } = require('../models');
const auth = require('../middleware/auth');
const { buildActorFromUser, buildTargetFromUser, logRequestAudit } = require('../services/auditLogService');

const router = express.Router();

function getModels(req) {
    return req.app.locals.models || require('../models');
}

// Register new user (admin only)
router.post('/register', auth, async (req, res) => {
    try {
        const models = getModels(req);
        const { username, password, full_name, role } = req.body;

        // Check if user is admin
        if (req.user.role !== 'admin') {
            await logRequestAudit(models, req, {
                action: 'user.create',
                outcome: 'failure',
                entityType: 'user',
                ...buildActorFromUser(req.user),
                target_identifier: username || null,
                target_name: full_name || null,
                details: { reason: 'Only admins can create users' },
            });
            return res.status(403).json({ message: 'Only admins can create users' });
        }

        // Check if user already exists
        const existingUser = await user.findOne({ where: { username } });
        if (existingUser) {
            await logRequestAudit(models, req, {
                action: 'user.create',
                outcome: 'failure',
                entityType: 'user',
                ...buildActorFromUser(req.user),
                ...buildTargetFromUser(existingUser),
                details: { reason: 'Username already exists' },
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

        await logRequestAudit(models, req, {
            action: 'user.create',
            outcome: 'success',
            entityType: 'user',
            ...buildActorFromUser(req.user),
            ...buildTargetFromUser(newUser),
            details: { role: newUser.role },
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
        const models = getModels(req);
        const { username, password } = req.body;

        // Validate input
        if (!username || !password) {
            await logRequestAudit(models, req, {
                action: 'auth.login',
                outcome: 'failure',
                entityType: 'auth',
                target_identifier: username || null,
                details: { reason: 'Username and password are required' },
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
            await logRequestAudit(models, req, {
                action: 'auth.login',
                outcome: 'failure',
                entityType: 'auth',
                target_identifier: username,
                details: { reason: 'Invalid credentials' },
            });
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Check password
        const isMatch = await bcrypt.compare(password, foundUser.password_hash);
        if (!isMatch) {
            await logRequestAudit(models, req, {
                action: 'auth.login',
                outcome: 'failure',
                entityType: 'auth',
                ...buildTargetFromUser(foundUser),
                details: { reason: 'Invalid credentials' },
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

        await logRequestAudit(models, req, {
            action: 'auth.login',
            outcome: 'success',
            entityType: 'auth',
            ...buildActorFromUser(foundUser),
            ...buildTargetFromUser(foundUser),
            details: { store_id: foundUser.store_id || null },
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

router.get('/audit-logs', auth, async (req, res) => {
    try {
        const models = getModels(req);

        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Only admins can view audit logs' });
        }

        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = (page - 1) * limit;
        const where = {};

        if (req.query.action) {
            where.action = req.query.action;
        }

        if (req.query.outcome) {
            where.outcome = req.query.outcome;
        }

        if (req.query.username) {
            where[Op.or] = [
                { actor_identifier: { [Op.like]: `%${req.query.username}%` } },
                { target_identifier: { [Op.like]: `%${req.query.username}%` } },
            ];
        }

        if (req.query.startDate || req.query.endDate) {
            where.occurred_at = {};
            if (req.query.startDate) {
                where.occurred_at[Op.gte] = new Date(req.query.startDate);
            }
            if (req.query.endDate) {
                where.occurred_at[Op.lte] = new Date(req.query.endDate);
            }
        }

        const { count, rows } = await models.auditLog.findAndCountAll({
            where,
            order: [['occurred_at', 'DESC'], ['id', 'DESC']],
            limit,
            offset,
        });

        return res.json({
            success: true,
            logs: rows,
            pagination: {
                current_page: page,
                total_pages: Math.max(Math.ceil(count / limit), 1),
                total_records: count,
                per_page: limit,
            },
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error' });
    }
});

router.post('/verify-admin', auth, async (req, res) => {
    try {
        const models = getModels(req);
        const { password, username } = req.body; // or email

        // Validate input
        if (!password || !username) {
            await logRequestAudit(models, req, {
                action: 'auth.verify_admin',
                outcome: 'failure',
                entityType: 'auth',
                ...buildActorFromUser(req.user),
                target_identifier: username || null,
                details: { reason: 'Username and password are required' },
            });
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
            await logRequestAudit(models, req, {
                action: 'auth.verify_admin',
                outcome: 'failure',
                entityType: 'auth',
                ...buildActorFromUser(req.user),
                target_identifier: username,
                details: { reason: 'Invalid credentials' },
            });
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Check password
        const isMatch = await bcrypt.compare(password, foundUser.password_hash);
        if (!isMatch) {
            await logRequestAudit(models, req, {
                action: 'auth.verify_admin',
                outcome: 'failure',
                entityType: 'auth',
                ...buildActorFromUser(req.user),
                ...buildTargetFromUser(foundUser),
                details: { reason: 'Invalid credentials' },
            });
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        await logRequestAudit(models, req, {
            action: 'auth.verify_admin',
            outcome: 'success',
            entityType: 'auth',
            ...buildActorFromUser(req.user),
            ...buildTargetFromUser(foundUser),
        });

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
        const models = getModels(req);
        const { current_password, new_password } = req.body;

        if (!current_password || !new_password) {
            await logRequestAudit(models, req, {
                action: 'user.change_password',
                outcome: 'failure',
                entityType: 'user',
                ...buildActorFromUser(req.user),
                ...buildTargetFromUser(req.user),
                details: { reason: 'Both current and new passwords are required' },
            });
            return res.status(400).json({ message: 'Both current and new passwords are required' });
        }

        // Verify current password
        const isMatch = await bcrypt.compare(current_password, req.user.password_hash);
        if (!isMatch) {
            await logRequestAudit(models, req, {
                action: 'user.change_password',
                outcome: 'failure',
                entityType: 'user',
                ...buildActorFromUser(req.user),
                ...buildTargetFromUser(req.user),
                details: { reason: 'Current password is incorrect' },
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

        await logRequestAudit(models, req, {
            action: 'user.change_password',
            outcome: 'success',
            entityType: 'user',
            ...buildActorFromUser(req.user),
            ...buildTargetFromUser(req.user),
        });

        res.json({ message: 'Password changed successfully' });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;