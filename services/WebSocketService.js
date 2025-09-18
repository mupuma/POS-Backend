const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { user } = require('../models');

/**
 * WebSocket Service for real-time notifications
 */
class WebSocketService {
    constructor() {
        this.wss = null;
        this.clients = new Map(); // Map user_id to WebSocket connections
    }

    /**
     * Initialize WebSocket server
     * @param {http.Server} server - HTTP server instance
     */
    initialize(server) {
        this.wss = new WebSocket.Server({
            server,
            path: '/ws/notifications'
        });

        this.wss.on('connection', this.handleConnection.bind(this));
        console.log('WebSocket server initialized for notifications');
    }

    /**
     * Handle new WebSocket connection
     * @param {WebSocket} ws - WebSocket connection
     * @param {http.IncomingMessage} request - HTTP request
     */
    async handleConnection(ws, request) {
        try {
            // Extract token from query parameters or headers
            const url = new URL(request.url, 'http://localhost');
            const token = url.searchParams.get('token') ||
                request.headers.authorization?.replace('Bearer ', '');

            if (!token) {
                ws.close(1008, 'Authentication token required');
                return;
            }

            // Verify JWT token
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const userRecord = await user.findByPk(decoded.id);

            if (!userRecord) {
                ws.close(1008, 'Invalid user');
                return;
            }

            // Store connection with user info
            ws.userId = userRecord.id;
            ws.userInfo = {
                id: userRecord.id,
                full_name: userRecord.full_name,
                email: userRecord.email
            };

            // Add to clients map
            if (!this.clients.has(userRecord.id)) {
                this.clients.set(userRecord.id, new Set());
            }
            this.clients.get(userRecord.id).add(ws);

            console.log(`WebSocket connection established for user: ${userRecord.full_name} (ID: ${userRecord.id})`);

            // Send welcome message
            ws.send(JSON.stringify({
                type: 'connection_established',
                message: 'Connected to notification service',
                timestamp: new Date().toISOString()
            }));

            // Handle connection close
            ws.on('close', () => {
                this.handleDisconnection(ws);
            });

            // Handle incoming messages
            ws.on('message', (data) => {
                this.handleMessage(ws, data);
            });

            // Handle errors
            ws.on('error', (error) => {
                console.error(`WebSocket error for user ${userRecord.id}:`, error);
                this.handleDisconnection(ws);
            });

        } catch (error) {
            console.error('WebSocket authentication error:', error);
            ws.close(1008, 'Authentication failed');
        }
    }

    /**
     * Handle WebSocket disconnection
     * @param {WebSocket} ws - WebSocket connection
     */
    handleDisconnection(ws) {
        if (ws.userId) {
            const userConnections = this.clients.get(ws.userId);
            if (userConnections) {
                userConnections.delete(ws);
                if (userConnections.size === 0) {
                    this.clients.delete(ws.userId);
                }
            }
            console.log(`WebSocket connection closed for user ID: ${ws.userId}`);
        }
    }

    /**
     * Handle incoming WebSocket messages
     * @param {WebSocket} ws - WebSocket connection
     * @param {Buffer} data - Message data
     */
    handleMessage(ws, data) {
        try {
            const message = JSON.parse(data.toString());

            switch (message.type) {
                case 'ping':
                    ws.send(JSON.stringify({
                        type: 'pong',
                        timestamp: new Date().toISOString()
                    }));
                    break;

                case 'mark_notifications_read':
                    // Handle marking notifications as read
                    this.handleMarkNotificationsRead(ws, message.notification_ids);
                    break;

                default:
                    console.log(`Unknown message type from user ${ws.userId}:`, message.type);
            }
        } catch (error) {
            console.error('Error handling WebSocket message:', error);
        }
    }

    /**
     * Handle marking notifications as read via WebSocket
     * @param {WebSocket} ws - WebSocket connection
     * @param {array} notificationIds - Array of notification IDs
     */
    async handleMarkNotificationsRead(ws, notificationIds) {
        try {
            const NotificationService = require('./NotificationService');
            const notificationService = new NotificationService();

            const updatedCount = await notificationService.markAsRead(
                notificationIds,
                ws.userId
            );

            ws.send(JSON.stringify({
                type: 'notifications_marked_read',
                notification_ids: notificationIds,
                updated_count: updatedCount,
                timestamp: new Date().toISOString()
            }));

        } catch (error) {
            console.error('Error marking notifications as read via WebSocket:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Failed to mark notifications as read',
                timestamp: new Date().toISOString()
            }));
        }
    }

    /**
     * Send notification to specific user
     * @param {number} userId - User ID
     * @param {object} notification - Notification data
     */
    sendNotificationToUser(userId, notification) {
        const userConnections = this.clients.get(userId);
        if (userConnections && userConnections.size > 0) {
            const message = JSON.stringify({
                type: 'new_notification',
                notification: {
                    id: notification.id,
                    type: notification.type,
                    title: notification.title,
                    message: notification.message,
                    severity: notification.severity,
                    metadata: notification.metadata,
                    created_at: notification.created_at
                },
                timestamp: new Date().toISOString()
            });

            userConnections.forEach(ws => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(message);
                }
            });

            console.log(`Notification sent to user ${userId} via WebSocket`);
            return true;
        }

        console.log(`User ${userId} not connected via WebSocket`);
        return false;
    }

    /**
     * Send notification to all connected users
     * @param {object} notification - Notification data
     */
    broadcastNotification(notification) {
        if (!this.wss) return;

        const message = JSON.stringify({
            type: 'broadcast_notification',
            notification: {
                id: notification.id,
                type: notification.type,
                title: notification.title,
                message: notification.message,
                severity: notification.severity,
                metadata: notification.metadata,
                created_at: notification.created_at
            },
            timestamp: new Date().toISOString()
        });

        this.wss.clients.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        });

        console.log('Notification broadcasted to all connected users');
    }

    /**
     * Send unread count update to user
     * @param {number} userId - User ID
     * @param {number} unreadCount - New unread count
     */
    sendUnreadCountUpdate(userId, unreadCount) {
        const userConnections = this.clients.get(userId);
        if (userConnections && userConnections.size > 0) {
            const message = JSON.stringify({
                type: 'unread_count_update',
                unread_count: unreadCount,
                timestamp: new Date().toISOString()
            });

            userConnections.forEach(ws => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(message);
                }
            });

            console.log(`Unread count update sent to user ${userId}: ${unreadCount}`);
        }
    }

    /**
     * Get connected users count
     * @returns {number}
     */
    getConnectedUsersCount() {
        return this.clients.size;
    }

    /**
     * Get connection info
     * @returns {object}
     */
    getConnectionInfo() {
        const connectedUsers = Array.from(this.clients.keys());
        const totalConnections = Array.from(this.clients.values())
            .reduce((sum, connections) => sum + connections.size, 0);

        return {
            connected_users_count: this.clients.size,
            total_connections: totalConnections,
            connected_user_ids: connectedUsers
        };
    }
}

// Export singleton instance
module.exports = new WebSocketService();