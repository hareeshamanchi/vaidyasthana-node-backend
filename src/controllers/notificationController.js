const Notification = require("../models/Notification");
const { notifyNotificationEvent } = require("../config/socket");
const mongoose = require("mongoose");

const isDbConnected = () => mongoose.connection.readyState === 1;

// ==========================================
// Get Notifications for Authenticated User
// GET /api/notifications
// ==========================================
const getNotifications = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const userId = req.user.id;

    const [notifications, unreadCount] = await Promise.all([
      Notification.find({ userId })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      Notification.countDocuments({ userId, isRead: false }),
    ]);

    return res.status(200).json({
      success: true,
      count: notifications.length,
      unreadCount,
      notifications,
    });
  } catch (error) {
    console.error("Get Notifications Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve notifications.",
    });
  }
};

// ==========================================
// Get Unread Count for Authenticated User
// GET /api/notifications/unread-count
// ==========================================
const getUnreadNotificationCount = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const unreadCount = await Notification.countDocuments({
      userId: req.user.id,
      isRead: false,
    });

    return res.status(200).json({
      success: true,
      unreadCount,
    });
  } catch (error) {
    console.error("Get Unread Count Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve unread notification count.",
    });
  }
};

// ==========================================
// Mark Specific Notification as Read
// PATCH /api/notifications/:id/read
// ==========================================
const markNotificationAsRead = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid notification ID.",
      });
    }

    // Strictly enforce ownership check: user can only mark their own notification
    const notification = await Notification.findOne({
      _id: id,
      userId: req.user.id,
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found or access denied.",
      });
    }

    if (!notification.isRead) {
      notification.isRead = true;
      notification.readAt = new Date();
      await notification.save();
    }

    const unreadCount = await Notification.countDocuments({
      userId: req.user.id,
      isRead: false,
    });

    notifyNotificationEvent({
      userId: req.user.id,
      notification,
      unreadCount,
    });

    return res.status(200).json({
      success: true,
      message: "Notification marked as read.",
      notification,
      unreadCount,
    });
  } catch (error) {
    console.error("Mark Notification Read Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to mark notification as read.",
    });
  }
};

// ==========================================
// Mark All Notifications as Read
// PATCH /api/notifications/read-all
// ==========================================
const markAllNotificationsAsRead = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const userId = req.user.id;

    await Notification.updateMany(
      { userId, isRead: false },
      { $set: { isRead: true, readAt: new Date() } }
    );

    notifyNotificationEvent({
      userId,
      notification: null,
      unreadCount: 0,
    });

    return res.status(200).json({
      success: true,
      message: "All notifications marked as read.",
      unreadCount: 0,
    });
  } catch (error) {
    console.error("Mark All Read Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to mark all notifications as read.",
    });
  }
};

// ==========================================
// Delete a Specific Notification
// DELETE /api/notifications/:id
// ==========================================
const deleteNotification = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid notification ID.",
      });
    }

    const deleted = await Notification.findOneAndDelete({
      _id: id,
      userId: req.user.id,
    });

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Notification not found or access denied.",
      });
    }

    const unreadCount = await Notification.countDocuments({
      userId: req.user.id,
      isRead: false,
    });

    notifyNotificationEvent({
      userId: req.user.id,
      notification: null,
      unreadCount,
    });

    return res.status(200).json({
      success: true,
      message: "Notification removed.",
      unreadCount,
    });
  } catch (error) {
    console.error("Delete Notification Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete notification.",
    });
  }
};

module.exports = {
  getNotifications,
  getUnreadNotificationCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
};
