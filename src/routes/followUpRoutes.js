const express = require("express");
const router = express.Router();

const {
  createFollowUp,
  getFollowUps,
  getFollowUpById,
  updateFollowUp,
  cancelFollowUp,
  getDoctorFollowUpStats,
} = require("../controllers/followUpController");

const { protect } = require("../middleware/authMiddleware");

// All follow-up endpoints require authentication
router.use(protect);

router.get("/doctor/stats", getDoctorFollowUpStats);
router.post("/", createFollowUp);
router.get("/", getFollowUps);
router.get("/:id", getFollowUpById);
router.put("/:id", updateFollowUp);
router.patch("/:id/cancel", cancelFollowUp);

module.exports = router;
