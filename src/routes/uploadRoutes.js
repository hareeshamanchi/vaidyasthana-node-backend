const express = require("express");
const multer = require("multer");

const {
  uploadReport,
  getReports,
  viewReport,
} = require("../controllers/uploadController");

const {
  protect,
} = require("../middleware/authMiddleware");

const router = express.Router();

// Store uploaded files in memory
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB
  },
});

// ============================
// Upload Reports
// POST /upload
// ============================
router.post(
  "/",
  protect,
  upload.array("file"),
  uploadReport
);

// ============================
// Get Logged-in User Reports
// GET /upload/all
// ============================
router.get(
  "/all",
  protect,
  getReports
);

// ============================
// View Report (Generate SAS URL)
// GET /upload/view/:id
// ============================
router.get(
  "/view/:id",
  protect,
  viewReport
);

module.exports = router;