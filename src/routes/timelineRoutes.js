const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const { getPatientTimeline } = require("../controllers/timelineController");

// Unified health timeline endpoints
router.get("/", protect, getPatientTimeline);
router.get("/:patientId", protect, getPatientTimeline);

module.exports = router;
