const express = require("express");
const router = express.Router();

const {
  getNotifications,
  getUnreadNotificationCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
} = require("../controllers/notificationController");

const { protect } = require("../middleware/authMiddleware");

// All notification routes require authenticated session
router.use(protect);

router.get("/", getNotifications);
router.get("/unread-count", getUnreadNotificationCount);
router.patch("/read-all", markAllNotificationsAsRead);
router.patch("/:id/read", markNotificationAsRead);
router.delete("/:id", deleteNotification);

module.exports = router;
