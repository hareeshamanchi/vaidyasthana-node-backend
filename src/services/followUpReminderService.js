/**
 * Vaidyasthana Smart Follow-Up Automated Reminder Service
 *
 * Implements backend-driven, persistent scheduled checks for doctor-recommended follow-up plans:
 * - Operates in clinic timezone ("Asia/Kolkata").
 * - Multi-stage reminder milestones:
 *     - "upcoming_3d": 3 days before recommended follow-up date
 *     - "upcoming_1d": 1 day before recommended follow-up date
 *     - "due_today": On recommended follow-up date
 *     - "overdue": 2 days after recommended date if appointment is still pending booking
 * - Delivers in-app persistent notifications and background Web Push alerts (closed-tab support).
 * - Enforces strict idempotency via followUp.remindersSent audit records (no duplicate deliveries).
 * - Enforces privacy safety: Lock-screen push payloads never disclose clinical diagnosis, symptoms, or sensitive tests.
 * - Clearly distinguishes between recommended care date vs confirmed scheduled appointment date.
 */

const mongoose = require("mongoose");
const FollowUp = require("../models/FollowUp");
const { createNotification } = require("./notificationService");
const { sendPushToUser } = require("./pushNotificationService");
const { getNowInClinicTz, extractDateOnly } = require("./missedAppointmentService");

let reminderIntervalTimer = null;

const isDbConnected = () => mongoose.connection && mongoose.connection.readyState === 1;

const CLINIC_TIMEZONE = process.env.CLINIC_TIMEZONE || process.env.APP_TIMEZONE || "Asia/Kolkata";

/**
 * Calculates day difference between target date and current clinic date.
 * Positive = target date is in the future.
 * 0 = target date is today.
 * Negative = target date is in the past.
 */
const getDayDifference = (targetDateVal, nowClinic) => {
  const targetStr = extractDateOnly(targetDateVal, nowClinic.timeZone);
  if (!targetStr) return null;

  const [tY, tM, tD] = targetStr.split("-").map(Number);
  const [nY, nM, nD] = nowClinic.dateStr.split("-").map(Number);

  const tUtc = Date.UTC(tY, tM - 1, tD);
  const nUtc = Date.UTC(nY, nM - 1, nD);

  const diffMs = tUtc - nUtc;
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
};

/**
 * Determines which reminder milestone (if any) is currently due for a follow-up plan.
 *
 * @param {Object} followUp
 * @param {Object} nowClinic
 * @returns {string|null} Milestone name or null
 */
const determineDueMilestone = (followUp, nowClinic) => {
  if (!followUp || followUp.status === "completed" || followUp.status === "cancelled") {
    return null;
  }

  const diffDays = getDayDifference(followUp.recommendedDate, nowClinic);
  if (diffDays === null) return null;

  const alreadySent = new Set((followUp.remindersSent || []).map((r) => r.type));

  // If follow-up still needs appointment booking
  if (followUp.status === "pending_booking") {
    if (diffDays === 3 && !alreadySent.has("upcoming_3d")) {
      return "upcoming_3d";
    }
    if (diffDays === 1 && !alreadySent.has("upcoming_1d")) {
      return "upcoming_1d";
    }
    if (diffDays === 0 && !alreadySent.has("due_today")) {
      return "due_today";
    }
    if (diffDays <= -2 && !alreadySent.has("overdue")) {
      return "overdue";
    }
  }

  // If appointment has already been booked, remind of upcoming consultation
  if (followUp.status === "appointment_booked") {
    if (diffDays === 1 && !alreadySent.has("booked_1d")) {
      return "booked_1d";
    }
    if (diffDays === 0 && !alreadySent.has("booked_today")) {
      return "booked_today";
    }
  }

  return null;
};

/**
 * Builds privacy-safe in-app and lock-screen Web Push notification contents.
 * Strictly avoids exposing sensitive diagnosis or clinical condition on lock-screen!
 */
const buildReminderContent = (followUp, milestone, dateStr) => {
  const docTitle = followUp.doctorName.startsWith("Dr.")
    ? followUp.doctorName
    : `Dr. ${followUp.doctorName}`;

  switch (milestone) {
    case "upcoming_3d":
      return {
        title: "Upcoming Follow-Up Care",
        inAppMessage: `Your recommended follow-up with ${docTitle} is coming up on ${dateStr}. Please schedule your appointment to secure your preferred slot.`,
        pushBody: `You have an upcoming follow-up with ${docTitle} recommended for ${dateStr}. Tap to schedule your visit.`,
        type: "follow_up_reminder",
      };
    case "upcoming_1d":
      return {
        title: "Follow-Up Consultation Tomorrow",
        inAppMessage: `Friendly reminder: Your follow-up with ${docTitle} is recommended for tomorrow (${dateStr}). Book your consultation today.`,
        pushBody: `Your follow-up with ${docTitle} is recommended for tomorrow. Tap to reserve your slot.`,
        type: "follow_up_reminder",
      };
    case "due_today":
      return {
        title: "Follow-Up Consultation Due Today",
        inAppMessage: `Your care follow-up with ${docTitle} is due today (${dateStr}). Please book your consultation to keep your care plan on track.`,
        pushBody: `Your follow-up with ${docTitle} is due today. Tap to book your consultation.`,
        type: "follow_up_due",
      };
    case "overdue":
      return {
        title: "Care Follow-Up Pending",
        inAppMessage: `Your follow-up with ${docTitle} was recommended for ${dateStr}. If you haven't scheduled your review, please book a convenient slot or contact the clinic.`,
        pushBody: `Your recommended follow-up with ${docTitle} is pending. Tap to schedule a convenient appointment.`,
        type: "follow_up_due",
      };
    case "booked_1d":
      return {
        title: "Confirmed Follow-Up Tomorrow",
        inAppMessage: `Reminder: You have a confirmed follow-up appointment with ${docTitle} scheduled for tomorrow.`,
        pushBody: `Reminder: Confirmed appointment with ${docTitle} tomorrow.`,
        type: "follow_up_reminder",
      };
    case "booked_today":
      return {
        title: "Follow-Up Appointment Today",
        inAppMessage: `Reminder: Your confirmed follow-up appointment with ${docTitle} is scheduled for today.`,
        pushBody: `Appointment today with ${docTitle}. Check your dashboard for details.`,
        type: "follow_up_due",
      };
    default:
      return {
        title: "Follow-Up Care Notice",
        inAppMessage: `Care update from ${docTitle}. Please review your follow-up plan.`,
        pushBody: `Care plan update from ${docTitle}. Tap to view.`,
        type: "follow_up_reminder",
      };
  }
};

/**
 * Scans active follow-up plans, evaluates milestones, and dispatches reminders.
 * Enforces idempotency via followUp.remindersSent.
 *
 * @param {Object} [options]
 * @param {number|Date} [options.now] - Controllable clock for deterministic tests
 * @param {string} [options.timezone] - Timezone override
 * @returns {Promise<{ evaluated: number, sent: number }>}
 */
const evaluateFollowUpReminders = async (options = {}) => {
  try {
    if (!isDbConnected()) {
      return { evaluated: 0, sent: 0 };
    }

    const tz = options.timezone || CLINIC_TIMEZONE;
    const nowClinic = getNowInClinicTz(tz, options.now);

    // Fetch active follow-ups (pending_booking or appointment_booked)
    const activeFollowUps = await FollowUp.find({
      status: { $in: ["pending_booking", "appointment_booked"] },
    });

    if (!activeFollowUps || activeFollowUps.length === 0) {
      return { evaluated: 0, sent: 0 };
    }

    let sentCount = 0;

    for (const fu of activeFollowUps) {
      const milestone = determineDueMilestone(fu, nowClinic);
      if (!milestone) continue;

      const dateStr = extractDateOnly(fu.recommendedDate, tz);
      const content = buildReminderContent(fu, milestone, dateStr);

      // 1. Deliver persistent in-app notification
      await createNotification({
        userId: fu.patientId,
        title: content.title,
        message: content.inAppMessage,
        type: content.type,
        relatedId: fu._id,
        relatedModel: "FollowUp",
        link: fu.status === "pending_booking" ? `/appointment?followUpId=${fu._id}&doctorId=${fu.doctorId}` : "/dashboard",
      });

      // 2. Deliver background Web Push alert (works when browser/tab is closed)
      try {
        await sendPushToUser(fu.patientId, {
          title: content.title,
          body: content.pushBody,
          tag: `follow-up-${fu._id}-${milestone}`,
          data: {
            url: fu.status === "pending_booking" ? `/appointment?followUpId=${fu._id}&doctorId=${fu.doctorId}` : "/dashboard",
          },
        });
      } catch (pushErr) {
        // Non-blocking push error
      }

      // 3. Persist audit record in remindersSent array for strict idempotency
      fu.remindersSent.push({
        type: milestone,
        sentAt: new Date(options.now || Date.now()),
        channel: "in_app_and_push",
      });
      await fu.save();

      sentCount++;
    }

    if (sentCount > 0) {
      console.log(`[FOLLOW_UP_REMINDERS] Dispatched ${sentCount} scheduled follow-up reminder(s).`);
    }

    return { evaluated: activeFollowUps.length, sent: sentCount };
  } catch (error) {
    console.error("[FOLLOW_UP_REMINDERS] Error evaluating follow-up reminders:", error.message);
    return { evaluated: 0, sent: 0 };
  }
};

/**
 * Starts background follow-up reminder worker.
 */
const startFollowUpReminderWorker = (intervalMs = 60000) => {
  if (reminderIntervalTimer) {
    clearInterval(reminderIntervalTimer);
    reminderIntervalTimer = null;
  }

  evaluateFollowUpReminders().catch((err) => {
    console.warn("[FOLLOW_UP_REMINDERS] Initial run warning:", err.message);
  });

  reminderIntervalTimer = setInterval(() => {
    evaluateFollowUpReminders().catch((err) => {
      console.warn("[FOLLOW_UP_REMINDERS] Periodic scan warning:", err.message);
    });
  }, intervalMs);

  if (reminderIntervalTimer.unref) {
    reminderIntervalTimer.unref();
  }

  return stopFollowUpReminderWorker;
};

/**
 * Stops background follow-up reminder worker.
 */
const stopFollowUpReminderWorker = () => {
  if (reminderIntervalTimer) {
    clearInterval(reminderIntervalTimer);
    reminderIntervalTimer = null;
  }
};

module.exports = {
  determineDueMilestone,
  buildReminderContent,
  evaluateFollowUpReminders,
  startFollowUpReminderWorker,
  stopFollowUpReminderWorker,
  getDayDifference,
};
