const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  createPrescription,
  getPrescriptions,
  getPrescriptionById,
  downloadPrescriptionPDF,
  createMedicationRemindersFromPrescription,
  updatePrescriptionStatus,
} = require("../controllers/prescriptionController");

// All prescription operations require an authenticated session
router.use(protect);

// Issue prescription (Doctor only)
router.post("/", createPrescription);

// List prescriptions (Role & Tenant isolated)
router.get("/", getPrescriptions);

// View specific prescription details
router.get("/:id", getPrescriptionById);

// Download prescription as PDF
router.get("/:id/pdf", downloadPrescriptionPDF);

// Convert prescription into medication reminders (Patient / Doctor)
router.post("/:id/create-reminders", createMedicationRemindersFromPrescription);

// Update status (active, completed, cancelled)
router.patch("/:id/status", updatePrescriptionStatus);

module.exports = router;
