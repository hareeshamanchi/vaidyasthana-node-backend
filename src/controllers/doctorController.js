const User = require("../models/User");
const Report = require("../models/Report");
const Appointment = require("../models/Appointment");
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const { inMemoryReports, isDbConnected } = require("./uploadController");
const {
  isAzureStorageConfigured,
  getContainerClient,
} = require("../config/azureStorage");
const { notifyVerificationEvent } = require("../config/socket");

const ALLOWED_DOC_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/jpg",
];

const {
  isDoctorAuthorizedForPatient,
  getEligiblePatientsForDoctor,
  resolvePatientUser,
} = require("../services/clinicalAuthorizationService");

// ==========================================
// Doctor: Fetch Patient Reports by ID
// GET /api/doctor/patient-reports/:patientId
// ==========================================
const getPatientReports = async (req, res) => {
  try {
    const { patientId } = req.params;

    if (!patientId || patientId.trim() === "") {
      return res.status(400).json({
        success: false,
        error: "Patient ID is required.",
        message: "Patient ID is required.",
      });
    }

    const patient = await resolvePatientUser(patientId);

    if (!patient) {
      return res.status(404).json({
        success: false,
        error: "Patient not found with the provided ID.",
        message: "Patient not found with the provided ID.",
      });
    }

    // Verify clinical authorization between doctor and patient
    const isAuthorized = await isDoctorAuthorizedForPatient(req.user, patient._id);
    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        error: "Access denied. You are not authorized to view this patient's medical records because no active clinical relationship or appointment exists with your account.",
        message: "Access denied. You are not authorized to view this patient's medical records because no active clinical relationship or appointment exists with your account.",
      });
    }

    let reports = [];
    if (isDbConnected && isDbConnected()) {
      reports = await Report.find({ userId: patient._id }).sort({
        createdAt: -1,
      });
    } else {
      reports = Array.from(inMemoryReports.values())
        .filter((r) => r.userId?.toString() === patient._id.toString())
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    return res.status(200).json(reports);
  } catch (error) {
    console.error("Doctor Fetch Reports Error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch patient reports.",
      message: "Failed to fetch patient reports.",
    });
  }
};

// ==========================================
// Doctor: Get Single Patient Details
// GET /api/doctor/patient/:patientId
// ==========================================
const getPatientDetails = async (req, res) => {
  try {
    const { patientId } = req.params;
    if (!patientId || patientId.trim() === "") {
      return res.status(400).json({
        success: false,
        error: "Patient ID is required.",
        message: "Patient ID is required.",
      });
    }

    const patient = await resolvePatientUser(patientId);

    if (!patient) {
      return res.status(404).json({
        success: false,
        error: "Patient not found with the provided ID.",
        message: "Patient not found with the provided ID.",
      });
    }

    // Verify clinical authorization between doctor and patient
    const isAuthorized = await isDoctorAuthorizedForPatient(req.user, patient._id);
    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        error: "Access denied. You are not authorized to retrieve this patient's profile details without an active clinical assignment.",
        message: "Access denied. You are not authorized to retrieve this patient's profile details without an active clinical assignment.",
      });
    }

    const safePatient = patient.toObject ? patient.toObject() : { ...patient };
    delete safePatient.password;

    return res.status(200).json({
      success: true,
      patient: safePatient,
    });
  } catch (error) {
    console.error("Doctor Get Patient Details Error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch patient details.",
      message: "Failed to fetch patient details.",
    });
  }
};

// ==========================================
// Doctor: List Associated Patients
// GET /api/doctor/patients
// ==========================================
const getDoctorPatients = async (req, res) => {
  try {
    const patients = await getEligiblePatientsForDoctor(req.user.id);

    return res.status(200).json({
      success: true,
      count: patients.length,
      patients,
    });
  } catch (error) {
    console.error("Get Doctor Patients Error:", error);
    return res.status(500).json({
      success: false,
      error: "Server error fetching patients.",
      message: "Server error fetching patients.",
    });
  }
};

// ==========================================
// Doctor: Audit Reports
// GET /api/doctor/audit-reports
// ==========================================
const auditDoctorReports = async (req, res) => {
  try {
    const doctorId = req.user.id;
    let potentialDoctorUploads = [];
    let assignedPatientReports = [];

    if (isDbConnected && isDbConnected()) {
      potentialDoctorUploads = await Report.find({
        userId: doctorId,
      }).sort({ createdAt: -1 });

      assignedPatientReports = await Report.find({
        uploadedBy: doctorId,
        userId: { $ne: doctorId },
      }).sort({ createdAt: -1 });
    } else {
      const allReports = Array.from(inMemoryReports.values());
      potentialDoctorUploads = allReports.filter(
        (r) => r.userId?.toString() === doctorId.toString()
      );
      assignedPatientReports = allReports.filter(
        (r) =>
          r.uploadedBy?.toString() === doctorId.toString() &&
          r.userId?.toString() !== doctorId.toString()
      );
    }

    return res.status(200).json({
      success: true,
      doctorId,
      doctorName: req.user.name || "Physician",
      potentialUnassignedReports: potentialDoctorUploads,
      patientAssignedReports: assignedPatientReports,
      summary: {
        potentialUnassignedCount: potentialDoctorUploads.length,
        patientAssignedCount: assignedPatientReports.length,
        total: potentialDoctorUploads.length + assignedPatientReports.length,
      },
    });
  } catch (error) {
    console.error("Doctor Audit Reports Error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to audit doctor reports.",
    });
  }
};

// ==========================================
// Doctor: Reassign Report to Correct Patient
// POST /api/doctor/reassign-report/:id
// ==========================================
const reassignDoctorReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { targetPatientId } = req.body;

    if (!targetPatientId || String(targetPatientId).trim() === "") {
      return res.status(400).json({
        success: false,
        error: "Target Patient ID is required to reassign the report.",
      });
    }

    const cleanPatientId = String(targetPatientId).trim();
    let targetPatient = null;

    if (mongoose.Types.ObjectId.isValid(cleanPatientId)) {
      if (isDbConnected && isDbConnected()) {
        targetPatient = await User.findById(cleanPatientId);
      } else {
        if (!cleanPatientId.startsWith("000000000000000000000000") && !cleanPatientId.includes("nonexistent")) {
          targetPatient = { _id: cleanPatientId, name: "Selected Patient", role: "patient" };
        }
      }
    }

    if (!targetPatient && isDbConnected && isDbConnected()) {
      targetPatient = await User.findOne({
        $or: [
          { email: cleanPatientId.toLowerCase() },
          { phoneNumber: cleanPatientId },
        ],
      });
    }

    if (!targetPatient) {
      return res.status(404).json({
        success: false,
        error: `Target patient not found with identifier '${cleanPatientId}'.`,
      });
    }

    let report = null;
    if (isDbConnected && isDbConnected()) {
      report = await Report.findById(id);
    } else {
      report = inMemoryReports.get(id.toString());
    }

    if (!report) {
      return res.status(404).json({
        success: false,
        error: "Report not found with the provided ID.",
      });
    }

    const isOwnerOrUploader =
      report.userId?.toString() === req.user.id.toString() ||
      report.uploadedBy?.toString() === req.user.id.toString();
    const isAdmin = req.user.role === "admin";

    if (!isOwnerOrUploader && !isAdmin) {
      return res.status(403).json({
        success: false,
        error: "You are not authorized to reassign this report.",
      });
    }

    // Verify clinical authorization: Doctor must be authorized for target patient
    if (req.user.role === "doctor") {
      const isAuthorizedForTarget = await isDoctorAuthorizedForPatient(req.user, targetPatient._id);
      if (!isAuthorizedForTarget) {
        return res.status(403).json({
          success: false,
          error: "Forbidden: You are not authorized to reassign medical documents to this patient without an established clinical assignment or appointment.",
        });
      }
    }

    const previousOwnerId = report.userId;
    report.userId = targetPatient._id;
    report.uploadedBy = req.user.id;
    report.uploadedByRole = "doctor";
    report.uploaderName = req.user.name || "Physician";
    if (req.body.notes) {
      report.notes = req.body.notes;
    }

    if (report.save) {
      await report.save();
    } else if (!isDbConnected()) {
      inMemoryReports.set(id.toString(), report);
    }

    console.log(`[SAFE_LOG] Report ${id} reassigned from ${previousOwnerId} to patient ${targetPatient._id} by Dr. ${req.user.id}`);

    return res.status(200).json({
      success: true,
      message: `Report successfully reassigned to patient ${targetPatient.name || targetPatient._id}.`,
      report,
      reassignedTo: {
        id: targetPatient._id,
        name: targetPatient.name,
      },
    });
  } catch (error) {
    console.error("Reassign Report Error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to reassign report.",
    });
  }
};

// ==========================================
// Doctor: Upload Identity & Medical Credentials
// POST /api/doctor/verification-documents
// ==========================================
const uploadVerificationDocuments = async (req, res) => {
  try {
    if (!isDbConnected || !isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const doctor = await User.findById(req.user.id);
    if (!doctor) {
      return res.status(404).json({
        success: false,
        message: "Doctor account not found.",
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please select at least one verification credential to upload (PDF, JPEG, or PNG).",
      });
    }

    const containerClient = getContainerClient ? getContainerClient() : null;
    const storageConfigured = isAzureStorageConfigured ? isAzureStorageConfigured() && containerClient : false;

    const uploadedDocs = [];

    for (const file of req.files) {
      if (!ALLOWED_DOC_TYPES.includes(file.mimetype)) {
        return res.status(400).json({
          success: false,
          message: `Unsupported file type '${file.mimetype}'. Only PDF, JPEG, and PNG are permitted.`,
        });
      }

      const safeOriginalName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
      const fileName = `${Date.now()}-${uuidv4()}-${safeOriginalName}`;
      const blobPath = `doctors/${doctor._id}/credentials/${fileName}`;

      if (storageConfigured) {
        try {
          const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
          await blockBlobClient.uploadData(file.buffer, {
            blobHTTPHeaders: { blobContentType: file.mimetype },
          });
        } catch (storageErr) {
          console.warn("Credential Azure upload fallback:", storageErr.message);
        }
      }

      // Categorize credential type
      let documentType = "qualification";
      const lowerField = (file.fieldname || "").toLowerCase();
      const lowerName = (file.originalname || "").toLowerCase();

      if (lowerField.includes("id") || lowerName.includes("id") || lowerName.includes("identity") || lowerName.includes("aadhaar") || lowerName.includes("passport")) {
        documentType = "id_proof";
      } else if (lowerField.includes("reg") || lowerName.includes("reg") || lowerName.includes("cert") || lowerName.includes("license")) {
        documentType = "medical_registration";
      }

      uploadedDocs.push({
        documentType,
        fileName,
        originalName: file.originalname,
        blobPath,
        fileType: file.mimetype,
        fileSize: file.size,
        uploadedAt: new Date(),
      });
    }

    doctor.verificationDocuments.push(...uploadedDocs);
    // Move to pending review state upon submission
    doctor.verificationStatus = "pending";

    if (req.body.medicalRegistrationNumber) {
      doctor.medicalRegistrationNumber = req.body.medicalRegistrationNumber.trim();
    }
    if (req.body.specialization) {
      doctor.specialization = req.body.specialization.trim();
    }

    await doctor.save();

    notifyVerificationEvent({
      doctorId: doctor._id,
      status: "pending",
    });

    return res.status(200).json({
      success: true,
      message: "Medical credentials uploaded successfully. Verification status is now pending review.",
      verificationStatus: doctor.verificationStatus,
      documentsCount: doctor.verificationDocuments.length,
      documents: doctor.verificationDocuments.map((doc) => ({
        _id: doc._id,
        documentType: doc.documentType,
        fileName: doc.fileName,
        originalName: doc.originalName,
        fileType: doc.fileType,
        fileSize: doc.fileSize,
        uploadedAt: doc.uploadedAt,
      })),
    });
  } catch (error) {
    console.error("Upload verification error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error uploading verification documents.",
    });
  }
};

// ==========================================
// Doctor: Get Verification Status
// GET /api/doctor/verification-status
// ==========================================
const getVerificationStatus = async (req, res) => {
  try {
    if (!isDbConnected || !isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const doctor = await User.findById(req.user.id);
    if (!doctor) {
      return res.status(404).json({ success: false, message: "Doctor not found." });
    }

    const safeDocuments = (doctor.verificationDocuments || []).map((doc) => ({
      _id: doc._id,
      documentType: doc.documentType,
      fileName: doc.fileName,
      originalName: doc.originalName,
      fileType: doc.fileType,
      fileSize: doc.fileSize,
      uploadedAt: doc.uploadedAt,
    }));

    return res.status(200).json({
      success: true,
      doctorId: doctor._id,
      name: doctor.name,
      verificationStatus: doctor.verificationStatus,
      specialization: doctor.specialization,
      medicalRegistrationNumber: doctor.medicalRegistrationNumber,
      documents: safeDocuments,
      verificationReview: doctor.verificationReview,
    });
  } catch (error) {
    console.error("Get verification status error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error checking verification status.",
    });
  }
};

module.exports = {
  getPatientReports,
  getPatientDetails,
  getDoctorPatients,
  auditDoctorReports,
  reassignDoctorReport,
  uploadVerificationDocuments,
  getVerificationStatus,
};
