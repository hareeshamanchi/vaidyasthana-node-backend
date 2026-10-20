const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const FollowUp = require("../src/models/FollowUp");
const Appointment = require("../src/models/Appointment");
const {
  determineDueMilestone,
  buildReminderContent,
  getDayDifference,
} = require("../src/services/followUpReminderService");
const {
  isAppointmentMissed,
  getNowInClinicTz,
  extractDateOnly,
} = require("../src/services/missedAppointmentService");

test("FollowUp Model - Schema Validation & Enums", async () => {
  const patientId = new mongoose.Types.ObjectId();
  const doctorId = new mongoose.Types.ObjectId();

  const validDoc = new FollowUp({
    patientId,
    doctorId,
    doctorName: "Dr. Aarthi",
    patientName: "Ramesh Kumar",
    reason: "Post-op wound evaluation",
    doctorInstructions: "Check suture site, keep dry, dress daily.",
    recommendedDate: new Date("2026-10-25"),
    priority: "soon",
    recommendedTests: ["Complete Blood Count (CBC)", "ESR"],
    notes: "Patient reports mild tenderness.",
  });

  const err = validDoc.validateSync();
  assert.equal(err, undefined, "Valid follow-up should not produce validation errors");
  assert.equal(validDoc.status, "pending_booking");
  assert.equal(validDoc.priority, "soon");
  assert.equal(validDoc.recommendedTests.length, 2);

  // Missing required fields
  const invalidDoc = new FollowUp({});
  const invErr = invalidDoc.validateSync();
  assert.ok(invErr.errors.patientId, "patientId is required");
  assert.ok(invErr.errors.doctorId, "doctorId is required");
  assert.ok(invErr.errors.reason, "reason is required");
  assert.ok(invErr.errors.doctorInstructions, "doctorInstructions is required");
  assert.ok(invErr.errors.recommendedDate, "recommendedDate is required");

  // Invalid priority enum
  const badPriorityDoc = new FollowUp({
    patientId,
    doctorId,
    doctorName: "Dr. Aarthi",
    patientName: "Ramesh Kumar",
    reason: "Routine check",
    doctorInstructions: "Instructions",
    recommendedDate: new Date(),
    priority: "super_emergency", // invalid
  });
  const badPriorityErr = badPriorityDoc.validateSync();
  assert.ok(badPriorityErr.errors.priority, "Invalid priority should fail validation");
});

test("Appointment Model - Missed status & followUpId support", async () => {
  const patientId = new mongoose.Types.ObjectId();
  const doctorId = new mongoose.Types.ObjectId();
  const followUpId = new mongoose.Types.ObjectId();

  const appt = new Appointment({
    patientId,
    doctorId,
    doctorName: "Dr. Sharma",
    patientName: "Ananya",
    appointmentDate: new Date("2026-10-20"),
    timeSlot: "10:00 AM",
    status: "Missed",
    followUpId,
    type: "Follow-up",
  });

  const err = appt.validateSync();
  assert.equal(err, undefined, "Missed status and followUpId should be valid in Appointment schema");
  assert.equal(appt.status, "Missed");
  assert.equal(appt.followUpId.toString(), followUpId.toString());
});

test("Missed Appointment Service - Timezone calculations & Slot expiry evaluation", () => {
  const clinicNow = getNowInClinicTz("Asia/Kolkata", new Date("2026-10-20T11:00:00.000Z"));
  assert.ok(clinicNow.dateStr, "Clinic date string should be computed");
  assert.ok(typeof clinicNow.currentMinutes === "number", "Clinic current minutes should be numeric");

  // Mock past appointment: yesterday
  const pastAppt = {
    status: "Scheduled",
    appointmentDate: "2026-10-18",
    timeSlot: "10:00 AM",
  };
  assert.equal(
    isAppointmentMissed(pastAppt, { dateStr: "2026-10-19", currentMinutes: 600, timeZone: "Asia/Kolkata" }),
    true,
    "Appointment scheduled before today should be detected as missed"
  );

  // Mock future appointment: tomorrow
  const futureAppt = {
    status: "Scheduled",
    appointmentDate: "2026-10-20",
    timeSlot: "10:00 AM",
  };
  assert.equal(
    isAppointmentMissed(futureAppt, { dateStr: "2026-10-19", currentMinutes: 600, timeZone: "Asia/Kolkata" }),
    false,
    "Appointment scheduled for tomorrow must never be marked missed"
  );

  // Mock today's appointment whose slot ended (10:00 AM start + 30 min end = 10:30 AM = 630 mins)
  // Current time is 11:00 AM (660 mins)
  const todayPastAppt = {
    status: "Scheduled",
    appointmentDate: "2026-10-19",
    timeSlot: "10:00 AM",
  };
  assert.equal(
    isAppointmentMissed(todayPastAppt, { dateStr: "2026-10-19", currentMinutes: 660, timeZone: "Asia/Kolkata" }),
    true,
    "Appointment whose slot has ended today should be detected as missed"
  );

  // Mock today's appointment before start time (current time 09:00 AM = 540 mins)
  const todayUpcomingAppt = {
    status: "Confirmed",
    appointmentDate: "2026-10-19",
    timeSlot: "10:00 AM",
  };
  assert.equal(
    isAppointmentMissed(todayUpcomingAppt, { dateStr: "2026-10-19", currentMinutes: 540, timeZone: "Asia/Kolkata" }),
    false,
    "Appointment before scheduled time today must not be marked missed"
  );

  // Already completed or cancelled appointments must NEVER be marked missed
  const completedAppt = {
    status: "Completed",
    appointmentDate: "2026-10-18",
    timeSlot: "10:00 AM",
  };
  assert.equal(
    isAppointmentMissed(completedAppt, { dateStr: "2026-10-19", currentMinutes: 600, timeZone: "Asia/Kolkata" }),
    false,
    "Completed appointments must never be marked missed"
  );
});

test("FollowUp Reminder Service - Milestones & Idempotency", () => {
  const nowClinic = {
    dateStr: "2026-10-20",
    currentMinutes: 600,
    timeZone: "Asia/Kolkata",
  };

  // 1. Follow-up 3 days in future -> upcoming_3d
  const fu3d = {
    status: "pending_booking",
    recommendedDate: "2026-10-23",
    remindersSent: [],
  };
  assert.equal(determineDueMilestone(fu3d, nowClinic), "upcoming_3d");

  // Idempotency: if upcoming_3d was already sent, do not send again
  fu3d.remindersSent.push({ type: "upcoming_3d" });
  assert.equal(determineDueMilestone(fu3d, nowClinic), null);

  // 2. Follow-up 1 day in future -> upcoming_1d
  const fu1d = {
    status: "pending_booking",
    recommendedDate: "2026-10-21",
    remindersSent: [],
  };
  assert.equal(determineDueMilestone(fu1d, nowClinic), "upcoming_1d");

  // 3. Follow-up due today -> due_today
  const fuToday = {
    status: "pending_booking",
    recommendedDate: "2026-10-20",
    remindersSent: [],
  };
  assert.equal(determineDueMilestone(fuToday, nowClinic), "due_today");

  // 4. Overdue follow-up (2 days past) -> overdue
  const fuOverdue = {
    status: "pending_booking",
    recommendedDate: "2026-10-18",
    remindersSent: [],
  };
  assert.equal(determineDueMilestone(fuOverdue, nowClinic), "overdue");

  // 5. Completed follow-up -> never sends reminders
  const fuCompleted = {
    status: "completed",
    recommendedDate: "2026-10-20",
    remindersSent: [],
  };
  assert.equal(determineDueMilestone(fuCompleted, nowClinic), null);
});

test("FollowUp Reminder Service - Lock-screen Privacy Protection", () => {
  const followUp = {
    doctorName: "Dr. K. S. Rao",
    reason: "Severe cardiac arrhythmia review and Holter analysis",
    doctorInstructions: "Take blood pressure medication and report if pulse drops below 50",
  };

  const content = buildReminderContent(followUp, "upcoming_3d", "2026-10-23");

  // Verify push body does NOT expose medical condition/diagnosis on lock screen
  assert.ok(!content.pushBody.toLowerCase().includes("arrhythmia"), "Lock screen push must not leak cardiac diagnosis");
  assert.ok(!content.pushBody.toLowerCase().includes("holter"), "Lock screen push must not leak tests");
  assert.ok(content.pushBody.includes("Dr. K. S. Rao"), "Push body should include physician name");
  assert.ok(content.pushBody.includes("2026-10-23"), "Push body should mention recommended date");
});
