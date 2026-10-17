const express = require("express");
const multer = require("multer");

const {
  uploadReport,
  getReports,
  getReportById,
  getReportStatus,
  retryReportAnalysis,
  viewReport,
  deleteReport,
  analyzeReport,
} = require("../controllers/uploadController");

const { protect } = require("../middleware/authMiddleware");

const router = express.Router();

// Multer memory storage with 25MB limit
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB
  },
});

// ============================
// Upload Reports
// POST /upload or POST /api/reports
// ============================
router.post("/", protect, upload.array("file"), uploadReport);

// ============================
// Get Logged-in User Reports
// GET /upload/all or GET /api/reports
// ============================
router.get("/all", protect, getReports);
router.get("/", protect, getReports);

// ============================
// Get Granular Processing Status of a Report
// GET /upload/:id/status or GET /upload/status/:id
// ============================
router.get("/:id/status", protect, getReportStatus);
router.get("/status/:id", protect, getReportStatus);

// ============================
// Retry Failed Processing for a Report
// POST /upload/:id/retry or POST /upload/retry/:id
// ============================
router.post("/:id/retry", protect, retryReportAnalysis);
router.post("/retry/:id", protect, retryReportAnalysis);

// ============================
// View Report (Generate SAS URL)
// GET /upload/view/:id or /upload/:id/view
// ============================
router.get("/view/:id", protect, viewReport);
router.get("/:id/view", protect, viewReport);

// ============================
// Trigger Analysis
// POST /upload/analyze/:id or /upload/:id/analyze
// ============================
router.post("/analyze/:id", protect, analyzeReport);
router.post("/:id/analyze", protect, analyzeReport);

// ============================
// Get Single Report by ID
// GET /upload/:id
// ============================
router.get("/:id", protect, getReportById);

// ============================
// Delete Report
// DELETE /upload/:id
// ============================
router.delete("/:id", protect, deleteReport);

module.exports = router;