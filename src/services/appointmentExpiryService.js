/**
 * Vaidyasthana Appointment Automatic Expiry Service
 *
 * Implements reliable, idempotent status updates for video consultations:
 * - Identifies Scheduled/Confirmed video appointments whose 30-minute grace period has passed without an active consultation.
 * - Transitions status to "Expired" in MongoDB Atlas.
 * - Never overwrites Completed, Cancelled, Rejected, or In Progress appointments.
 * - Broadcasts real-time socket events to doctor and patient.
 * - Supports both on-demand lazy evaluation (e.g. during queries, Render spin-up) and periodic background cron.
 */

const Appointment = require("../models/Appointment");
const { isAppointmentExpired } = require("../utils/consultationWindow");
const { notifyAppointmentEvent } = require("../config/socket");
const mongoose = require("mongoose");

let expiryIntervalTimer = null;

/**
 * Checks database connection readiness before running queries.
 */
const isDbConnected = () => {
  return mongoose.connection && mongoose.connection.readyState === 1;
};

/**
 * Evaluates and marks eligible stale video appointments as "Expired".
 * Idempotent: can be called frequently without adverse side-effects.
 *
 * @param {Object} [options]
 * @param {string|mongoose.Types.ObjectId} [options.doctorId] - Scope to specific doctor
 * @param {string|mongoose.Types.ObjectId} [options.patientId] - Scope to specific patient
 * @param {number} [options.now=Date.now()] - Controllable clock for deterministic tests
 * @returns {Promise<Array<string>>} Array of expired appointment IDs
 */
const expireStaleAppointments = async (options = {}) => {
  try {
    if (!isDbConnected()) {
      return [];
    }

    const now = options.now || Date.now();

    // Query candidate appointments:
    // Only 'Scheduled' or 'Confirmed' video/online appointments can transition to 'Expired'.
    // Cancelled, Rejected, Completed, and In Progress appointments are strictly excluded.
    const query = {
      status: { $in: ["Scheduled", "Confirmed"] },
      consultationType: { $regex: /video|online/i },
    };

    if (options.doctorId) {
      query.doctorId = mongoose.Types.ObjectId.isValid(options.doctorId)
        ? new mongoose.Types.ObjectId(options.doctorId)
        : options.doctorId;
    }

    if (options.patientId) {
      query.patientId = mongoose.Types.ObjectId.isValid(options.patientId)
        ? new mongoose.Types.ObjectId(options.patientId)
        : options.patientId;
    }

    const candidates = await Appointment.find(query);
    if (!candidates || candidates.length === 0) {
      return [];
    }

    const expiredIds = [];

    for (const app of candidates) {
      if (isAppointmentExpired(app, now)) {
        app.status = "Expired";
        await app.save();
        expiredIds.push(String(app._id));

        // Real-time notification to patient and doctor
        try {
          notifyAppointmentEvent({
            doctorId: app.doctorId,
            patientId: app.patientId,
            appointment: app.toObject ? app.toObject() : app,
            action: "expired",
          });
        } catch (socketErr) {
          // Non-blocking socket failure
        }
      }
    }

    if (expiredIds.length > 0) {
      console.log(
        `[APPOINTMENT_EXPIRY] Evaluated and transitioned ${expiredIds.length} stale video appointment(s) to 'Expired'.`
      );
    }

    return expiredIds;
  } catch (error) {
    console.error("[APPOINTMENT_EXPIRY] Error evaluating expired appointments:", error.message);
    return [];
  }
};

/**
 * Starts periodic background expiry evaluation.
 * Runs an initial evaluation immediately on startup (for Render instance spin-up / restarts).
 *
 * @param {number} [intervalMs=60000] - Interval between evaluations (default 60 seconds)
 * @returns {Function} Stop cron cleanup function
 */
const startAppointmentExpiryCron = (intervalMs = 60000) => {
  // Clear any existing timer
  if (expiryIntervalTimer) {
    clearInterval(expiryIntervalTimer);
    expiryIntervalTimer = null;
  }

  // Initial immediate run on server startup
  expireStaleAppointments().catch((err) => {
    console.warn("[APPOINTMENT_EXPIRY] Initial startup scan warning:", err.message);
  });

  // Schedule periodic background check
  expiryIntervalTimer = setInterval(() => {
    expireStaleAppointments().catch((err) => {
      console.warn("[APPOINTMENT_EXPIRY] Periodic background scan warning:", err.message);
    });
  }, intervalMs);

  // Unref timer so it doesn't hold Node process open in test environments
  if (expiryIntervalTimer.unref) {
    expiryIntervalTimer.unref();
  }

  return stopAppointmentExpiryCron;
};

/**
 * Stops the background expiry cron.
 */
const stopAppointmentExpiryCron = () => {
  if (expiryIntervalTimer) {
    clearInterval(expiryIntervalTimer);
    expiryIntervalTimer = null;
  }
};

module.exports = {
  expireStaleAppointments,
  startAppointmentExpiryCron,
  stopAppointmentExpiryCron,
};
