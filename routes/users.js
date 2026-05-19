const express = require('express');
const bcrypt = require('bcryptjs');
const { user, sale } = require('../models');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');
const { buildActorFromUser, buildTargetFromUser, logRequestAudit } = require('../services/auditLogService');

const router = express.Router();

function getModels(req) {
  return req.app.locals.models || require('../models');
}

// Get all users (admin only)
router.get('/', auth, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can view all users' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const role = req.query.role;
    const active_only = req.query.active_only === 'true';

    // Build where clause
    const whereClause = {};

    if (search) {
      whereClause[Op.or] = [
        { username: { [Op.like]: `%${search}%` } },
        { full_name: { [Op.like]: `%${search}%` } }
      ];
    }

    if (role) {
      whereClause.role = role;
    }

    if (active_only) {
      whereClause.is_active = true;
    }

    const { count, rows } = await user.findAndCountAll({
      where: whereClause,
      limit,
      offset,
      order: [['created_at', 'DESC']],
      attributes: { exclude: ['password_hash'] } // Don't return password
    });

    res.json({
      users: rows,
      pagination: {
        current_page: page,
        total_pages: Math.ceil(count / limit),
        total_records: count,
        per_page: limit
      }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get user by ID (admin only or own profile)
router.get('/:id', auth, async (req, res) => {
  try {
    const requestedUserId = parseInt(req.params.id);

    // Check if user is admin or requesting own profile
    if (req.user.role !== 'admin' && req.user.id !== requestedUserId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const userData = await user.findByPk(requestedUserId, {
      attributes: { exclude: ['password_hash'] }
    });

    if (!userData) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({ user: userData });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update user (admin only or own profile for limited fields)
router.put('/:id', auth, async (req, res) => {
  try {
    const models = getModels(req);
    const requestedUserId = parseInt(req.params.id);
    const isAdmin = req.user.role === 'admin';
    const isOwnProfile = req.user.id === requestedUserId;

    if (!isAdmin && !isOwnProfile) {
      await logRequestAudit(models, req, {
        action: 'user.update',
        outcome: 'failure',
        entityType: 'user',
        ...buildActorFromUser(req.user),
        target_user_id: requestedUserId,
        details: { reason: 'Access denied' },
      });
      return res.status(403).json({ message: 'Access denied' });
    }

    const userData = await user.findByPk(requestedUserId);
    if (!userData) {
      await logRequestAudit(models, req, {
        action: 'user.update',
        outcome: 'failure',
        entityType: 'user',
        ...buildActorFromUser(req.user),
        target_user_id: requestedUserId,
        details: { reason: 'User not found' },
      });
      return res.status(404).json({ message: 'User not found' });
    }

    const { username, full_name, role, is_active } = req.body;

    // Check for username conflicts
    if (username && username !== userData.username) {
      const existingUser = await user.findOne({
        where: {
          username,
          id: { [Op.ne]: requestedUserId }
        }
      });
      if (existingUser) {
        await logRequestAudit(models, req, {
          action: 'user.update',
          outcome: 'failure',
          entityType: 'user',
          ...buildActorFromUser(req.user),
          ...buildTargetFromUser(userData),
          details: { reason: 'Username already exists', requestedUsername: username },
        });
        return res.status(400).json({ message: 'Username already exists' });
      }
    }

    // Prepare update data
    const updateData = {};

    // Fields that users can update on their own profile
    if (username) updateData.username = username;
    if (full_name) updateData.full_name = full_name;

    // Admin-only fields
    if (isAdmin) {
      if (role) updateData.role = role;
      if (is_active !== undefined) updateData.is_active = is_active;
    }

    await user.update(updateData, {
      where: { id: requestedUserId }
    });

    // Fetch updated user
    const updatedUser = await user.findByPk(requestedUserId, {
      attributes: { exclude: ['password_hash'] }
    });

    await logRequestAudit(models, req, {
      action: isOwnProfile && !isAdmin ? 'user.update_profile' : 'user.update',
      outcome: 'success',
      entityType: 'user',
      ...buildActorFromUser(req.user),
      ...buildTargetFromUser(updatedUser),
      details: { updatedFields: Object.keys(updateData) },
    });

    res.json({
      message: 'User updated successfully',
      user: updatedUser
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Reset user password (admin only)
router.patch('/:id/reset-password', auth, async (req, res) => {
  try {
    const models = getModels(req);
    // Check if user is admin
    if (req.user.role !== 'admin') {
      await logRequestAudit(models, req, {
        action: 'user.reset_password',
        outcome: 'failure',
        entityType: 'user',
        ...buildActorFromUser(req.user),
        target_user_id: parseInt(req.params.id),
        details: { reason: 'Only admins can reset passwords' },
      });
      return res.status(403).json({ message: 'Only admins can reset passwords' });
    }

    const { new_password } = req.body;

    if (!new_password) {
      await logRequestAudit(models, req, {
        action: 'user.reset_password',
        outcome: 'failure',
        entityType: 'user',
        ...buildActorFromUser(req.user),
        target_user_id: parseInt(req.params.id),
        details: { reason: 'New password is required' },
      });
      return res.status(400).json({ message: 'New password is required' });
    }

    if (new_password.length < 6) {
      await logRequestAudit(models, req, {
        action: 'user.reset_password',
        outcome: 'failure',
        entityType: 'user',
        ...buildActorFromUser(req.user),
        target_user_id: parseInt(req.params.id),
        details: { reason: 'Password must be at least 6 characters long' },
      });
      return res.status(400).json({ message: 'Password must be at least 6 characters long' });
    }

    const userData = await user.findByPk(req.params.id);
    if (!userData) {
      await logRequestAudit(models, req, {
        action: 'user.reset_password',
        outcome: 'failure',
        entityType: 'user',
        ...buildActorFromUser(req.user),
        target_user_id: parseInt(req.params.id),
        details: { reason: 'User not found' },
      });
      return res.status(404).json({ message: 'User not found' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(new_password, salt);

    await user.update(
        { password_hash },
        { where: { id: req.params.id } }
    );

    await logRequestAudit(models, req, {
      action: 'user.reset_password',
      outcome: 'success',
      entityType: 'user',
      ...buildActorFromUser(req.user),
      ...buildTargetFromUser(userData),
    });

    res.json({ message: 'Password reset successfully' });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Toggle user active status (admin only)
router.patch('/:id/toggle-status', auth, async (req, res) => {
  try {
    const models = getModels(req);
    // Check if user is admin
    if (req.user.role !== 'admin') {
      await logRequestAudit(models, req, {
        action: 'user.toggle_status',
        outcome: 'failure',
        entityType: 'user',
        ...buildActorFromUser(req.user),
        target_user_id: parseInt(req.params.id),
        details: { reason: 'Only admins can change user status' },
      });
      return res.status(403).json({ message: 'Only admins can change user status' });
    }

    const userData = await user.findByPk(req.params.id);
    if (!userData) {
      await logRequestAudit(models, req, {
        action: 'user.toggle_status',
        outcome: 'failure',
        entityType: 'user',
        ...buildActorFromUser(req.user),
        target_user_id: parseInt(req.params.id),
        details: { reason: 'User not found' },
      });
      return res.status(404).json({ message: 'User not found' });
    }

    // Don't allow admin to deactivate themselves
    if (req.user.id === parseInt(req.params.id)) {
      await logRequestAudit(models, req, {
        action: 'user.toggle_status',
        outcome: 'failure',
        entityType: 'user',
        ...buildActorFromUser(req.user),
        ...buildTargetFromUser(userData),
        details: { reason: 'You cannot deactivate your own account' },
      });
      return res.status(400).json({ message: 'You cannot deactivate your own account' });
    }

    const newStatus = !userData.is_active;

    await user.update(
        { is_active: newStatus },
        { where: { id: req.params.id } }
    );

    await logRequestAudit(models, req, {
      action: 'user.toggle_status',
      outcome: 'success',
      entityType: 'user',
      ...buildActorFromUser(req.user),
      ...buildTargetFromUser(userData),
      details: { is_active: newStatus },
    });

    res.json({
      message: `User ${newStatus ? 'activated' : 'deactivated'} successfully`,
      is_active: newStatus
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get user sales performance (admin only)
router.get('/:id/performance', auth, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can view user performance' });
    }

    const { start_date, end_date } = req.query;
    const userId = req.params.id;

    // Verify user exists
    const userData = await user.findByPk(userId, {
      attributes: { exclude: ['password_hash'] }
    });
    if (!userData) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Build where clause for sales
    const whereClause = { user_id: userId };

    if (start_date && end_date) {
      whereClause.sale_date = {
        [Op.between]: [new Date(start_date), new Date(end_date)]
      };
    }

    const userSales = await sale.findAll({
      where: whereClause,
      order: [['sale_date', 'DESC']]
    });

    // Calculate performance metrics
    const performance = {
      user: userData,
      total_sales: userSales.length,
      total_revenue: userSales.reduce((sum, s) => sum + parseFloat(s.total_amount), 0),
      total_discounts_given: userSales.reduce((sum, s) => sum + parseFloat(s.discount_amount), 0),
      average_sale_amount: userSales.length > 0 ?
          userSales.reduce((sum, s) => sum + parseFloat(s.total_amount), 0) / userSales.length : 0,
      payment_methods: {},
      sales_by_date: {}
    };

    // Group by payment method
    userSales.forEach(s => {
      performance.payment_methods[s.payment_method] =
          (performance.payment_methods[s.payment_method] || 0) + 1;
    });

    // Group by date
    userSales.forEach(s => {
      const date = s.sale_date.toDateString();
      if (!performance.sales_by_date[date]) {
        performance.sales_by_date[date] = {
          count: 0,
          revenue: 0
        };
      }
      performance.sales_by_date[date].count += 1;
      performance.sales_by_date[date].revenue += parseFloat(s.total_amount);
    });

    res.json({ performance });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all users performance summary (admin only)
router.get('/reports/all-performance', auth, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can view performance reports' });
    }

    const { start_date, end_date } = req.query;

    // Build where clause for sales
    const whereClause = {};

    if (start_date && end_date) {
      whereClause.sale_date = {
        [Op.between]: [new Date(start_date), new Date(end_date)]
      };
    }

    const allSales = await sale.findAll({
      where: whereClause,
      include: [
        {
          model: user,
          as: 'cashier',
          attributes: ['id', 'username', 'full_name']
        }
      ]
    });

    // Group sales by user
    const userPerformance = {};

    allSales.forEach(s => {
      const userId = s.user_id;
      if (!userPerformance[userId]) {
        userPerformance[userId] = {
          user: s.cashier,
          total_sales: 0,
          total_revenue: 0,
          total_discounts: 0
        };
      }

      userPerformance[userId].total_sales += 1;
      userPerformance[userId].total_revenue += parseFloat(s.total_amount);
      userPerformance[userId].total_discounts += parseFloat(s.discount_amount);
    });

    // Convert to array and sort by revenue
    const performanceArray = Object.values(userPerformance)
        .sort((a, b) => b.total_revenue - a.total_revenue);

    res.json({
      performance_summary: performanceArray,
      total_users: performanceArray.length
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete user (admin only - soft delete)
router.delete('/:id', auth, async (req, res) => {
  try {
    const models = getModels(req);
    // Check if user is admin
    if (req.user.role !== 'admin') {
      await logRequestAudit(models, req, {
        action: 'user.delete',
        outcome: 'failure',
        entityType: 'user',
        ...buildActorFromUser(req.user),
        target_user_id: parseInt(req.params.id),
        details: { reason: 'Only admins can delete users' },
      });
      return res.status(403).json({ message: 'Only admins can delete users' });
    }

    const userData = await user.findByPk(req.params.id);
    if (!userData) {
      await logRequestAudit(models, req, {
        action: 'user.delete',
        outcome: 'failure',
        entityType: 'user',
        ...buildActorFromUser(req.user),
        target_user_id: parseInt(req.params.id),
        details: { reason: 'User not found' },
      });
      return res.status(404).json({ message: 'User not found' });
    }

    // Don't allow admin to delete themselves
    if (req.user.id === parseInt(req.params.id)) {
      await logRequestAudit(models, req, {
        action: 'user.delete',
        outcome: 'failure',
        entityType: 'user',
        ...buildActorFromUser(req.user),
        ...buildTargetFromUser(userData),
        details: { reason: 'You cannot delete your own account' },
      });
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }

    await user.update(
        { is_active: false },
        { where: { id: req.params.id } }
    );

    await logRequestAudit(models, req, {
      action: 'user.delete',
      outcome: 'success',
      entityType: 'user',
      ...buildActorFromUser(req.user),
      ...buildTargetFromUser(userData),
      details: { softDeleted: true },
    });

    res.json({ message: 'User deleted successfully' });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;