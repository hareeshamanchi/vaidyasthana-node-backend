const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  getVapidKey,
  subscribe,
  unsubscribe,
  testPush,
} = require("../controllers/pushController");

// Public route to retrieve VAPID public key
router.get("/vapid-key", getVapidKey);

// Protected routes for push subscription management
router.post("/subscribe", protect, subscribe);
router.post("/unsubscribe", protect, unsubscribe);
router.post("/test", protect, testPush);

module.exports = router;
