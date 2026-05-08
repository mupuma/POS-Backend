const NotificationService = require('./services/NotificationService');
const webSocketService = require('./services/WebSocketService');

/**
 * Initialize the notification system
 * @param {http.Server} httpServer - HTTP server instance
 * @returns {NotificationService}
 */
function initializeNotificationSystem(httpServer) {
    // Initialize WebSocket server
    webSocketService.initialize(httpServer);

    // Create notification service instance
    const notificationService = new NotificationService();

    // Connect WebSocket service to notification service
    notificationService.setWebSocketService(webSocketService);

    // Set up event listeners for real-time notifications
    notificationService.on('notification_created', (notification) => {
        console.log('Notification created event:', notification.type);

        // Additional processing if needed
        // For example, you could add email notifications here
        if (notification.severity === 'error') {
            console.log('High priority notification created:', notification.title);
        }
    });

    notificationService.on('notifications_read', (data) => {
        console.log(`${data.count} notifications marked as read for user ${data.user_id}`);
    });

    notificationService.on('all_notifications_read', (data) => {
        console.log(`All notifications marked as read for user ${data.user_id}`);
    });

    console.log('Notification system initialized successfully');
    return notificationService;
}

/**
 * Get WebSocket service instance
 * @returns {WebSocketService}
 */
function getWebSocketService() {
    return webSocketService;
}

/**
 * Create a global notification service instance (for background processing)
 * This should be called once during app startup
 */
let globalNotificationService = null;

function setGlobalNotificationService(notificationService) {
    globalNotificationService = notificationService;
}

function getGlobalNotificationService() {
    if (!globalNotificationService) {
        globalNotificationService = new NotificationService();

        // Try to connect WebSocket service if it's available
        try {
            globalNotificationService.setWebSocketService(webSocketService);
        } catch (error) {
            console.warn('WebSocket service not available for global notification service');
        }
    }
    return globalNotificationService;
}

/**
 * Cleanup function for graceful shutdown
 */
function cleanup() {
    console.log('Cleaning up notification system...');

    // Close WebSocket connections
    if (webSocketService && webSocketService.wss) {
        webSocketService.wss.clients.forEach(ws => {
            ws.close(1001, 'Server shutting down');
        });
        console.log('WebSocket connections closed');
    }

    // Clean up notification service listeners
    if (globalNotificationService) {
        globalNotificationService.removeAllListeners();
        console.log('Notification service listeners cleaned up');
    }
}

// Handle graceful shutdown
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

module.exports = {
    initializeNotificationSystem,
    getWebSocketService,
    setGlobalNotificationService,
    getGlobalNotificationService,
    cleanup
};