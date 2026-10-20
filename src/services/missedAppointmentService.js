/**
 * Vaidyasthana Missed Appointment Tracking Service
 *
 * Automatically detects consultations that were scheduled/confirmed but whose scheduled
 * window has elapsed without being marked completed, in progress, or cancelled.
 *
 * Rules:
 * - Uses configured clinic timezone (default "Asia/Kolkata").
 * - Evaluates after scheduled slot has passed.
 * - Transitions status to "Missed" in MongoDB Atlas.
 * - Updates any linked FollowUp record to "missed".
 * - Dispatches patient notification with rebooking and clinic contact guidance (never labels patient non-compliant).
 * - Dispatches doctor/clinic notification.
 * - Broadcasts real-time socket updates.
 * - Idempotent and safe for frequent execution.
 */

const mongoose = require("mongoose");
const Appointment = require("../models/Appointment");
const FollowUp = require("../models/FollowUp");
const { createNotification } = require("./notificationService");
const { notifyAppointmentEvent } = require("../config/socket");
const { parseTimeSlotToMinutes } = require("../utils/appointmentSorting");

let missedIntervalTimer = null;

const isDbConnected = () => mongoose.connection && mongoose.connection.readyState === 1;

const CLINIC_TIMEZONE = process.env.CLINIC_TIMEZONE || process.env.APP_TIMEZONE || "Asia/Kolkata";

/**
 * Returns current date and time components in clinic timezone.
 */
const getNowInClinicTz = (timeZone = CLINIC_TIMEZONE, customNow) => {
  const d = customNow ? new Date(customNow) : new Date();
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(d);
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    let hour = parseInt(map.hour, 10);
    if (hour === 24) hour = 0;
    const minute = parseInt(map.minute, 10);
    return {
      dateStr: `${map.year}-${map.month}-${map.day}`,
      currentMinutes: hour * 60 + minute,
      timeZone,
    };
  } catch {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return {
      dateStr: `${y}-${m}-${day}`,
      currentMinutes: d.getHours() * 60 + d.getMinutes(),
      timeZone,
    };
  }
};

/**
 * Extracts YYYY-MM-DD from an appointmentDate object or string.
 */
const extractDateOnly = (dateVal, timeZone = CLINIC_TIMEZONE) => {
  if (!dateVal) return "";
  if (typeof dateVal === "string") {
    const match = dateVal.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return "";
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(d);
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return d.toISOString().slice(0, 10);
  }
};

/**
 * Checks whether an appointment has ended and is eligible for "Missed" transition.
 * Standard appointment slot is 30 minutes. An appointment is missed if current time is
 * past the slot end time (start time + 30 mins) without completion or cancellation.
 */
const isAppointmentMissed = (appointment, nowClinic) => {
  if (!appointment) return false;
  const statusNorm = String(appointment.status || "").trim().toUpperCase();
  if (statusNorm !== "SCHEDULED" && statusNorm !== "CONFIRMED") {
    return false;
  }

  const apptDateStr = extractDateOnly(appointment.appointmentDate, nowClinic.timeZone);
  if (!apptDateStr) return false;

  // If date is before today in clinic timezone -> already elapsed
  if (apptDateStr < nowClinic.dateStr) {
    return true;
  }

  // If date is today, check if slot end time (slot start + 30 mins) has passed
  if (apptDateStr === nowClinic.dateStr) {
    const slotMins = parseTimeSlotToMinutes(appointment.timeSlot || appointment.startTime);
    if (slotMins !== -1) {
      const slotEndMins = slotMins + 30;
      if (nowClinic.currentMinutes >= slotEndMins) {
        return true;
      }
    }
  }

  return false;
};

/**
 * Evaluates and marks eligible appointments as "Missed".
 * Idempotent.
 *
 * @param {Object} [options]
 * @param {number|Date} [options.now] - Controllable clock for deterministic tests
 * @param {string} [options.timezone] - Clinic timezone override
 * @returns {Promise<Array<string>>} Array of missed appointment IDs
 */
const evaluateMissedAppointments = async (options = {}) => {
  try {
    if (!isDbConnected()) {
      return [];
    }

    const tz = options.timezone || CLINIC_TIMEZONE;
    const nowClinic = getNowInClinicTz(tz, options.now);

    // Find candidate appointments that are still Scheduled or Confirmed
    const candidates = await Appointment.find({
      status: { $in: ["Scheduled", "Confirmed"] },
    });

    if (!candidates || candidates.length === 0) {
      return [];
    }

    const missedIds = [];

    for (const appt of candidates) {
      if (isAppointmentMissed(appt, nowClinic)) {
        appt.status = "Missed";
        await appt.save();
        missedIds.push(String(appt._id));

        // If linked to a FollowUp plan, update follow-up status to "missed"
        if (appt.followUpId) {
          try {
            await FollowUp.findByIdAndUpdate(appt.followUpId, {
              status: "missed",
            });
          } catch (fuErr) {
            console.warn(`[MISSED_APPOINTMENTS] FollowUp status update error: ${fuErr.message}`);
          }
        }

        // Real-time socket event
        try {
          notifyAppointmentEvent({
            doctorId: appt.doctorId,
            patientId: appt.patientId,
            appointment: appt.toObject ? appt.toObject() : appt,
            action: "missed",
          });
        } catch {}

        // Supportive patient notification with rebooking and clinic contact option
        const apptDateStr = extractDateOnly(appt.appointmentDate, tz);
        createNotification({
          userId: appt.patientId,
          title: "Missed Consultation Notice",
          message: `Your scheduled consultation with Dr. ${appt.doctorName} on ${apptDateStr} (${appt.timeSlot}) was missed. Please rebook or reach out to clinic staff for assistance.`,
          type: "appointment_missed",
          relatedId: appt._id,
          relatedModel: "Appointment",
          link: "/appointment",
        }).catch((e) => console.warn(`[MISSED_APPOINTMENTS] Patient notify error: ${e.message}`));

        // Doctor / staff notification
        createNotification({
          userId: appt.doctorId,
          title: "Appointment Marked Missed",
          message: `Consultation with ${appt.patientName} scheduled for ${apptDateStr} at ${appt.timeSlot} was marked as missed.`,
          type: "appointment_missed",
          relatedId: appt._id,
          relatedModel: "Appointment",
          link: "/doctor-dashboard",
        }).catch((e) => console.warn(`[MISSED_APPOINTMENTS] Doctor notify error: ${e.message}`));
      }
    }

    if (missedIds.length > 0) {
      console.log(`[MISSED_APPOINTMENTS] Transitioned ${missedIds.length} appointment(s) to 'Missed'.`);
    }

    return missedIds;
  } catch (error) {
    console.error("[MISSED_APPOINTMENTS] Evaluation error:", error.message);
    return [];
  }
};

/**
 * Starts periodic missed appointment tracking worker.
 */
const startMissedAppointmentWorker = (intervalMs = 60000) => {
  if (missedIntervalTimer) {
    clearInterval(missedIntervalTimer);
    missedIntervalTimer = null;
  }

  evaluateMissedAppointments().catch((err) => {
    console.warn("[MISSED_APPOINTMENTS] Initial run warning:", err.message);
  });

  missedIntervalTimer = setInterval(() => {
    evaluateMissedAppointments().catch((err) => {
      console.warn("[MISSED_APPOINTMENTS] Periodic scan warning:", err.message);
    });
  }, intervalMs);

  if (missedIntervalTimer.unref) {
    missedIntervalTimer.unref();
  }

  return stopMissedAppointmentWorker;
};

/**
 * Stops periodic missed appointment tracking worker.
 */
const stopMissedAppointmentWorker = () => {
  if (missedIntervalTimer) {
    clearInterval(missedIntervalTimer);
    missedIntervalTimer = null;
  }
};

module.exports = {
  isAppointmentMissed,
  evaluateMissedAppointments,
  startMissedAppointmentWorker,
  stopMissedAppointmentWorker,
  getNowInClinicTz,
  extractDateOnly,
};
