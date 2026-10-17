const express = require("express");
const router = express.Router();

const {
  getPendingDoctors,
  getAllDoctors,
  getDoctorDocumentAccessUrl,
  verifyDoctor,
  getAdminPlatformStats,
} = require("../controllers/adminController");

const { protect, authorizeRoles } = require("../middleware/authMiddleware");

// Enforce admin-only authentication and authorization across all routes
router.use(protect);
router.use(authorizeRoles("admin"));

router.get("/doctors/pending-verification", getPendingDoctors);
router.get("/doctors", getAllDoctors);
router.get("/doctors/:id/document/:docIndex", getDoctorDocumentAccessUrl);
router.post("/doctors/:id/verify", verifyDoctor);
router.get("/stats", getAdminPlatformStats);

module.exports = router;
