const express = require("express");
const router = express.Router();

const {
  submitContactForm,
  getInquiries,
} = require("../controllers/contactController");

const { protect, authorizeRoles } = require("../middleware/authMiddleware");

// Public contact submission
router.post("/", submitContactForm);

// Doctor or Admin access to view inquiries
router.get("/", protect, authorizeRoles("doctor", "admin"), getInquiries);

module.exports = router;
