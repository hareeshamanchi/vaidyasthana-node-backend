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

let reminderWorkerTimer = null;
const DEFAULT_GRACE_PERIOD_MS = 2 * 60 * 60 * 1000; // 2 hours

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
 * Checks for due medication reminders and broadcasts real-time notifications.
 * Idempotent: uses atomic reminderSent: true flag to guarantee single dispatch.
 */
const processDueReminders = async (options = {}) => {
  if (!isDbConnected()) return [];

  const now = options.now || Date.now();
  const nowDate = new Date(now);

  // Find Scheduled doses due up to now where reminderSent is false and snooze expired
  const query = {
    status: "Scheduled",
    scheduledTime: { $lte: nowDate },
    reminderSent: false,
    $or: [{ snoozeUntil: null }, { snoozeUntil: { $lte: nowDate } }],
  };

  if (options.patientId) {
    query.patientId = options.patientId;
  }

  const dueDoses = await DoseEvent.find(query);
  const dispatchedReminders = [];

  for (const dose of dueDoses) {
    // Atomically claim this reminder
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
        },
      },
      { returnDocument: "after" }
    );

    if (updated) {
      dispatchedReminders.push(updated);

      const foodNote = formatFoodTiming(updated.foodTiming);
      const instructionText = updated.instructions ? ` - Note: ${updated.instructions}` : "";

      await createNotification({
        userId: updated.patientId,
        title: `Medication Reminder: ${updated.medicationName}`,
        message: `Time to take ${updated.dosage} ${updated.dosageUnit} of ${updated.medicationName} (${foodNote})${instructionText}.`,
        type: "medication_reminder",
        relatedId: updated.medicationId,
        relatedModel: "Medication",
        link: "/medications",
      });
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
const startMedicationReminderWorker = (intervalMs = 60000) => {
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
