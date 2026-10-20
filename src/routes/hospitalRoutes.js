const express = require("express");
const router = express.Router();
const {
  createHospital,
  getHospitals,
  getHospitalById,
  updateHospital,
  updateHospitalStatus,
  updateSubscription,
  getPlatformMetrics,
} = require("../controllers/hospitalController");
const {
  protect,
  requirePlatformOwner,
  requireHospitalAdmin,
} = require("../middleware/authMiddleware");

// All routes require authentication
router.use(protect);

// Platform Owner exclusive routes
router.get("/metrics/platform", requirePlatformOwner, getPlatformMetrics);
router.post("/", requirePlatformOwner, createHospital);
router.get("/", requirePlatformOwner, getHospitals);
router.patch("/:id/status", requirePlatformOwner, updateHospitalStatus);
router.put("/:id/subscription", requirePlatformOwner, updateSubscription);

// Hospital-specific routes (Accessible by Platform Owner or the Hospital's Admin)
router.get("/:id", requireHospitalAdmin, getHospitalById);
router.put("/:id", requireHospitalAdmin, updateHospital);

module.exports = router;
