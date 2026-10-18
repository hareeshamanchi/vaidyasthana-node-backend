const mongoose = require("mongoose");
const Medication = require("../models/Medication");
const DoseEvent = require("../models/DoseEvent");
const Report = require("../models/Report");
const {
  isDoctorAuthorizedForPatient,
} = require("../services/clinicalAuthorizationService");
const {
  generateDoseEventsForDate,
  evaluateMissedDoses,
  formatDateInTimezone,
} = require("../services/medicationReminderService");

/**
 * Helper to resolve target patient ID with strict role-based access control.
 * Patients can ONLY access their own data. Doctors can ONLY access authorized patients.
 */
const resolveAuthorizedPatientId = async (req) => {
  const user = req.user;
  if (!user) return null;

  if (user.role === "patient") {
    return user._id || user.id;
  }

  // Doctor or Admin requesting on behalf of a patient
  const targetPatientId = req.query.patientId || req.body.patientId || req.params.patientId;
  if (!targetPatientId) {
    return null;
  }

  if (user.role === "doctor") {
    const isAuthorized = await isDoctorAuthorizedForPatient(user, targetPatientId);
    if (!isAuthorized) {
      return false; // Specifically unauthorized
    }
    return targetPatientId;
  }

  if (user.role === "admin") {
    return targetPatientId;
  }

  return false;
};

/**
 * GET /api/medications
 * List medication schedules for patient (or authorized doctor).
 */
const getMedications = async (req, res) => {
  try {
    const patientId = await resolveAuthorizedPatientId(req);
    if (patientId === false) {
      return res.status(403).json({
        success: false,
        message: "You are not clinically authorized to view this patient's medication records.",
      });
    }
    if (!patientId) {
      return res.status(400).json({
        success: false,
        message: "Patient ID is required.",
      });
    }

    const { status } = req.query;
    const filter = { patientId };

    if (status && ["active", "paused", "ended"].includes(status)) {
      filter.status = status;
    } else if (status !== "all") {
      // By default, return active schedules first, or all if not specified
    }

    const medications = await Medication.find(filter)
      .populate("prescribedBy", "name specialization")
      .populate("prescriptionRef", "originalName blobUrl fileType")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: medications.length,
      medications,
    });
  } catch (error) {
    console.error("Error fetching medications:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve medications.",
      error: error.message,
    });
  }
};

/**
 * POST /api/medications
 * Create a new medication schedule.
 */
const createMedication = async (req, res) => {
  try {
    const user = req.user;
    let patientId;
    let source = "patient_entered";
    let prescribedBy = null;
    let prescriberName = "";

    if (user.role === "patient") {
      patientId = user._id || user.id;
    } else if (user.role === "doctor") {
      const targetPatientId = req.body.patientId;
      if (!targetPatientId) {
        return res.status(400).json({
          success: false,
          message: "Patient ID is required when prescribing as a doctor.",
        });
      }
      const isAuthorized = await isDoctorAuthorizedForPatient(user, targetPatientId);
      if (!isAuthorized) {
        return res.status(403).json({
          success: false,
          message: "You are not authorized to create prescriptions for this patient.",
        });
      }
      patientId = targetPatientId;
      source = "doctor_prescribed";
      prescribedBy = user._id || user.id;
      prescriberName = `Dr. ${user.name}`;
    } else if (user.role === "admin") {
      patientId = req.body.patientId;
      if (!patientId) {
        return res.status(400).json({
          success: false,
          message: "Patient ID is required.",
        });
      }
    }

    const {
      name,
      dosage,
      dosageUnit,
      frequency,
      reminderTimes,
      foodTiming,
      instructions,
      startDate,
      endDate,
      timezone,
      prescriptionRef,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Medication name is required.",
      });
    }

    if (!dosage || !String(dosage).trim()) {
      return res.status(400).json({
        success: false,
        message: "Dosage amount is required.",
      });
    }

    if (!reminderTimes || !Array.isArray(reminderTimes) || reminderTimes.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one reminder time (HH:mm) is required.",
      });
    }

    // Validate 24h format "HH:mm"
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    const invalidTime = reminderTimes.find((t) => !timeRegex.test(t));
    if (invalidTime) {
      return res.status(400).json({
        success: false,
        message: `Invalid reminder time format '${invalidTime}'. Expected 24h 'HH:mm' (e.g. '08:00', '20:30').`,
      });
    }

    const validTimezone = timezone || "Asia/Kolkata";

    const medication = await Medication.create({
      patientId,
      name: name.trim(),
      dosage: String(dosage).trim(),
      dosageUnit: dosageUnit ? String(dosageUnit).trim() : "mg",
      frequency: frequency || "once_daily",
      reminderTimes,
      foodTiming: foodTiming || "no_food_restriction",
      instructions: instructions ? instructions.trim() : "",
      startDate: startDate ? new Date(startDate) : new Date(),
      endDate: endDate ? new Date(endDate) : null,
      timezone: validTimezone,
      source,
      prescribedBy,
      prescriberName,
      prescriptionRef: prescriptionRef || null,
      status: "active",
    });

    // Proactively generate today's doses for this patient
    const todayStr = formatDateInTimezone(new Date(), validTimezone);
    await generateDoseEventsForDate(patientId, todayStr, { timeZone: validTimezone });

    return res.status(201).json({
      success: true,
      message: "Medication schedule created successfully.",
      medication,
    });
  } catch (error) {
    console.error("Error creating medication schedule:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create medication schedule.",
      error: error.message,
    });
  }
};

/**
 * GET /api/medications/:id
 * Retrieve single medication schedule by ID.
 */
const getMedicationById = async (req, res) => {
  try {
    const { id } = req.params;
    const medication = await Medication.findById(id)
      .populate("prescribedBy", "name specialization")
      .populate("prescriptionRef", "originalName blobUrl");

    if (!medication) {
      return res.status(404).json({
        success: false,
        message: "Medication schedule not found.",
      });
    }

    // Authorization check
    const user = req.user;
    if (user.role === "patient" && medication.patientId.toString() !== user.id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You do not own this medication schedule.",
      });
    }

    if (user.role === "doctor") {
      const isAuthorized = await isDoctorAuthorizedForPatient(user, medication.patientId);
      if (!isAuthorized) {
        return res.status(403).json({
          success: false,
          message: "You are not authorized to view this patient's medication schedule.",
        });
      }
    }

    return res.status(200).json({
      success: true,
      medication,
    });
  } catch (error) {
    console.error("Error retrieving medication:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve medication.",
      error: error.message,
    });
  }
};

/**
 * PUT /api/medications/:id
 * Update an existing medication schedule.
 */
const updateMedication = async (req, res) => {
  try {
    const { id } = req.params;
    const medication = await Medication.findById(id);

    if (!medication) {
      return res.status(404).json({
        success: false,
        message: "Medication schedule not found.",
      });
    }

    // Verify ownership or doctor authorization
    const user = req.user;
    if (user.role === "patient" && medication.patientId.toString() !== user.id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You do not own this medication schedule.",
      });
    }

    if (user.role === "doctor") {
      const isAuthorized = await isDoctorAuthorizedForPatient(user, medication.patientId);
      if (!isAuthorized) {
        return res.status(403).json({
          success: false,
          message: "You are not clinically authorized to modify this patient's medication schedule.",
        });
      }
    }

    const {
      name,
      dosage,
      dosageUnit,
      frequency,
      reminderTimes,
      foodTiming,
      instructions,
      startDate,
      endDate,
      timezone,
      prescriptionRef,
    } = req.body;

    if (name) medication.name = name.trim();
    if (dosage) medication.dosage = String(dosage).trim();
    if (dosageUnit) medication.dosageUnit = String(dosageUnit).trim();
    if (frequency) medication.frequency = frequency;
    if (foodTiming) medication.foodTiming = foodTiming;
    if (instructions !== undefined) medication.instructions = instructions ? instructions.trim() : "";
    if (startDate) medication.startDate = new Date(startDate);
    if (endDate !== undefined) medication.endDate = endDate ? new Date(endDate) : null;
    if (timezone) medication.timezone = timezone;
    if (prescriptionRef !== undefined) medication.prescriptionRef = prescriptionRef || null;

    if (reminderTimes && Array.isArray(reminderTimes) && reminderTimes.length > 0) {
      const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
      const invalidTime = reminderTimes.find((t) => !timeRegex.test(t));
      if (invalidTime) {
        return res.status(400).json({
          success: false,
          message: `Invalid reminder time format '${invalidTime}'. Expected 'HH:mm'.`,
        });
      }
      medication.reminderTimes = reminderTimes;
    }

    await medication.save();

    // Re-generate today's doses with updated parameters
    const todayStr = formatDateInTimezone(new Date(), medication.timezone || "Asia/Kolkata");
    await generateDoseEventsForDate(medication.patientId, todayStr, {
      timeZone: medication.timezone || "Asia/Kolkata",
    });

    return res.status(200).json({
      success: true,
      message: "Medication schedule updated successfully.",
      medication,
    });
  } catch (error) {
    console.error("Error updating medication:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update medication schedule.",
      error: error.message,
    });
  }
};

/**
 * PATCH /api/medications/:id/status
 * Pause, resume, or end a medication schedule.
 */
const updateMedicationStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!["active", "paused", "ended"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status. Allowed values: 'active', 'paused', 'ended'.",
      });
    }

    const medication = await Medication.findById(id);
    if (!medication) {
      return res.status(404).json({
        success: false,
        message: "Medication schedule not found.",
      });
    }

    const user = req.user;
    if (user.role === "patient" && medication.patientId.toString() !== user.id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Access denied.",
      });
    }

    if (user.role === "doctor") {
      const isAuthorized = await isDoctorAuthorizedForPatient(user, medication.patientId);
      if (!isAuthorized) {
        return res.status(403).json({
          success: false,
          message: "You are not authorized to update this medication status.",
        });
      }
    }

    medication.status = status;
    if (status === "ended" && !medication.endDate) {
      medication.endDate = new Date();
    }
    await medication.save();

    // If ended or paused, clean up un-taken future Scheduled dose records
    if (status === "paused" || status === "ended") {
      await DoseEvent.deleteMany({
        medicationId: medication._id,
        status: "Scheduled",
        scheduledTime: { $gt: new Date() },
      });
    } else if (status === "active") {
      // Re-generate today's schedule
      const todayStr = formatDateInTimezone(new Date(), medication.timezone || "Asia/Kolkata");
      await generateDoseEventsForDate(medication.patientId, todayStr, {
        timeZone: medication.timezone || "Asia/Kolkata",
      });
    }

    return res.status(200).json({
      success: true,
      message: `Medication schedule marked as ${status}.`,
      medication,
    });
  } catch (error) {
    console.error("Error updating medication status:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update status.",
      error: error.message,
    });
  }
};

/**
 * DELETE /api/medications/:id
 * Delete medication schedule and its future scheduled doses.
 */
const deleteMedication = async (req, res) => {
  try {
    const { id } = req.params;
    const medication = await Medication.findById(id);

    if (!medication) {
      return res.status(404).json({
        success: false,
        message: "Medication schedule not found.",
      });
    }

    const user = req.user;
    if (user.role === "patient" && medication.patientId.toString() !== user.id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Access denied.",
      });
    }

    if (user.role === "doctor") {
      const isAuthorized = await isDoctorAuthorizedForPatient(user, medication.patientId);
      if (!isAuthorized) {
        return res.status(403).json({
          success: false,
          message: "Unauthorized.",
        });
      }
    }

    // Remove future scheduled doses to avoid orphan reminders
    await DoseEvent.deleteMany({
      medicationId: medication._id,
      status: "Scheduled",
      scheduledTime: { $gte: new Date() },
    });

    await Medication.findByIdAndDelete(id);

    return res.status(200).json({
      success: true,
      message: "Medication schedule deleted successfully.",
    });
  } catch (error) {
    console.error("Error deleting medication:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete medication schedule.",
      error: error.message,
    });
  }
};

/**
 * GET /api/medications/doses
 * Get doses for a specific calendar date (YYYY-MM-DD), with summary metrics.
 */
const getDosesByDate = async (req, res) => {
  try {
    const patientId = await resolveAuthorizedPatientId(req);
    if (patientId === false) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized to access patient dose tracking.",
      });
    }
    if (!patientId) {
      return res.status(400).json({
        success: false,
        message: "Patient ID is required.",
      });
    }

    const { date, timezone } = req.query;
    const userTimezone = timezone || "Asia/Kolkata";
    const dateStr = date || formatDateInTimezone(new Date(), userTimezone);

    // Ensure today's or selected date's doses are generated
    await generateDoseEventsForDate(patientId, dateStr, { timeZone: userTimezone });

    // Evaluate any overdue doses lazily
    await evaluateMissedDoses({ patientId, now: Date.now() });

    const doses = await DoseEvent.find({
      patientId,
      scheduledDate: dateStr,
    }).sort({ scheduledTime: 1, reminderTime: 1 });

    const summary = {
      total: doses.length,
      taken: doses.filter((d) => d.status === "Taken").length,
      skipped: doses.filter((d) => d.status === "Skipped").length,
      missed: doses.filter((d) => d.status === "Missed").length,
      scheduled: doses.filter((d) => d.status === "Scheduled").length,
    };

    return res.status(200).json({
      success: true,
      date: dateStr,
      summary,
      doses,
    });
  } catch (error) {
    console.error("Error retrieving daily doses:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve doses.",
      error: error.message,
    });
  }
};

/**
 * PATCH /api/medications/doses/:id
 * Record dose action: Taken, Skipped, or Snooze.
 */
const updateDoseStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, action, snoozeMinutes, notes } = req.body;

    const dose = await DoseEvent.findById(id);
    if (!dose) {
      return res.status(404).json({
        success: false,
        message: "Dose event not found.",
      });
    }

    const user = req.user;
    if (user.role === "patient" && dose.patientId.toString() !== user.id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You cannot modify another patient's dose.",
      });
    }

    if (user.role === "doctor") {
      const isAuthorized = await isDoctorAuthorizedForPatient(user, dose.patientId);
      if (!isAuthorized) {
        return res.status(403).json({
          success: false,
          message: "Unauthorized.",
        });
      }
    }

    // Handle Snooze action without marking as taken or completed
    if (action === "snooze") {
      const mins = Math.max(5, Math.min(120, Number(snoozeMinutes) || 15));
      dose.snoozeUntil = new Date(Date.now() + mins * 60 * 1000);
      dose.reminderSent = false; // Reset so user receives another alert when snooze expires
      dose.status = "Scheduled";
      if (notes) dose.notes = notes.trim();
      await dose.save();

      return res.status(200).json({
        success: true,
        message: `Dose snoozed for ${mins} minutes.`,
        dose,
      });
    }

    // Handle Status Transitions: Taken, Skipped, Scheduled
    if (!["Taken", "Skipped", "Scheduled"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid dose status. Permitted: 'Taken', 'Skipped', 'Scheduled'.",
      });
    }

    dose.status = status;
    dose.actionTime = status === "Scheduled" ? null : new Date();
    if (notes !== undefined) dose.notes = notes ? notes.trim() : "";
    if (status !== "Scheduled") {
      dose.snoozeUntil = null;
    }

    await dose.save();

    return res.status(200).json({
      success: true,
      message: `Dose recorded as ${status}.`,
      dose,
    });
  } catch (error) {
    console.error("Error updating dose status:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update dose status.",
      error: error.message,
    });
  }
};

/**
 * GET /api/medications/adherence
 * Calculate comprehensive adherence statistics across 7, 30, or 90 days.
 * Never penalizes future scheduled doses.
 */
const getAdherenceStats = async (req, res) => {
  try {
    const patientId = await resolveAuthorizedPatientId(req);
    if (patientId === false) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized to access patient adherence metrics.",
      });
    }
    if (!patientId) {
      return res.status(400).json({
        success: false,
        message: "Patient ID is required.",
      });
    }

    const days = parseInt(req.query.days, 10) || 30;
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    // Only past evaluated doses (scheduledTime <= now) are considered for adherence calculation
    const pastDoses = await DoseEvent.find({
      patientId,
      scheduledTime: { $gte: cutoffDate, $lte: now },
    });

    const takenCount = pastDoses.filter((d) => d.status === "Taken").length;
    const skippedCount = pastDoses.filter((d) => d.status === "Skipped").length;
    const missedCount = pastDoses.filter((d) => d.status === "Missed").length;
    const totalEvaluated = takenCount + skippedCount + missedCount;

    // Adherence rate: percentage of taken doses out of all completed/evaluated doses
    const adherenceRate = totalEvaluated === 0 ? 100 : Math.round((takenCount / totalEvaluated) * 100);

    // Grouping by medication
    const breakdownMap = {};
    for (const dose of pastDoses) {
      const key = dose.medicationId.toString();
      if (!breakdownMap[key]) {
        breakdownMap[key] = {
          medicationId: key,
          name: dose.medicationName,
          dosage: dose.dosage,
          dosageUnit: dose.dosageUnit,
          taken: 0,
          skipped: 0,
          missed: 0,
          total: 0,
        };
      }
      breakdownMap[key].total += 1;
      if (dose.status === "Taken") breakdownMap[key].taken += 1;
      if (dose.status === "Skipped") breakdownMap[key].skipped += 1;
      if (dose.status === "Missed") breakdownMap[key].missed += 1;
    }

    const medicationBreakdown = Object.values(breakdownMap).map((item) => ({
      ...item,
      adherenceRate: item.total === 0 ? 100 : Math.round((item.taken / item.total) * 100),
    }));

    return res.status(200).json({
      success: true,
      windowDays: days,
      stats: {
        totalEvaluated,
        takenCount,
        skippedCount,
        missedCount,
        adherenceRate,
        medicationBreakdown,
      },
    });
  } catch (error) {
    console.error("Error calculating adherence stats:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to calculate adherence metrics.",
      error: error.message,
    });
  }
};

/**
 * GET /api/medications/prescriptions
 * Fetch existing prescription reports for linking to medication schedules.
 */
const getPatientPrescriptions = async (req, res) => {
  try {
    const patientId = await resolveAuthorizedPatientId(req);
    if (!patientId || patientId === false) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized.",
      });
    }

    const prescriptions = await Report.find({
      userId: patientId,
      category: { $regex: /prescription/i },
    }).select("_id originalName fileName blobUrl fileType createdAt").sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: prescriptions.length,
      prescriptions,
    });
  } catch (error) {
    console.error("Error fetching patient prescriptions:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve prescriptions.",
      error: error.message,
    });
  }
};

module.exports = {
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
};
