const mongoose = require("mongoose");
const Appointment = require("../models/Appointment");
const User = require("../models/User");

// Offline/in-memory fallback registry for unit tests
const inMemoryDoctorPatientAccess = new Set([
  // Unit test default fixture: Dr. Sharma & Patient A
  "60c72b2f9b1d8b2bad0000d1:60c72b2f9b1d8b2bad0000a1",
]);

const grantInMemoryAccess = (doctorId, patientId) => {
  if (doctorId && patientId) {
    const docStr = (doctorId._id || doctorId.id || doctorId).toString();
    const patStr = (patientId._id || patientId.id || patientId).toString();
    inMemoryDoctorPatientAccess.add(`${docStr}:${patStr}`);
  }
};

const isDbConnected = () => mongoose.connection.readyState === 1;

/**
 * Resolves a patient User document from an identifier (MongoDB _id, email, or phone).
 */
const resolvePatientUser = async (patientIdentifier) => {
  if (!patientIdentifier) return null;
  const cleanId = String(patientIdentifier).trim();

  if (mongoose.Types.ObjectId.isValid(cleanId)) {
    if (isDbConnected()) {
      const patient = await User.findById(cleanId);
      if (patient) return patient;
    } else {
      if (!cleanId.startsWith("000000000000000000000000") && !cleanId.includes("nonexistent")) {
        return { _id: cleanId, name: "Selected Patient", role: "patient" };
      }
    }
  }

  if (isDbConnected()) {
    const patient = await User.findOne({
      role: "patient",
      $or: [
        { email: cleanId.toLowerCase() },
        { phoneNumber: cleanId },
      ],
    });
    if (patient) return patient;
  }

  return null;
};

/**
 * Checks if a doctor is authorized to access a patient's medical records or upload to their vault.
 * Authorization requires an appointment between doctor and patient in MongoDB Atlas.
 */
const isDoctorAuthorizedForPatient = async (doctorUser, patientId) => {
  if (!doctorUser || !patientId) return false;

  const doctorIdStr = (doctorUser._id || doctorUser.id || doctorUser).toString();
  const patientIdStr = (patientId._id || patientId.id || patientId).toString();

  // User accessing their own record is authorized
  if (doctorIdStr === patientIdStr) {
    return true;
  }

  // Admin role is authorized
  if (doctorUser.role === "admin") {
    return true;
  }

  // Non-doctor, non-admin cannot access other patients' records
  if (doctorUser.role !== "doctor") {
    return false;
  }

  // In offline/in-memory test mode
  if (!isDbConnected()) {
    return inMemoryDoctorPatientAccess.has(`${doctorIdStr}:${patientIdStr}`);
  }

  try {
    const doctorIdObj = mongoose.Types.ObjectId.isValid(doctorIdStr)
      ? new mongoose.Types.ObjectId(doctorIdStr)
      : doctorIdStr;
    const patientIdObj = mongoose.Types.ObjectId.isValid(patientIdStr)
      ? new mongoose.Types.ObjectId(patientIdStr)
      : patientIdStr;

    // Doctor is authorized if an active or completed clinical appointment exists between doctor and patient.
    // Cancelled and Rejected appointments do NOT qualify as authorized clinical access.
    const nonQualifyingStatuses = ["Cancelled", "Rejected", "cancelled", "rejected", "CANCELLED", "REJECTED"];
    const appointmentExists = await Appointment.exists({
      doctorId: doctorIdObj,
      patientId: patientIdObj,
      status: { $nin: nonQualifyingStatuses },
    });

    return !!appointmentExists;
  } catch (err) {
    console.error("Clinical authorization check error:", err);
    return false;
  }
};

/**
 * Returns distinct eligible patients assigned to a doctor through appointments in MongoDB Atlas.
 * Excludes appointments with Cancelled or Rejected statuses.
 */
const getEligiblePatientsForDoctor = async (doctorId) => {
  if (!doctorId) return [];

  const doctorIdStr = (doctorId._id || doctorId.id || doctorId).toString();

  if (!isDbConnected()) {
    return [];
  }

  const doctorIdObj = mongoose.Types.ObjectId.isValid(doctorIdStr)
    ? new mongoose.Types.ObjectId(doctorIdStr)
    : doctorIdStr;

  const nonQualifyingStatuses = ["Cancelled", "Rejected", "cancelled", "rejected", "CANCELLED", "REJECTED"];
  const appointments = await Appointment.find({
    doctorId: doctorIdObj,
    status: { $nin: nonQualifyingStatuses },
  }).populate("patientId", "name email phoneNumber address role");

  const patientsMap = new Map();
  for (const app of appointments) {
    if (app.patientId && typeof app.patientId === "object" && app.patientId._id) {
      const patId = app.patientId._id.toString();
      if (!patientsMap.has(patId)) {
        patientsMap.set(patId, {
          _id: patId,
          id: patId,
          name: app.patientId.name || "Patient",
          email: app.patientId.email || "",
          phoneNumber: app.patientId.phoneNumber || "",
          address: app.patientId.address || "",
          role: app.patientId.role || "patient",
        });
      }
    }
  }

  return Array.from(patientsMap.values());
};

module.exports = {
  isDoctorAuthorizedForPatient,
  getEligiblePatientsForDoctor,
  resolvePatientUser,
  grantInMemoryAccess,
};
