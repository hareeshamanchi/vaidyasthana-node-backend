const express = require("express");
const router = express.Router();

const {
  getAdminDashboardOverview,
  getAdminPlatformStats,
  getAdminUsers,
  getAdminUserDetails,
  updateUserStatus,
  getPendingDoctors,
  getAllDoctors,
  getDoctorDocumentAccessUrl,
  verifyDoctor,
  getAdminAppointments,
  updateAdminAppointment,
  getAdminReports,
  getAdminAuditLogs,
  getAdminSecurityOverview,
  getAdminSystemHealth,
  getAdminSupportQueries,
  updateSupportQueryStatus,
  getAdminNotifications,
} = require("../controllers/adminController");

const { protect, requireSuperAdmin } = require("../middleware/authMiddleware");

// Enforce authentication and administrative authorization across ALL routes
router.use(protect);
router.use(requireSuperAdmin);

// 1. Overview & Statistics
router.get("/overview", getAdminDashboardOverview);
router.get("/stats", getAdminPlatformStats);

// 2. User Management
router.get("/users", getAdminUsers);
router.get("/users/:id", getAdminUserDetails);
router.patch("/users/:id/status", updateUserStatus);

// 3. Doctor Verification
router.get("/doctors/pending-verification", getPendingDoctors);
router.get("/doctors", getAllDoctors);
router.get("/doctors/:id/document/:docIndex", getDoctorDocumentAccessUrl);
router.post("/doctors/:id/verify", verifyDoctor);

// 4. Global Appointment Administration
router.get("/appointments", getAdminAppointments);
router.patch("/appointments/:id", updateAdminAppointment);

// 5. Medical Reports Operational Storage
router.get("/reports", getAdminReports);

// 6. Security Dashboard & Audit Logs
router.get("/security/overview", getAdminSecurityOverview);
router.get("/security/audit-logs", getAdminAuditLogs);

// 7. System Health and Operations
router.get("/system-health", getAdminSystemHealth);

// 8. Support and Contact Management
router.get("/support", getAdminSupportQueries);
router.patch("/support/:id", updateSupportQueryStatus);

// 9. Administrator Notifications
router.get("/notifications", getAdminNotifications);

module.exports = router;
