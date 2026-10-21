const mongoose = require("mongoose");
const Prescription = require("../models/Prescription");
const User = require("../models/User");
const Hospital = require("../models/Hospital");
const Appointment = require("../models/Appointment");
const Medication = require("../models/Medication");
const { createNotification } = require("../services/notificationService");
const { generatePrescriptionPDF } = require("../utils/prescriptionPdfGenerator");

const isDbConnected = () => mongoose.connection.readyState === 1;

/**
 * Helper to compute default reminder times from frequency
 */
const getDefaultReminderTimes = (frequency) => {
  switch (frequency) {
    case "once_daily":
      return ["08:00"];
    case "twice_daily":
      return ["08:00", "20:00"];
    case "thrice_daily":
      return ["08:00", "14:00", "20:00"];
    case "four_times_daily":
      return ["08:00", "12:00", "16:00", "20:00"];
    case "as_needed":
      return ["08:00"];
    default:
      return ["08:00"];
  }
};

/**
 * Helper to parse duration string (e.g. "5 days", "2 weeks", "1 month") into number of days
 */
const parseDurationDays = (durationStr) => {
  if (!durationStr || typeof durationStr !== "string") return 5;
  const match = durationStr.trim().match(/^(\d+)\s*(day|days|week|weeks|month|months)?/i);
  if (!match) return 5;
  const num = parseInt(match[1], 10);
  const unit = (match[2] || "days").toLowerCase();
  if (unit.startsWith("week")) return num * 7;
  if (unit.startsWith("month")) return num * 30;
  return num;
};

/**
 * Generate a unique, professional prescription number
 */
const generatePrescriptionNumber = (hospitalCode) => {
  const prefix = (hospitalCode || "RX").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${dateStr}-${randomSuffix}`;
};

/**
 * 1. Create a Digital Prescription (Doctor Only)
 * POST /api/prescriptions
 */
const createPrescription = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable. Please verify MONGODB_URI in environment.",
      });
    }

    const isDoctor = req.user.role === "doctor" || req.user.role === "admin";
    if (!isDoctor) {
      return res.status(403).json({
        success: false,
        message: "Only authorized medical clinicians can author and issue digital prescriptions.",
      });
    }

    const {
      patientId,
      appointmentId,
      diagnosis,
      vitals,
      medications,
      generalInstructions,
      followUpDate,
      isSigned,
    } = req.body;

    // Requirement 8: Clinician must confirm and sign off on the prescription
    if (!isSigned) {
      return res.status(400).json({
        success: false,
        message: "Clinician sign-off is mandatory. The authorized doctor must confirm and sign the prescription.",
      });
    }

    // Validate Patient
    if (!patientId || !mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({
        success: false,
        message: "A valid registered patient ID is required to issue a prescription.",
      });
    }

    const patient = await User.findById(patientId);
    if (!patient) {
      return res.status(404).json({
        success: false,
        message: "Patient record was not found in the verified healthcare database.",
      });
    }

    // Validate Diagnosis
    if (!diagnosis || !diagnosis.trim()) {
      return res.status(400).json({
        success: false,
        message: "Clinical diagnosis or primary medical indication is required.",
      });
    }

    // Validate Medications array
    if (!Array.isArray(medications) || medications.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one medication item is required in the prescription.",
      });
    }

    const validatedMedications = [];
    for (let i = 0; i < medications.length; i++) {
      const med = medications[i];
      if (!med.name || !med.name.trim()) {
        return res.status(400).json({
          success: false,
          message: `Medication #${i + 1} must include a valid medication name.`,
        });
      }
      if (!med.dosage || !String(med.dosage).trim()) {
        return res.status(400).json({
          success: false,
          message: `Medication '${med.name}' must include a dosage amount.`,
        });
      }
      if (!med.frequency || !med.frequency.trim()) {
        return res.status(400).json({
          success: false,
          message: `Medication '${med.name}' must include a frequency.`,
        });
      }
      if (!med.duration || !med.duration.trim()) {
        return res.status(400).json({
          success: false,
          message: `Medication '${med.name}' must include a duration (e.g. '5 days').`,
        });
      }

      const durationDays = med.durationDays || parseDurationDays(med.duration);
      const reminderTimes =
        Array.isArray(med.reminderTimes) && med.reminderTimes.length > 0
          ? med.reminderTimes
          : getDefaultReminderTimes(med.frequency);

      validatedMedications.push({
        name: med.name.trim(),
        dosage: String(med.dosage).trim(),
        dosageUnit: (med.dosageUnit || "mg").trim(),
        route: med.route || "Oral",
        frequency: med.frequency,
        timing: med.timing || "after_food",
        duration: med.duration.trim(),
        durationDays,
        instructions: (med.instructions || "").trim(),
        reminderTimes,
      });
    }

    // Retrieve Doctor & Hospital Metadata
    const doctor = await User.findById(req.user._id);
    let hospitalDoc = null;
    const targetHospitalId = doctor.hospitalId || req.user.hospitalId || null;

    if (targetHospitalId) {
      hospitalDoc = await Hospital.findById(targetHospitalId);
    }

    // Generate readable Unique Prescription Number
    const prescriptionNumber = generatePrescriptionNumber(hospitalDoc?.hospitalCode);

    // Compute patient age if DOB is present
    let patientAge = "";
    if (patient.dateOfBirth) {
      const diffMs = Date.now() - new Date(patient.dateOfBirth).getTime();
      const ageDate = new Date(diffMs);
      patientAge = `${Math.abs(ageDate.getUTCFullYear() - 1970)} yrs`;
    }

    // Verify appointment link if supplied
    let verifiedAppointmentId = null;
    if (appointmentId && mongoose.Types.ObjectId.isValid(appointmentId)) {
      const appt = await Appointment.findById(appointmentId);
      if (appt) {
        verifiedAppointmentId = appt._id;
      }
    }

    const prescription = await Prescription.create({
      prescriptionNumber,
      patientId: patient._id,
      patientName: patient.name,
      patientPhone: patient.phoneNumber || "",
      patientEmail: patient.email || "",
      patientAge,
      patientGender: patient.gender || "",
      doctorId: doctor._id,
      doctorName: doctor.name.startsWith("Dr.") ? doctor.name : `Dr. ${doctor.name}`,
      doctorSpecialization: doctor.specialization || "General Medicine",
      doctorQualifications: doctor.qualifications || "MBBS",
      doctorRegistrationNumber: doctor.medicalRegistrationNumber || "",
      hospitalId: hospitalDoc ? hospitalDoc._id : null,
      hospitalName: hospitalDoc ? hospitalDoc.name : "",
      hospitalCode: hospitalDoc ? hospitalDoc.hospitalCode : "",
      hospitalAddress: hospitalDoc ? `${hospitalDoc.address || ""} ${hospitalDoc.city || ""}`.trim() : "",
      hospitalPhone: hospitalDoc ? hospitalDoc.contactPhone || "" : "",
      appointmentId: verifiedAppointmentId,
      diagnosis: diagnosis.trim(),
      vitals: vitals || {},
      medications: validatedMedications,
      generalInstructions: (generalInstructions || "").trim(),
      followUpDate: followUpDate ? new Date(followUpDate) : null,
      status: "active",
      isSigned: true,
      signedAt: new Date(),
      signedByDoctorName: doctor.name.startsWith("Dr.") ? doctor.name : `Dr. ${doctor.name}`,
    });

    // Notify patient
    createNotification({
      userId: patient._id,
      title: "New Digital Prescription Issued",
      message: `${prescription.doctorName} has issued an electronic prescription (${prescription.prescriptionNumber}) for your consultation.`,
      type: "prescription_issued",
      link: "/dashboard",
    });

    return res.status(201).json({
      success: true,
      message: "Digital prescription issued and clinically signed successfully.",
      prescription,
    });
  } catch (error) {
    console.error("Create Prescription Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to author prescription.",
      error: error.message,
    });
  }
};

/**
 * 2. Get Prescriptions List (Role-Based & Tenant-Isolated)
 * GET /api/prescriptions
 */
const getPrescriptions = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const user = req.user;
    let query = {};

    // 1. Patient view: strictly their own prescriptions
    if (user.role === "patient") {
      query.patientId = user._id;
    }
    // 2. Doctor view: prescriptions prescribed by this doctor, or filtered by patient
    else if (user.role === "doctor") {
      if (req.query.patientId && mongoose.Types.ObjectId.isValid(req.query.patientId)) {
        query.patientId = new mongoose.Types.ObjectId(req.query.patientId);
      } else {
        query.doctorId = user._id;
      }
    }
    // 3. Hospital Admin view: strictly scoped to hospital tenant
    else if (user.role === "hospital_admin" || ["receptionist", "nurse", "billing_staff", "pharmacist"].includes(user.role)) {
      if (!user.hospitalId) {
        return res.status(403).json({
          success: false,
          message: "No hospital tenant associated with this staff account.",
        });
      }
      query.hospitalId = user.hospitalId;
      if (req.query.patientId && mongoose.Types.ObjectId.isValid(req.query.patientId)) {
        query.patientId = new mongoose.Types.ObjectId(req.query.patientId);
      }
      if (req.query.doctorId && mongoose.Types.ObjectId.isValid(req.query.doctorId)) {
        query.doctorId = new mongoose.Types.ObjectId(req.query.doctorId);
      }
    }
    // 4. Super Admin view: platform-wide or filtered
    else if (user.role === "superadmin" || user.role === "admin") {
      if (req.query.hospitalId && mongoose.Types.ObjectId.isValid(req.query.hospitalId)) {
        query.hospitalId = new mongoose.Types.ObjectId(req.query.hospitalId);
      }
      if (req.query.patientId && mongoose.Types.ObjectId.isValid(req.query.patientId)) {
        query.patientId = new mongoose.Types.ObjectId(req.query.patientId);
      }
      if (req.query.doctorId && mongoose.Types.ObjectId.isValid(req.query.doctorId)) {
        query.doctorId = new mongoose.Types.ObjectId(req.query.doctorId);
      }
    } else {
      return res.status(403).json({
        success: false,
        message: "Unauthorized to access prescriptions.",
      });
    }

    // Filter by appointment if specified
    if (req.query.appointmentId && mongoose.Types.ObjectId.isValid(req.query.appointmentId)) {
      query.appointmentId = new mongoose.Types.ObjectId(req.query.appointmentId);
    }

    // Filter by status if specified
    if (req.query.status && req.query.status !== "all") {
      query.status = req.query.status;
    }

    const prescriptions = await Prescription.find(query)
      .populate("hospitalId", "name hospitalCode city state")
      .populate("doctorId", "name specialization qualifications medicalRegistrationNumber clinicName")
      .populate("patientId", "name email phoneNumber dateOfBirth gender")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: prescriptions.length,
      prescriptions,
    });
  } catch (error) {
    console.error("Get Prescriptions Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve prescriptions.",
      error: error.message,
    });
  }
};

/**
 * 3. Get Prescription by ID (Role-Based Authorization & Tenant Isolation)
 * GET /api/prescriptions/:id
 */
const getPrescriptionById = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid prescription ID format.",
      });
    }

    const prescription = await Prescription.findById(id)
      .populate("hospitalId", "name hospitalCode city state address contactPhone contactEmail")
      .populate("doctorId", "name specialization qualifications medicalRegistrationNumber clinicName phoneNumber email")
      .populate("patientId", "name email phoneNumber dateOfBirth gender address");

    if (!prescription) {
      return res.status(404).json({
        success: false,
        message: "Prescription not found.",
      });
    }

    // Verify Access Permissions
    const user = req.user;
    const isPatientOwner = prescription.patientId?._id?.toString() === user._id.toString() || prescription.patientId?.toString() === user._id.toString();
    const isDoctorAuthor = prescription.doctorId?._id?.toString() === user._id.toString() || prescription.doctorId?.toString() === user._id.toString();
    const isSuperAdmin = user.role === "superadmin" || user.role === "admin";
    const isHospitalStaff = Boolean(
      user.hospitalId &&
      prescription.hospitalId &&
      (prescription.hospitalId?._id?.toString() || prescription.hospitalId.toString()) === user.hospitalId.toString()
    );

    if (!isPatientOwner && !isDoctorAuthor && !isSuperAdmin && !isHospitalStaff) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized: You do not have permission to view this prescription.",
      });
    }

    return res.status(200).json({
      success: true,
      prescription,
    });
  } catch (error) {
    console.error("Get Prescription By ID Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve prescription details.",
      error: error.message,
    });
  }
};

/**
 * 4. Download Prescription as PDF
 * GET /api/prescriptions/:id/pdf
 */
const downloadPrescriptionPDF = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid prescription ID format.",
      });
    }

    const prescription = await Prescription.findById(id)
      .populate("hospitalId", "name hospitalCode city state address contactPhone contactEmail")
      .populate("doctorId", "name specialization qualifications medicalRegistrationNumber clinicName phoneNumber email")
      .populate("patientId", "name email phoneNumber dateOfBirth gender address");

    if (!prescription) {
      return res.status(404).json({
        success: false,
        message: "Prescription not found.",
      });
    }

    // Verify Access Permissions
    const user = req.user;
    const isPatientOwner = prescription.patientId?._id?.toString() === user._id.toString() || prescription.patientId?.toString() === user._id.toString();
    const isDoctorAuthor = prescription.doctorId?._id?.toString() === user._id.toString() || prescription.doctorId?.toString() === user._id.toString();
    const isSuperAdmin = user.role === "superadmin" || user.role === "admin";
    const isHospitalStaff = Boolean(
      user.hospitalId &&
      prescription.hospitalId &&
      (prescription.hospitalId?._id?.toString() || prescription.hospitalId.toString()) === user.hospitalId.toString()
    );

    if (!isPatientOwner && !isDoctorAuthor && !isSuperAdmin && !isHospitalStaff) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized to download this prescription.",
      });
    }

    // Set Response Headers for PDF Download
    const fileName = `Prescription-${prescription.prescriptionNumber}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);

    // Stream PDF directly to Express response
    await generatePrescriptionPDF(prescription, res);
  } catch (error) {
    console.error("Download Prescription PDF Error:", error);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: "Failed to generate prescription PDF document.",
        error: error.message,
      });
    }
  }
};

/**
 * 5. Integrate with Medication Reminder System (Requirement 7)
 * POST /api/prescriptions/:id/create-reminders
 *
 * Seamlessly creates medication reminders for the patient from the prescription
 * without duplicating or breaking the existing reminder system.
 */
const createMedicationRemindersFromPrescription = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid prescription ID format.",
      });
    }

    const prescription = await Prescription.findById(id);
    if (!prescription) {
      return res.status(404).json({
        success: false,
        message: "Prescription not found.",
      });
    }

    // Security check: Only the patient or authorized doctor can sync reminders
    const user = req.user;
    const isPatientOwner = prescription.patientId.toString() === user._id.toString();
    const isDoctorAuthor = prescription.doctorId.toString() === user._id.toString();
    const isSuperAdmin = user.role === "superadmin" || user.role === "admin";

    if (!isPatientOwner && !isDoctorAuthor && !isSuperAdmin) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized: You can only configure medication reminders for your own prescribed regimen.",
      });
    }

    const patientId = prescription.patientId;
    const medications = prescription.medications || [];

    if (medications.length === 0) {
      return res.status(400).json({
        success: false,
        message: "This prescription does not contain any medications to schedule.",
      });
    }

    const createdReminders = [];
    const now = new Date();

    for (const med of medications) {
      // Check if reminder already exists for this prescription and medication name
      const existing = await Medication.findOne({
        patientId,
        prescriptionRef: prescription._id,
        name: { $regex: new RegExp(`^${med.name.trim()}$`, "i") },
      });

      if (existing) {
        // Already synchronized, keep track
        createdReminders.push(existing);
        continue;
      }

      const durationDays = med.durationDays || parseDurationDays(med.duration);
      const startDate = new Date(now.getTime());
      const endDate = new Date(startDate.getTime() + durationDays * 24 * 60 * 60 * 1000);

      const reminderTimes =
        Array.isArray(med.reminderTimes) && med.reminderTimes.length > 0
          ? med.reminderTimes
          : getDefaultReminderTimes(med.frequency);

      const newMedication = await Medication.create({
        patientId,
        name: med.name.trim(),
        dosage: med.dosage.trim(),
        dosageUnit: med.dosageUnit || "mg",
        frequency: med.frequency || "once_daily",
        reminderTimes,
        foodTiming: med.timing || "after_food",
        instructions: med.instructions
          ? `${med.instructions} (${med.duration})`
          : `Prescribed by ${prescription.doctorName} for ${med.duration}`,
        startDate,
        endDate,
        status: "active",
        source: "doctor_prescribed",
        prescribedBy: prescription.doctorId,
        prescriberName: prescription.doctorName,
        prescriptionRef: prescription._id,
        timezone: "Asia/Kolkata",
      });

      createdReminders.push(newMedication);
    }

    return res.status(200).json({
      success: true,
      message: `Successfully scheduled ${createdReminders.length} medication reminders from your prescription.`,
      count: createdReminders.length,
      reminders: createdReminders,
    });
  } catch (error) {
    console.error("Create Medication Reminders Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to configure medication reminders from prescription.",
      error: error.message,
    });
  }
};

/**
 * 6. Update Prescription Status
 * PATCH /api/prescriptions/:id/status
 */
const updatePrescriptionStatus = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const { id } = req.params;
    const { status } = req.body;

    if (!["active", "completed", "cancelled"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be 'active', 'completed', or 'cancelled'.",
      });
    }

    const prescription = await Prescription.findById(id);
    if (!prescription) {
      return res.status(404).json({
        success: false,
        message: "Prescription not found.",
      });
    }

    const user = req.user;
    const isDoctorAuthor = prescription.doctorId.toString() === user._id.toString();
    const isSuperAdmin = user.role === "superadmin" || user.role === "admin";
    const isHospitalStaff = Boolean(
      user.hospitalId &&
      prescription.hospitalId &&
      prescription.hospitalId.toString() === user.hospitalId.toString()
    );

    if (!isDoctorAuthor && !isSuperAdmin && !isHospitalStaff) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized to update this prescription.",
      });
    }

    prescription.status = status;
    await prescription.save();

    return res.status(200).json({
      success: true,
      message: `Prescription marked as ${status}.`,
      prescription,
    });
  } catch (error) {
    console.error("Update Prescription Status Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update prescription status.",
      error: error.message,
    });
  }
};

module.exports = {
  createPrescription,
  getPrescriptions,
  getPrescriptionById,
  downloadPrescriptionPDF,
  createMedicationRemindersFromPrescription,
  updatePrescriptionStatus,
};
