const express = require("express");
const multer = require("multer");
const router = express.Router();

const {
  getPatientReports,
  getPatientDetails,
  getDoctorPatients,
  auditDoctorReports,
  reassignDoctorReport,
  uploadVerificationDocuments,
  getVerificationStatus,
} = require("../controllers/doctorController");

const { protect, authorizeRoles } = require("../middleware/authMiddleware");

// Memory storage for secure credential processing
const storage = multer.memoryStorage();
const uploadCredentials = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB limit
});

// All clinician routes strictly enforce doctor or admin authorization
router.use(protect, authorizeRoles("doctor", "admin"));

// Patient dossier and clinical tools
router.get("/patient-reports/:patientId", getPatientReports);
router.get("/patient/:patientId", getPatientDetails);
router.get("/patients", getDoctorPatients);
router.get("/audit-reports", auditDoctorReports);
router.post("/reassign-report/:id", reassignDoctorReport);

// Doctor verification workflow
router.post(
  "/verification-documents",
  uploadCredentials.any(),
  uploadVerificationDocuments
);
router.get("/verification-status", getVerificationStatus);

module.exports = router;
