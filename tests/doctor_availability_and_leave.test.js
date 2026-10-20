const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const User = require("../src/models/User");
const DoctorLeave = require("../src/models/DoctorLeave");
const Appointment = require("../src/models/Appointment");
const Notification = require("../src/models/Notification");
const {
  getClinicTimezone,
  getNowInTimezone,
  parseDateUTC,
  extractDateOnlyStr,
  getDayOfWeekName,
  getDoctorDaySchedule,
  isSlotInBreak,
  checkSlotInLeaves,
  calculateDoctorSlots,
  validateBookingAvailability,
  processLeaveAffectedAppointments,
} = require("../src/services/doctorAvailabilityService");

test("User Model - workingHours schema with workingDays and breaks", () => {
  const doctor = new User({
    name: "Dr. Arvind Patel",
    email: "arvind.patel@vaidyasthana.test",
    password: "Password123!",
    role: "doctor",
    specialization: "Cardiology",
    workingHours: {
      start: "09:00 AM",
      end: "06:00 PM",
      slotDurationMinutes: 30,
      workingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
      breaks: [
        {
          title: "Lunch Break",
          startTime: "01:00 PM",
          endTime: "02:00 PM",
        },
      ],
      weeklySchedule: [
        {
          day: "Saturday",
          isWorkingDay: true,
          startTime: "09:00 AM",
          endTime: "01:00 PM",
        },
      ],
    },
  });

  const err = doctor.validateSync();
  assert.equal(err, undefined, "Doctor with custom availability should validate without error");
  assert.equal(doctor.workingHours.workingDays.length, 5);
  assert.equal(doctor.workingHours.breaks.length, 1);
  assert.equal(doctor.workingHours.breaks[0].title, "Lunch Break");
  assert.equal(doctor.workingHours.weeklySchedule[0].day, "Saturday");
});

test("DoctorLeave Model - Schema Validation & Enums", () => {
  const doctorId = new mongoose.Types.ObjectId();
  const createdBy = new mongoose.Types.ObjectId();

  // Full-day leave
  const fullDayLeave = new DoctorLeave({
    doctorId,
    startDate: new Date("2026-11-10"),
    endDate: new Date("2026-11-12"),
    isFullDay: true,
    reason: "Attending Cardiology Conference",
    status: "active",
    createdBy,
  });

  const err1 = fullDayLeave.validateSync();
  assert.equal(err1, undefined, "Full-day leave should validate without error");
  assert.equal(fullDayLeave.status, "active");
  assert.equal(fullDayLeave.isFullDay, true);

  // Partial-day leave
  const partialLeave = new DoctorLeave({
    doctorId,
    startDate: new Date("2026-11-15"),
    endDate: new Date("2026-11-15"),
    isFullDay: false,
    startTime: "02:00 PM",
    endTime: "05:00 PM",
    reason: "Personal appointment",
    createdBy,
  });

  const err2 = partialLeave.validateSync();
  assert.equal(err2, undefined, "Partial-day leave should validate without error");
  assert.equal(partialLeave.startTime, "02:00 PM");

  // Invalid leave missing required doctorId and startDate
  const badLeave = new DoctorLeave({});
  const invErr = badLeave.validateSync();
  assert.ok(invErr.errors.doctorId, "doctorId is required");
  assert.ok(invErr.errors.startDate, "startDate is required");
});

test("Appointment Model - Supports 'Rescheduling Needed' status and leave metadata", () => {
  const patientId = new mongoose.Types.ObjectId();
  const doctorId = new mongoose.Types.ObjectId();
  const leaveId = new mongoose.Types.ObjectId();

  const appt = new Appointment({
    patientId,
    doctorId,
    doctorName: "Dr. Aarthi",
    patientName: "Rohan",
    appointmentDate: new Date("2026-11-10"),
    timeSlot: "11:00 AM",
    status: "Rescheduling Needed",
    rescheduleReason: "Doctor is unavailable due to approved leave.",
    leaveId,
  });

  const err = appt.validateSync();
  assert.equal(err, undefined, "Appointment with 'Rescheduling Needed' status should validate");
  assert.equal(appt.status, "Rescheduling Needed");
  assert.equal(appt.leaveId.toString(), leaveId.toString());
  assert.equal(appt.rescheduleReason, "Doctor is unavailable due to approved leave.");
});

test("doctorAvailabilityService - getDoctorDaySchedule", () => {
  const doctor = {
    workingHours: {
      workingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
      start: "08:00 AM",
      end: "05:00 PM",
      slotDurationMinutes: 30,
      weeklySchedule: [
        {
          day: "Saturday",
          isWorkingDay: true,
          startTime: "09:00 AM",
          endTime: "01:00 PM",
          slotDurationMinutes: 20,
        },
      ],
    },
  };

  // Wednesday (standard working day)
  // 2026-10-21 is Wednesday
  const wedSchedule = getDoctorDaySchedule(doctor, "2026-10-21");
  assert.equal(wedSchedule.isWorkingDay, true);
  assert.equal(wedSchedule.dayName, "Wednesday");
  assert.equal(wedSchedule.startTime, "08:00 AM");
  assert.equal(wedSchedule.endTime, "05:00 PM");
  assert.equal(wedSchedule.slotDurationMinutes, 30);

  // Saturday (custom schedule override)
  // 2026-10-24 is Saturday
  const satSchedule = getDoctorDaySchedule(doctor, "2026-10-24");
  assert.equal(satSchedule.isWorkingDay, true);
  assert.equal(satSchedule.dayName, "Saturday");
  assert.equal(satSchedule.startTime, "09:00 AM");
  assert.equal(satSchedule.endTime, "01:00 PM");
  assert.equal(satSchedule.slotDurationMinutes, 20);

  // Sunday (off)
  // 2026-10-25 is Sunday
  const sunSchedule = getDoctorDaySchedule(doctor, "2026-10-25");
  assert.equal(sunSchedule.isWorkingDay, false);
  assert.equal(sunSchedule.dayName, "Sunday");
});

test("doctorAvailabilityService - isSlotInBreak accurately detects break intervals", () => {
  const breaks = [
    { title: "Lunch", startTime: "01:00 PM", endTime: "02:00 PM" },
    { title: "Tea Break", startTime: "04:30 PM", endTime: "05:00 PM" },
  ];

  // 01:00 PM is in lunch break (starts at 01:00 PM)
  const inLunch1 = isSlotInBreak("01:00 PM", 30, breaks);
  assert.equal(inLunch1.inBreak, true);
  assert.equal(inLunch1.breakInfo.title, "Lunch");

  // 01:30 PM is in lunch break
  const inLunch2 = isSlotInBreak("01:30 PM", 30, breaks);
  assert.equal(inLunch2.inBreak, true);

  // 02:00 PM is NOT in lunch break (lunch ends at 02:00 PM)
  const afterLunch = isSlotInBreak("02:00 PM", 30, breaks);
  assert.equal(afterLunch.inBreak, false);

  // 12:30 PM with 30-min duration finishes at 01:00 PM, does NOT overlap
  const beforeLunch = isSlotInBreak("12:30 PM", 30, breaks);
  assert.equal(beforeLunch.inBreak, false);

  // 04:30 PM is in Tea Break
  const teaBreak = isSlotInBreak("04:30 PM", 30, breaks);
  assert.equal(teaBreak.inBreak, true);
});

test("doctorAvailabilityService - checkSlotInLeaves detects full and partial leaves", () => {
  const leaves = [
    {
      startDate: new Date("2026-11-01"),
      endDate: new Date("2026-11-03"),
      isFullDay: true,
      reason: "Vacation",
    },
    {
      startDate: new Date("2026-11-05"),
      endDate: new Date("2026-11-05"),
      isFullDay: false,
      startTime: "02:00 PM",
      endTime: "04:00 PM",
      reason: "Emergency surgery",
    },
  ];

  // Nov 2: Full day leave
  const onFullLeave = checkSlotInLeaves("10:00 AM", 30, "2026-11-02", leaves);
  assert.equal(onFullLeave.inLeave, true);
  assert.equal(onFullLeave.isFullDay, true);

  // Nov 5 at 02:30 PM: Partial day leave
  const onPartialLeave = checkSlotInLeaves("02:30 PM", 30, "2026-11-05", leaves);
  assert.equal(onPartialLeave.inLeave, true);
  assert.equal(onPartialLeave.isFullDay, false);

  // Nov 5 at 10:00 AM: Available (before partial leave)
  const beforePartialLeave = checkSlotInLeaves("10:00 AM", 30, "2026-11-05", leaves);
  assert.equal(beforePartialLeave.inLeave, false);

  // Nov 6: Available (after leave period)
  const afterLeave = checkSlotInLeaves("10:00 AM", 30, "2026-11-06", leaves);
  assert.equal(afterLeave.inLeave, false);
});

test("doctorAvailabilityService - calculateDoctorSlots marks non-working days & breaks", async () => {
  const doctor = {
    _id: new mongoose.Types.ObjectId(),
    name: "Dr. Sneha Reddy",
    specialization: "Pediatrics",
    workingHours: {
      workingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
      start: "09:00 AM",
      end: "01:00 PM",
      slotDurationMinutes: 30,
      breaks: [
        {
          title: "Mid-morning Break",
          startTime: "11:00 AM",
          endTime: "11:30 AM",
        },
      ],
    },
  };

  // 2026-10-25 is a Sunday (non-working day)
  const sunResult = await calculateDoctorSlots(doctor, "2026-10-25");
  assert.equal(sunResult.success, true);
  assert.equal(sunResult.isWorkingDay, false);
  assert.equal(sunResult.isNonWorkingDay, true);
  assert.equal(sunResult.availableSlotsCount, 0);
  assert.ok(sunResult.leaveNotice.includes("Sunday"));
  assert.ok(sunResult.slots.every((s) => !s.isAvailable));

  // Future working day (far future Monday: 2029-01-01)
  const monResult = await calculateDoctorSlots(doctor, "2029-01-01");
  assert.equal(monResult.success, true);
  assert.equal(monResult.isWorkingDay, true);
  assert.equal(monResult.isNonWorkingDay, false);
  assert.equal(monResult.totalSlots, 8); // 09:00, 09:30, 10:00, 10:30, 11:00, 11:30, 12:00, 12:30

  // 11:00 AM is the break slot
  const breakSlot = monResult.slots.find((s) => s.timeSlot === "11:00 AM");
  assert.ok(breakSlot, "11:00 AM slot must exist");
  assert.equal(breakSlot.isAvailable, false);
  assert.equal(breakSlot.isBreak, true);
  assert.ok(breakSlot.reason.includes("Mid-morning Break"));

  // 09:00 AM is available
  const availSlot = monResult.slots.find((s) => s.timeSlot === "09:00 AM");
  assert.ok(availSlot, "09:00 AM slot must exist");
  assert.equal(availSlot.isAvailable, true);
  assert.equal(availSlot.isBreak, false);
});
