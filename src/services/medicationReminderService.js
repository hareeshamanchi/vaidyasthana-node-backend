/**
 * Vaidyasthana Medication Reminder & Dose Tracking Service
 *
 * Implements:
 * - Deterministic dose generation for active schedules with zero duplicates.
 * - Periodic background worker for due reminders & real-time Socket.IO alerts.
 * - Missed dose grace period evaluation (default: 2 hours after scheduled reminder time).
 * - Timezone-aware date calculations.
 * - Idempotent notification tracking across server restarts.
 */

const mongoose = require("mongoose");
const Medication = require("../models/Medication");
const DoseEvent = require("../models/DoseEvent");
const { createNotification } = require("./notificationService");
const { sendPushToUser } = require("./pushNotificationService");
const { getIO } = require("../config/socket");

let reminderWorkerTimer = null;
const DEFAULT_GRACE_PERIOD_MS = 2 * 60 * 60 * 1000; // 2 hours
const REPEAT_ALERT_INTERVAL_MS = 90 * 1000; // 90 seconds repeating alerts
const MAX_REPEAT_ALERTS = 20; // Server-side rate limit cap for repeating alerts

const isDbConnected = () => mongoose.connection && mongoose.connection.readyState === 1;

/**
 * Returns the timezone offset in milliseconds for an IANA timezone string at a given reference date.
 */
const getTimezoneOffsetMs = (timeZone = "Asia/Kolkata", date = new Date()) => {
  try {
    const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
    const tzDate = new Date(date.toLocaleString("en-US", { timeZone }));
    return tzDate.getTime() - utcDate.getTime();
  } catch {
    // Fallback to IST (+05:30 = 330 minutes)
    return 330 * 60 * 1000;
  }
};

/**
 * Computes exact UTC Date corresponding to a scheduledDate (YYYY-MM-DD) and reminderTime (HH:mm) in a timezone.
 */
const parseScheduledTimeToUtc = (dateStr, timeStr, timeZone = "Asia/Kolkata") => {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hours, minutes] = timeStr.split(":").map(Number);

  const baseUtcMs = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
  const offsetMs = getTimezoneOffsetMs(timeZone, new Date(baseUtcMs));
  return new Date(baseUtcMs - offsetMs);
};

/**
 * Formats a Date object into "YYYY-MM-DD" string for a specific timezone.
 */
const formatDateInTimezone = (date = new Date(), timeZone = "Asia/Kolkata") => {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(date);
  } catch {
    return date.toISOString().split("T")[0];
  }
};

/**
 * Formats food instructions for friendly user-facing reminder messages.
 */
const formatFoodTiming = (foodTiming) => {
  switch (foodTiming) {
    case "before_food":
      return "Take before food";
    case "after_food":
      return "Take after food";
    case "with_food":
      return "Take with food";
    case "empty_stomach":
      return "Take on an empty stomach";
    default:
      return "No food restriction";
  }
};

/**
 * Generates dose event records for a patient on a specific date (YYYY-MM-DD).
 * Idempotent: relies on atomic findOneAndUpdate with $setOnInsert to prevent duplicates and preserve state.
 */
const generateDoseEventsForDate = async (patientId, dateStr, options = {}) => {
  if (!isDbConnected() || !patientId || !dateStr) return [];

  const timeZone = options.timeZone || "Asia/Kolkata";
  const startOfDayUtc = parseScheduledTimeToUtc(dateStr, "00:00", timeZone);
  const endOfDayUtc = parseScheduledTimeToUtc(dateStr, "23:59", timeZone);

  // Find active medications for this patient whose active window covers dateStr
  const medications = await Medication.find({
    patientId,
    status: "active",
    startDate: { $lte: endOfDayUtc },
    $or: [{ endDate: null }, { endDate: { $gte: startOfDayUtc } }],
  });

  const createdOrExistingDoses = [];

  for (const med of medications) {
    if (!med.reminderTimes || med.reminderTimes.length === 0) continue;

    for (const time of med.reminderTimes) {
      const scheduledTime = parseScheduledTimeToUtc(dateStr, time, med.timezone || timeZone);

      try {
        const dose = await DoseEvent.findOneAndUpdate(
          {
            medicationId: med._id,
            scheduledDate: dateStr,
            reminderTime: time,
          },
          {
            $setOnInsert: {
              patientId: med.patientId,
              medicationId: med._id,
              medicationName: med.name,
              dosage: med.dosage,
              dosageUnit: med.dosageUnit,
              foodTiming: med.foodTiming,
              instructions: med.instructions,
              source: med.source,
              scheduledDate: dateStr,
              reminderTime: time,
              scheduledTime,
              status: "Scheduled",
              reminderSent: false,
              missedEvaluated: false,
            },
          },
          {
            upsert: true,
            returnDocument: "after",
            setDefaultsOnInsert: true,
          }
        );

        if (dose) createdOrExistingDoses.push(dose);
      } catch (err) {
        // E11000 duplicate key race condition handled gracefully
        if (err.code === 11000) {
          const existing = await DoseEvent.findOne({
            medicationId: med._id,
            scheduledDate: dateStr,
            reminderTime: time,
          });
          if (existing) createdOrExistingDoses.push(existing);
        } else {
          console.error("Error generating dose event:", err.message);
        }
      }
    }
  }

  return createdOrExistingDoses;
};

/**
 * Evaluates and transitions overdue Scheduled doses to "Missed".
 * Respects grace period (default 2 hours) and snoozes.
 */
const evaluateMissedDoses = async (options = {}) => {
  if (!isDbConnected()) return [];

  const now = options.now || Date.now();
  const gracePeriodMs = options.gracePeriodMs || DEFAULT_GRACE_PERIOD_MS;
  const cutoffTime = new Date(now - gracePeriodMs);

  // Eligible doses: Scheduled, scheduledTime older than cutoff, and snooze expired (or not set)
  const query = {
    status: "Scheduled",
    scheduledTime: { $lte: cutoffTime },
    $or: [{ snoozeUntil: null }, { snoozeUntil: { $lte: new Date(now) } }],
  };

  if (options.patientId) {
    query.patientId = options.patientId;
  }

  const overdueDoses = await DoseEvent.find(query);
  const missedDoses = [];

  for (const dose of overdueDoses) {
    const updated = await DoseEvent.findOneAndUpdate(
      {
        _id: dose._id,
        status: "Scheduled",
      },
      {
        $set: {
          status: "Missed",
          missedEvaluated: true,
        },
      },
      { returnDocument: "after" }
    );

    if (updated) {
      missedDoses.push(updated);

      // Notify the patient about the missed dose with clinical guidance
      await createNotification({
        userId: updated.patientId,
        title: `Missed Dose: ${updated.medicationName}`,
        message: `Your scheduled dose of ${updated.medicationName} (${updated.dosage} ${updated.dosageUnit}) at ${updated.reminderTime} was missed. Do not double up on doses. Consult your doctor or pharmacist if unsure.`,
        type: "medication_missed",
        relatedId: updated.medicationId,
        relatedModel: "Medication",
        link: "/medications",
      });
    }
  }

  return missedDoses;
};

/**
 * Checks for due medication reminders and broadcasts real-time & push notifications.
 * Handles both:
 * 1. Initial due dose detection (atomic claim with reminderSent: true)
 * 2. Repeating due dose alerts every 90 seconds while dose remains Scheduled & pending (up to maxAlerts)
 */
const processDueReminders = async (options = {}) => {
  if (!isDbConnected()) return [];

  const now = options.now || Date.now();
  const nowDate = new Date(now);
  const repeatIntervalMs = options.repeatIntervalMs || REPEAT_ALERT_INTERVAL_MS;
  const maxRepeats = options.maxRepeats || MAX_REPEAT_ALERTS;

  const dispatchedReminders = [];

  // 1. Initial Due Doses (reminderSent: false)
  const initialQuery = {
    status: "Scheduled",
    scheduledTime: { $lte: nowDate },
    reminderSent: false,
    $or: [{ snoozeUntil: null }, { snoozeUntil: { $lte: nowDate } }],
  };

  if (options.patientId) {
    initialQuery.patientId = options.patientId;
  }

  const initialDueDoses = await DoseEvent.find(initialQuery);

  for (const dose of initialDueDoses) {
    const updated = await DoseEvent.findOneAndUpdate(
      {
        _id: dose._id,
        reminderSent: false,
        status: "Scheduled",
      },
      {
        $set: {
          reminderSent: true,
          reminderSentAt: nowDate,
          lastAlertAt: nowDate,
        },
        $inc: { alertCount: 1 },
      },
      { returnDocument: "after" }
    );

    if (updated) {
      dispatchedReminders.push(updated);

      const foodNote = formatFoodTiming(updated.foodTiming);
      const instructionText = updated.instructions ? ` - Note: ${updated.instructions}` : "";
      const notificationTitle = `Medication Reminder: ${updated.medicationName}`;
      const notificationMessage = `Time to take ${updated.dosage} ${updated.dosageUnit} of ${updated.medicationName} (${foodNote})${instructionText}.`;

      // 1a. Persistent In-App Notification (and Socket.IO broadcast via notificationService)
      await createNotification({
        userId: updated.patientId,
        title: notificationTitle,
        message: notificationMessage,
        type: "medication_reminder",
        relatedId: updated.medicationId,
        relatedModel: "Medication",
        link: "/medications",
      });

      // 1b. Background Web Push (delivered even when browser tab is closed)
      try {
        await sendPushToUser(updated.patientId, {
          title: notificationTitle,
          body: notificationMessage,
          tag: "medication-due-reminder",
          data: { url: "/medications", doseId: updated._id.toString() },
        });
      } catch (pushErr) {
        console.warn("[MEDICATION_REMINDER] Initial push dispatch warning:", pushErr.message);
      }
    }
  }

  // 2. Repeating Pending Doses (every 90 seconds while Scheduled and unacknowledged)
  const repeatCutoff = new Date(now - repeatIntervalMs);
  const repeatingQuery = {
    status: "Scheduled",
    reminderSent: true,
    lastAlertAt: { $lte: repeatCutoff },
    alertCount: { $lt: maxRepeats },
    $or: [{ snoozeUntil: null }, { snoozeUntil: { $lte: nowDate } }],
  };

  if (options.patientId) {
    repeatingQuery.patientId = options.patientId;
  }

  const repeatingDueDoses = await DoseEvent.find(repeatingQuery);

  for (const dose of repeatingDueDoses) {
    const updated = await DoseEvent.findOneAndUpdate(
      {
        _id: dose._id,
        status: "Scheduled",
        lastAlertAt: { $lte: repeatCutoff },
      },
      {
        $set: {
          lastAlertAt: nowDate,
        },
        $inc: { alertCount: 1 },
      },
      { returnDocument: "after" }
    );

    if (updated) {
      dispatchedReminders.push(updated);

      const foodNote = formatFoodTiming(updated.foodTiming);
      const repeatMessage = `Pending dose: ${updated.dosage} ${updated.dosageUnit} of ${updated.medicationName} (${foodNote}). Please take your medication.`;

      // 2a. Real-time Socket.IO alert to active clients
      try {
        const io = getIO();
        if (io) {
          io.to(`user:${updated.patientId}`).emit("medication:due_repeat", {
            doseId: updated._id,
            medicationName: updated.medicationName,
            dosage: updated.dosage,
            dosageUnit: updated.dosageUnit,
            alertCount: updated.alertCount,
            timestamp: nowDate.toISOString(),
          });
        }
      } catch (socketErr) {
        // Socket emission failure is non-blocking
      }

      // 2b. Background Web Push (system notification replaces previous with tag)
      try {
        await sendPushToUser(updated.patientId, {
          title: `Medication Dose Due: ${updated.medicationName}`,
          body: repeatMessage,
          tag: "medication-due-reminder",
          data: { url: "/medications", doseId: updated._id.toString() },
        });
      } catch (pushErr) {
        console.warn("[MEDICATION_REMINDER] Repeating push dispatch warning:", pushErr.message);
      }
    }
  }

  return dispatchedReminders;
};

/**
 * Background tick runner: generates today's doses, processes due reminders, and checks missed doses.
 */
const runMedicationReminderCycle = async () => {
  if (!isDbConnected()) return;

  try {
    // 1. Process due reminders
    await processDueReminders();

    // 2. Evaluate missed doses
    await evaluateMissedDoses();
  } catch (error) {
    console.error("Error in medication reminder cycle:", error.message);
  }
};

/**
 * Starts periodic background worker.
 */
const startMedicationReminderWorker = (intervalMs = 30000) => {
  if (reminderWorkerTimer) {
    clearInterval(reminderWorkerTimer);
  }

  console.log(`⏱️ Starting medication reminder worker (every ${intervalMs / 1000}s)...`);
  // Run initial cycle shortly after launch
  setTimeout(() => {
    runMedicationReminderCycle().catch(() => {});
  }, 5000);

  reminderWorkerTimer = setInterval(() => {
    runMedicationReminderCycle().catch((err) => {
      console.error("Medication worker tick error:", err.message);
    });
  }, intervalMs);
};

/**
 * Stops background worker.
 */
const stopMedicationReminderWorker = () => {
  if (reminderWorkerTimer) {
    clearInterval(reminderWorkerTimer);
    reminderWorkerTimer = null;
    console.log("🛑 Medication reminder worker stopped.");
  }
};

module.exports = {
  DEFAULT_GRACE_PERIOD_MS,
  REPEAT_ALERT_INTERVAL_MS,
  MAX_REPEAT_ALERTS,
  getTimezoneOffsetMs,
  parseScheduledTimeToUtc,
  formatDateInTimezone,
  formatFoodTiming,
  generateDoseEventsForDate,
  processDueReminders,
  evaluateMissedDoses,
  runMedicationReminderCycle,
  startMedicationReminderWorker,
  stopMedicationReminderWorker,
};
