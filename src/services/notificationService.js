/**
 * Notification Service
 * Handles notification creation, persistence in MongoDB Atlas, and real-time Socket.IO emission
 */

const Notification = require("../models/Notification");
const { notifyNotificationEvent } = require("../config/socket");
const mongoose = require("mongoose");

const isDbConnected = () => mongoose.connection.readyState === 1;

/**
 * Creates and persists a notification, then notifies the user via real-time WebSocket.
 *
 * @param {Object} params
 * @param {string|mongoose.Types.ObjectId} params.userId - Recipient user MongoDB _id
 * @param {string} params.title - Notification headline
 * @param {string} params.message - Notification body text
 * @param {string} [params.type='general'] - Event category
 * @param {string|mongoose.Types.ObjectId} [params.relatedId=null] - Related resource _id
 * @param {string} [params.relatedModel=null] - Related resource model name
 * @param {string} [params.link=''] - Frontend link target
 * @returns {Promise<Object|null>} - Created notification document or null
 */
const createNotification = async ({
  userId,
  title,
  message,
  type = "general",
  relatedId = null,
  relatedModel = null,
  link = "",
}) => {
  try {
    if (!userId || !isDbConnected()) return null;

    const notification = await Notification.create({
      userId,
      title: title.trim(),
      message: message.trim(),
      type,
      relatedId: relatedId || null,
      relatedModel: relatedModel || null,
      link: link || "",
      isRead: false,
    });

    const unreadCount = await Notification.countDocuments({
      userId,
      isRead: false,
    });

    notifyNotificationEvent({
      userId,
      notification,
      unreadCount,
    });

    return notification;
  } catch (error) {
    console.error("Failed to create notification:", error.message);
    return null;
  }
};

/**
 * Retrieves the count of unread notifications for a user.
 *
 * @param {string|mongoose.Types.ObjectId} userId
 * @returns {Promise<number>}
 */
const getUnreadCount = async (userId) => {
  try {
    if (!userId || !isDbConnected()) return 0;
    return await Notification.countDocuments({
      userId,
      isRead: false,
    });
  } catch (error) {
    console.error("Failed to get unread notification count:", error.message);
    return 0;
  }
};

module.exports = {
  createNotification,
  getUnreadCount,
};
