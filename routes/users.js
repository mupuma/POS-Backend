const express = require('express');
const bcrypt = require('bcryptjs');
const { user, sale } = require('../models');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');
const logger = require('../utils/logger');

const router = express.Router();
const siteId = process.env.SITE_ID || 'unknown-site';

// Get all users (admin only)
router.get('/', auth, async (req, res) => {
  const startedAt = new Date();

  try {
    logger.info('users_list_started', {
      siteId,
      userId: req.user?.id,
      userRole: req.user?.role,
      startedAt
    });

    // Check if user is admin
    if (req.user.role !== 'admin') {
      logger.warn('users_list_unauthorized', {
        siteId,
        userId: req.user?.id,
        userRole: req.user?.role
      });
      return res.status(403).json({ message: 'Only admins can view all users' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const role = req.query.role;
    const active_only = req.query.active_only === 'true';

    logger.debug('users_list_filters', {
      siteId,
      page,
      limit,
      search,
      role,
      activeOnly: active_only
    });

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
      attributes: { exclude: ['password_hash'] }
    });

    const durationMs = Date.now() - startedAt.getTime();
    logger.info('users_list_completed', {
      siteId,
      userId: req.user?.id,
      totalRecords: count,
      returnedRecords: rows.length,
      page,
      durationMs
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
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('users_list_error', {
      siteId,
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
      durationMs
    });
    res.status(500).json({ message: 'Server error' });
  }
});

// Get user by ID (admin only or own profile)
router.get('/:id', auth, async (req, res) => {
  const startedAt = new Date();

  try {
    const requestedUserId = parseInt(req.params.id);

    logger.info('user_get_started', {
      siteId,
      requestedUserId,
      userId: req.user?.id,
      userRole: req.user?.role,
      startedAt
    });

    // Check if user is admin or requesting own profile
    if (req.user.role !== 'admin' && req.user.id !== requestedUserId) {
      logger.warn('user_get_unauthorized', {
        siteId,
        requestedUserId,
        userId: req.user?.id,
        userRole: req.user?.role
      });
      return res.status(403).json({ message: 'Access denied' });
    }

    const userData = await user.findByPk(requestedUserId, {
      attributes: { exclude: ['password_hash'] }
    });

    if (!userData) {
      logger.warn('user_get_not_found', {
        siteId,
        requestedUserId,
        userId: req.user?.id
      });
      return res.status(404).json({ message: 'User not found' });
    }

    const durationMs = Date.now() - startedAt.getTime();
    logger.info('user_get_completed', {
      siteId,
      requestedUserId,
      userId: req.user?.id,
      targetUsername: userData.username,
      targetRole: userData.role,
      durationMs
    });

    res.json({ user: userData });

  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('user_get_error', {
      siteId,
      requestedUserId: req.params.id,
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
      durationMs
    });
    res.status(500).json({ message: 'Server error' });
  }
});

// Update user (admin only or own profile for limited fields)
router.put('/:id', auth, async (req, res) => {
  const startedAt = new Date();

  try {
    const requestedUserId = parseInt(req.params.id);
    const isAdmin = req.user.role === 'admin';
    const isOwnProfile = req.user.id === requestedUserId;

    logger.info('user_update_started', {
      siteId,
      requestedUserId,
      userId: req.user?.id,
      userRole: req.user?.role,
      isAdmin,
      isOwnProfile,
      updateFields: Object.keys(req.body),
      startedAt
    });

    if (!isAdmin && !isOwnProfile) {
      logger.warn('user_update_unauthorized', {
        siteId,
        requestedUserId,
        userId: req.user?.id,
        userRole: req.user?.role
      });
      return res.status(403).json({ message: 'Access denied' });
    }

    const userData = await user.findByPk(requestedUserId);
    if (!userData) {
      logger.warn('user_update_not_found', {
        siteId,
        requestedUserId,
        userId: req.user?.id
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
        logger.warn('user_update_username_exists', {
          siteId,
          requestedUserId,
          userId: req.user?.id,
          attemptedUsername: username
        });
        return res.status(400).json({ message: 'Username already exists' });
      }
    }

    // Prepare update data
    const updateData = {};

    // Fields that users can update on their own profile
    if (username) {
      updateData.username = username;
      logger.debug('user_update_username', {
        siteId,
        requestedUserId,
        oldUsername: userData.username,
        newUsername: username
      });
    }
    if (full_name) {
      updateData.full_name = full_name;
      logger.debug('user_update_full_name', {
        siteId,
        requestedUserId,
        oldName: userData.full_name,
        newName: full_name
      });
    }

    // Admin-only fields
    if (isAdmin) {
      if (role && role !== userData.role) {
        updateData.role = role;
        logger.debug('user_update_role', {
          siteId,
          requestedUserId,
          userId: req.user?.id,
          oldRole: userData.role,
          newRole: role
        });
      }
      if (is_active !== undefined && is_active !== userData.is_active) {
        updateData.is_active = is_active;
        logger.debug('user_update_status', {
          siteId,
          requestedUserId,
          userId: req.user?.id,
          oldStatus: userData.is_active,
          newStatus: is_active
        });
      }
    }

    if (Object.keys(updateData).length === 0) {
      logger.info('user_update_no_changes', {
        siteId,
        requestedUserId,
        userId: req.user?.id
      });
      return res.json({
        message: 'No changes made',
        user: userData
      });
    }

    await user.update(updateData, {
      where: { id: requestedUserId }
    });

    // Fetch updated user
    const updatedUser = await user.findByPk(requestedUserId, {
      attributes: { exclude: ['password_hash'] }
    });

    const durationMs = Date.now() - startedAt.getTime();
    logger.info('user_update_completed', {
      siteId,
      requestedUserId,
      userId: req.user?.id,
      updatedFields: Object.keys(updateData),
      durationMs
    });

    res.json({
      message: 'User updated successfully',
      user: updatedUser
    });

  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('user_update_error', {
      siteId,
      requestedUserId: req.params.id,
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
      durationMs
    });
    res.status(500).json({ message: 'Server error' });
  }
});

// Reset user password (admin only)
router.patch('/:id/reset-password', auth, async (req, res) => {
  const startedAt = new Date();

  try {
    logger.info('user_reset_password_started', {
      siteId,
      targetUserId: req.params.id,
      userId: req.user?.id,
      userRole: req.user?.role,
      startedAt
    });

    // Check if user is admin
    if (req.user.role !== 'admin') {
      logger.warn('user_reset_password_unauthorized', {
        siteId,
        targetUserId: req.params.id,
        userId: req.user?.id,
        userRole: req.user?.role
      });
      return res.status(403).json({ message: 'Only admins can reset passwords' });
    }

    const { new_password } = req.body;

    if (!new_password) {
      logger.warn('user_reset_password_missing', {
        siteId,
        targetUserId: req.params.id,
        userId: req.user?.id
      });
      return res.status(400).json({ message: 'New password is required' });
    }

    if (new_password.length < 6) {
      logger.warn('user_reset_password_weak', {
        siteId,
        targetUserId: req.params.id,
        userId: req.user?.id,
        passwordLength: new_password.length
      });
      return res.status(400).json({ message: 'Password must be at least 6 characters long' });
    }

    const userData = await user.findByPk(req.params.id);
    if (!userData) {
      logger.warn('user_reset_password_not_found', {
        siteId,
        targetUserId: req.params.id,
        userId: req.user?.id
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

    const durationMs = Date.now() - startedAt.getTime();
    logger.info('user_reset_password_completed', {
      siteId,
      targetUserId: req.params.id,
      targetUsername: userData.username,
      userId: req.user?.id,
      adminUsername: req.user?.username,
      durationMs
    });

    res.json({ message: 'Password reset successfully' });

  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('user_reset_password_error', {
      siteId,
      targetUserId: req.params.id,
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
      durationMs
    });
    res.status(500).json({ message: 'Server error' });
  }
});

// Toggle user active status (admin only)
router.patch('/:id/toggle-status', auth, async (req, res) => {
  const startedAt = new Date();

  try {
    logger.info('user_toggle_status_started', {
      siteId,
      targetUserId: req.params.id,
      userId: req.user?.id,
      userRole: req.user?.role,
      startedAt
    });

    // Check if user is admin
    if (req.user.role !== 'admin') {
      logger.warn('user_toggle_status_unauthorized', {
        siteId,
        targetUserId: req.params.id,
        userId: req.user?.id,
        userRole: req.user?.role
      });
      return res.status(403).json({ message: 'Only admins can change user status' });
    }

    const userData = await user.findByPk(req.params.id);
    if (!userData) {
      logger.warn('user_toggle_status_not_found', {
        siteId,
        targetUserId: req.params.id,
        userId: req.user?.id
      });
      return res.status(404).json({ message: 'User not found' });
    }

    // Don't allow admin to deactivate themselves
    if (req.user.id === parseInt(req.params.id)) {
      logger.warn('user_toggle_status_self_deactivate', {
        siteId,
        userId: req.user?.id,
        username: req.user?.username
      });
      return res.status(400).json({ message: 'You cannot deactivate your own account' });
    }

    const newStatus = !userData.is_active;

    await user.update(
      { is_active: newStatus },
      { where: { id: req.params.id } }
    );

    const durationMs = Date.now() - startedAt.getTime();
    logger.info('user_toggle_status_completed', {
      siteId,
      targetUserId: req.params.id,
      targetUsername: userData.username,
      userId: req.user?.id,
      adminUsername: req.user?.username,
      oldStatus: userData.is_active,
      newStatus,
      durationMs
    });

    res.json({
      message: `User ${newStatus ? 'activated' : 'deactivated'} successfully`,
      is_active: newStatus
    });

  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('user_toggle_status_error', {
      siteId,
      targetUserId: req.params.id,
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
      durationMs
    });
    res.status(500).json({ message: 'Server error' });
  }
});

// Get user sales performance (admin only)
router.get('/:id/performance', auth, async (req, res) => {
  const startedAt = new Date();

  try {
    logger.info('user_performance_started', {
      siteId,
      targetUserId: req.params.id,
      userId: req.user?.id,
      userRole: req.user?.role,
      startDate: req.query.start_date,
      endDate: req.query.end_date,
      startedAt
    });

    // Check if user is admin
    if (req.user.role !== 'admin') {
      logger.warn('user_performance_unauthorized', {
        siteId,
        targetUserId: req.params.id,
        userId: req.user?.id,
        userRole: req.user?.role
      });
      return res.status(403).json({ message: 'Only admins can view user performance' });
    }

    const { start_date, end_date } = req.query;
    const userId = req.params.id;

    // Verify user exists
    const userData = await user.findByPk(userId, {
      attributes: { exclude: ['password_hash'] }
    });
    if (!userData) {
      logger.warn('user_performance_not_found', {
        siteId,
        targetUserId: userId,
        userId: req.user?.id
      });
      return res.status(404).json({ message: 'User not found' });
    }

    logger.debug('user_performance_user_found', {
      siteId,
      targetUserId: userId,
      targetUsername: userData.username
    });

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

    logger.info('user_performance_sales_fetched', {
      siteId,
      targetUserId: userId,
      salesCount: userSales.length,
      dateRange: start_date && end_date ? `${start_date} to ${end_date}` : 'all-time'
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

    const durationMs = Date.now() - startedAt.getTime();
    logger.info('user_performance_completed', {
      siteId,
      targetUserId: userId,
      userId: req.user?.id,
      totalSales: performance.total_sales,
      totalRevenue: performance.total_revenue,
      averageSaleAmount: performance.average_sale_amount,
      paymentMethodsCount: Object.keys(performance.payment_methods).length,
      durationMs
    });

    res.json({ performance });

  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('user_performance_error', {
      siteId,
      targetUserId: req.params.id,
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
      durationMs
    });
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all users performance summary (admin only)
router.get('/reports/all-performance', auth, async (req, res) => {
  const startedAt = new Date();

  try {
    logger.info('users_all_performance_started', {
      siteId,
      userId: req.user?.id,
      userRole: req.user?.role,
      startDate: req.query.start_date,
      endDate: req.query.end_date,
      startedAt
    });

    // Check if user is admin
    if (req.user.role !== 'admin') {
      logger.warn('users_all_performance_unauthorized', {
        siteId,
        userId: req.user?.id,
        userRole: req.user?.role
      });
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

    logger.info('users_all_performance_sales_fetched', {
      siteId,
      userId: req.user?.id,
      totalSalesRecords: allSales.length,
      dateRange: start_date && end_date ? `${start_date} to ${end_date}` : 'all-time'
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

    const durationMs = Date.now() - startedAt.getTime();
    logger.info('users_all_performance_completed', {
      siteId,
      userId: req.user?.id,
      totalUsers: performanceArray.length,
      totalRevenue: performanceArray.reduce((sum, p) => sum + p.total_revenue, 0),
      topPerformerRevenue: performanceArray.length > 0 ? performanceArray[0].total_revenue : 0,
      durationMs
    });

    res.json({
      performance_summary: performanceArray,
      total_users: performanceArray.length
    });

  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('users_all_performance_error', {
      siteId,
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
      durationMs
    });
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete user (admin only - soft delete)
router.delete('/:id', auth, async (req, res) => {
  const startedAt = new Date();

  try {
    logger.info('user_delete_started', {
      siteId,
      targetUserId: req.params.id,
      userId: req.user?.id,
      userRole: req.user?.role,
      startedAt
    });

    // Check if user is admin
    if (req.user.role !== 'admin') {
      logger.warn('user_delete_unauthorized', {
        siteId,
        targetUserId: req.params.id,
        userId: req.user?.id,
        userRole: req.user?.role
      });
      return res.status(403).json({ message: 'Only admins can delete users' });
    }

    const userData = await user.findByPk(req.params.id);
    if (!userData) {
      logger.warn('user_delete_not_found', {
        siteId,
        targetUserId: req.params.id,
        userId: req.user?.id
      });
      return res.status(404).json({ message: 'User not found' });
    }

    // Don't allow admin to delete themselves
    if (req.user.id === parseInt(req.params.id)) {
      logger.warn('user_delete_self_delete', {
        siteId,
        userId: req.user?.id,
        username: req.user?.username
      });
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }

    await user.update(
      { is_active: false },
      { where: { id: req.params.id } }
    );

    const durationMs = Date.now() - startedAt.getTime();
    logger.info('user_delete_completed', {
      siteId,
      targetUserId: req.params.id,
      targetUsername: userData.username,
      userId: req.user?.id,
      adminUsername: req.user?.username,
      durationMs
    });

    res.json({ message: 'User deleted successfully' });

  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    logger.error('user_delete_error', {
      siteId,
      targetUserId: req.params.id,
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
      durationMs
    });
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;