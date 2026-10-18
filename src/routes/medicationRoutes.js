const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  getMedications,
  createMedication,
  getMedicationById,
  updateMedication,
  updateMedicationStatus,
  deleteMedication,
  getDosesByDate,
  updateDoseStatus,
  getAdherenceStats,
  getPatientPrescriptions,
} = require("../controllers/medicationController");

// All medication operations require an authenticated session
router.use(protect);

// Dose tracking and adherence queries (Must precede :id)
router.get("/doses", getDosesByDate);
router.patch("/doses/:id", updateDoseStatus);
router.get("/adherence", getAdherenceStats);
router.get("/prescriptions", getPatientPrescriptions);

// Medication schedule CRUD
router.get("/", getMedications);
router.post("/", createMedication);
router.get("/:id", getMedicationById);
router.put("/:id", updateMedication);
router.patch("/:id/status", updateMedicationStatus);
router.delete("/:id", deleteMedication);

module.exports = router;
