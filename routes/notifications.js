
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const NotificationService = require('../services/NotificationService');

const notificationService = new NotificationService();

/**
 * GET /api/notifications
 * Get notifications for the current user
 */
router.get('/', auth, async (req, res) => {
    try {
        const {
            limit = 50,
            offset = 0,
            unread_only = false,
            severity = null,
            type = null
        } = req.query;

        const options = {
            limit: parseInt(limit),
            offset: parseInt(offset),
            unreadOnly: unread_only === 'true',
            severity: severity || null,
            type: type || null
        };

        const notifications = await notificationService.getUserNotifications(
            req.user.id,
            options
        );

        // Also get unread count
        const unreadCount = await notificationService.getUnreadCount(req.user.id);

        res.json({
            notifications,
            unread_count: unreadCount,
            pagination: {
                limit: options.limit,
                offset: options.offset
            }
        });

    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({
            message: 'Error fetching notifications',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * GET /api/notifications/unread-count
 * Get unread notification count for the current user
 */
router.get('/unread-count', auth, async (req, res) => {
    try {
        const unreadCount = await notificationService.getUnreadCount(req.user.id);
        res.json({ unread_count: unreadCount });

    } catch (error) {
        console.error('Error fetching unread count:', error);
        res.status(500).json({
            message: 'Error fetching unread count',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * PUT /api/notifications/mark-read
 * Mark specific notifications as read
 */
router.put('/mark-read', auth, async (req, res) => {
    try {
        const { notification_ids } = req.body;

        if (!notification_ids || !Array.isArray(notification_ids)) {
            return res.status(400).json({
                message: 'notification_ids array is required'
            });
        }

        const updatedCount = await notificationService.markAsRead(
            notification_ids,
            req.user.id
        );

        res.json({
            message: 'Notifications marked as read',
            updated_count: updatedCount
        });

    } catch (error) {
        console.error('Error marking notifications as read:', error);
        res.status(500).json({
            message: 'Error marking notifications as read',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * PUT /api/notifications/mark-all-read
 * Mark all notifications as read for the current user
 */
router.put('/mark-all-read', auth, async (req, res) => {
    try {
        const updatedCount = await notificationService.markAllAsRead(req.user.id);

        res.json({
            message: 'All notifications marked as read',
            updated_count: updatedCount
        });

    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        res.status(500).json({
            message: 'Error marking all notifications as read',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * DELETE /api/notifications/:id
 * Delete a specific notification (admin only or own notifications)
 */
router.delete('/:id', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const { notification } = require('../models');

        // Find the notification
        const notificationRecord = await notification.findByPk(id);

        if (!notificationRecord) {
            return res.status(404).json({
                message: 'Notification not found'
            });
        }

        // Check if user owns the notification or is admin
        if (notificationRecord.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({
                message: 'Unauthorized to delete this notification'
            });
        }

        await notificationRecord.destroy();

        res.json({
            message: 'Notification deleted successfully'
        });

    } catch (error) {
        console.error('Error deleting notification:', error);
        res.status(500).json({
            message: 'Error deleting notification',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * POST /api/notifications/test (Development only)
 * Create a test notification
 */
if (process.env.NODE_ENV === 'development') {
    router.post('/test', auth, async (req, res) => {
        try {
            const {
                type = 'TEST_NOTIFICATION',
                title = 'Test Notification',
                message = 'This is a test notification',
                severity = 'info'
            } = req.body;

            const notification = await notificationService.createNotification({
                type,
                title,
                message,
                severity,
                user_id: req.user.id,
                metadata: {
                    test: true,
                    created_by: req.user.full_name
                }
            });

            res.status(201).json({
                message: 'Test notification created',
                notification
            });

        } catch (error) {
            console.error('Error creating test notification:', error);
            res.status(500).json({
                message: 'Error creating test notification',
                error: error.message
            });
        }
    });
}

module.exports = router;