const { notification } = require('../models');
const EventEmitter = require('events');

/**
 * Notification Service
 * Handles creation and management of system notifications
 */
class NotificationService extends EventEmitter {
    constructor() {
        super();
        this.webSocketService = null;
    }

    /**
     * Set WebSocket service for real-time notifications
     * @param {WebSocketService} wsService
     */
    setWebSocketService(wsService) {
        this.webSocketService = wsService;
    }

    /**
     * Create a new notification
     * @param {object} notificationData
     * @returns {Promise<object>}
     */
    async createNotification(notificationData) {
        try {
            const {
                type,
                title,
                message,
                severity = 'info',
                user_id,
                metadata = {}
            } = notificationData;

            // Validate required fields
            if (!type || !title || !message) {
                throw new Error('Type, title, and message are required fields');
            }

            // Create notification in database
            const newNotification = await notification.create({
                type,
                title,
                message,
                severity,
                user_id: user_id || null,
                metadata: JSON.stringify(metadata),
                is_read: false,
                created_at: new Date(),
                updated_at: new Date()
            });

            // Emit event for real-time notifications
            this.emit('notification_created', {
                id: newNotification.id,
                type,
                title,
                message,
                severity,
                user_id,
                metadata,
                created_at: newNotification.created_at
            });

            // Send via WebSocket if service is available
            if (this.webSocketService && user_id) {
                this.webSocketService.sendNotificationToUser(user_id, {
                    id: newNotification.id,
                    type,
                    title,
                    message,
                    severity,
                    metadata,
                    created_at: newNotification.created_at
                });
            }

            console.log('Notification created:', {
                id: newNotification.id,
                type,
                title,
                user_id
            });

            return newNotification;

        } catch (error) {
            console.error('Error creating notification:', error);
            throw error;
        }
    }

    /**
     * Get notifications for a specific user
     * @param {number} userId
     * @param {object} options
     * @returns {Promise<array>}
     */
    async getUserNotifications(userId, options = {}) {
        try {
            const {
                limit = 50,
                offset = 0,
                unreadOnly = false,
                severity = null,
                type = null
            } = options;

            const whereClause = {
                user_id: userId
            };

            if (unreadOnly) {
                whereClause.is_read = false;
            }

            if (severity) {
                whereClause.severity = severity;
            }

            if (type) {
                whereClause.type = type;
            }

            const notifications = await notification.findAll({
                where: whereClause,
                order: [['created_at', 'DESC']],
                limit,
                offset,
                attributes: [
                    'id',
                    'type',
                    'title',
                    'message',
                    'severity',
                    'metadata',
                    'is_read',
                    'created_at'
                ]
            });

            return notifications.map(notif => ({
                ...notif.toJSON(),
                metadata: notif.metadata ? JSON.parse(notif.metadata) : {}
            }));

        } catch (error) {
            console.error('Error getting user notifications:', error);
            throw error;
        }
    }

    /**
     * Mark notifications as read
     * @param {array} notificationIds
     * @param {number} userId
     * @returns {Promise<number>}
     */
    async markAsRead(notificationIds, userId) {
        try {
            const [updatedCount] = await notification.update(
                {
                    is_read: true,
                    updated_at: new Date()
                },
                {
                    where: {
                        id: notificationIds,
                        user_id: userId
                    }
                }
            );

            // Emit event for real-time updates
            this.emit('notifications_read', {
                notification_ids: notificationIds,
                user_id: userId,
                count: updatedCount
            });

            // Send unread count update via WebSocket
            if (this.webSocketService) {
                const newUnreadCount = await this.getUnreadCount(userId);
                this.webSocketService.sendUnreadCountUpdate(userId, newUnreadCount);
            }

            return updatedCount;

        } catch (error) {
            console.error('Error marking notifications as read:', error);
            throw error;
        }
    }

    /**
     * Mark all notifications as read for a user
     * @param {number} userId
     * @returns {Promise<number>}
     */
    async markAllAsRead(userId) {
        try {
            const [updatedCount] = await notification.update(
                {
                    is_read: true,
                    updated_at: new Date()
                },
                {
                    where: {
                        user_id: userId,
                        is_read: false
                    }
                }
            );

            // Emit event for real-time updates
            this.emit('all_notifications_read', {
                user_id: userId,
                count: updatedCount
            });

            // Send unread count update via WebSocket
            if (this.webSocketService) {
                this.webSocketService.sendUnreadCountUpdate(userId, 0);
            }

            return updatedCount;

        } catch (error) {
            console.error('Error marking all notifications as read:', error);
            throw error;
        }
    }

    /**
     * Delete old notifications
     * @param {number} daysOld
     * @returns {Promise<number>}
     */
    async deleteOldNotifications(daysOld = 30) {
        try {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - daysOld);

            const deletedCount = await notification.destroy({
                where: {
                    created_at: {
                        [notification.sequelize.Sequelize.Op.lt]: cutoffDate
                    }
                }
            });

            console.log(`Deleted ${deletedCount} old notifications (older than ${daysOld} days)`);
            return deletedCount;

        } catch (error) {
            console.error('Error deleting old notifications:', error);
            throw error;
        }
    }

    /**
     * Get unread notification count for a user
     * @param {number} userId
     * @returns {Promise<number>}
     */
    async getUnreadCount(userId) {
        try {
            const count = await notification.count({
                where: {
                    user_id: userId,
                    is_read: false
                }
            });

            return count;

        } catch (error) {
            console.error('Error getting unread count:', error);
            throw error;
        }
    }

    /**
     * Create ZRA-specific notification helpers
     */
    async createZRAStockItemsFailedNotification(saleId, error, userId) {
        return this.createNotification({
            type: 'ZRA_STOCK_ITEMS_FAILED',
            title: 'ZRA Stock Items Update Failed',
            message: `Failed to update stock items in ZRA for sale #${saleId}`,
            severity: 'warning',
            user_id: userId,
            metadata: {
                sale_id: saleId,
                endpoint: 'saveStockItems',
                error: error
            }
        });
    }

    async createZRAStockMasterFailedNotification(saleId, error, userId) {
        return this.createNotification({
            type: 'ZRA_STOCK_MASTER_FAILED',
            title: 'ZRA Stock Master Update Failed',
            message: `Failed to update stock master in ZRA for sale #${saleId}`,
            severity: 'warning',
            user_id: userId,
            metadata: {
                sale_id: saleId,
                endpoint: 'saveStockMaster',
                error: error
            }
        });
    }

    async createZRAIntegrationCompleteNotification(saleId, userId) {
        return this.createNotification({
            type: 'ZRA_INTEGRATION_COMPLETE',
            title: 'ZRA Integration Complete',
            message: `All ZRA endpoints processed successfully for sale #${saleId}`,
            severity: 'success',
            user_id: userId,
            metadata: {
                sale_id: saleId,
                all_endpoints_success: true
            }
        });
    }
}

module.exports = NotificationService;