const mongoose = require("mongoose");
const User = require("../models/User");
const Appointment = require("../models/Appointment");
const DoctorLeave = require("../models/DoctorLeave");
const { createNotification } = require("./notificationService");
const { sendPushToUser } = require("./pushNotificationService");
const { notifyAppointmentEvent } = require("../config/socket");
const { parseTimeSlotToMinutes } = require("../utils/appointmentSorting");

const CLINIC_TIMEZONE_DEFAULT = "Asia/Kolkata";

/**
 * Resolve clinic timezone with fallback to Asia/Kolkata
 */
const getClinicTimezone = (overrideTz) => {
  const candidate = (
    overrideTz ||
    process.env.CLINIC_TIMEZONE ||
    process.env.APP_TIMEZONE ||
    CLINIC_TIMEZONE_DEFAULT
  ).trim();
  try {
    Intl.DateTimeFormat(undefined, { timeZone: candidate });
    return candidate;
  } catch (e) {
    return CLINIC_TIMEZONE_DEFAULT;
  }
};

/**
 * Retrieve current date & time parts in specified timezone
 */
const getNowInTimezone = (timeZone) => {
  const tz = getClinicTimezone(timeZone);
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const map = {};
  for (const { type, value } of parts) {
    map[type] = value;
  }

  const year = parseInt(map.year, 10);
  const month = parseInt(map.month, 10);
  const day = parseInt(map.day, 10);
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(map.minute, 10);
  const second = parseInt(map.second, 10);

  const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const currentMinutes = hour * 60 + minute;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dateStr,
    currentMinutes,
    timeZone: tz,
  };
};

/**
 * Parse YYYY-MM-DD string into normalized UTC midnight Date object
 */
const parseDateUTC = (dateStr) => {
  if (!dateStr || (typeof dateStr !== "string" && !(dateStr instanceof Date))) return null;
  if (dateStr instanceof Date) {
    if (isNaN(dateStr.getTime())) return null;
    return new Date(Date.UTC(dateStr.getUTCFullYear(), dateStr.getUTCMonth(), dateStr.getUTCDate(), 0, 0, 0, 0));
  }
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
  }
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const day = parseInt(match[3], 10);
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
};

/**
 * Extract YYYY-MM-DD string from date input in clinic timezone
 */
const extractDateOnlyStr = (dateInput, timeZone) => {
  if (!dateInput) return null;
  if (typeof dateInput === "string") {
    const match = dateInput.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return null;
  const tz = getClinicTimezone(timeZone);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(d);
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    return `${map.year}-${map.month}-${map.day}`;
  } catch (e) {
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
};

/**
 * Determine day of week name (e.g. "Monday", "Sunday") for a date in clinic timezone
 */
const getDayOfWeekName = (dateInput, timeZone) => {
  const d = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  if (!d || isNaN(d.getTime())) return "";
  const tz = getClinicTimezone(timeZone);
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
    }).format(d);
  } catch (e) {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return days[d.getUTCDay()];
  }
};

/**
 * Convert minutes from midnight into 12-hour formatted time slot string (e.g. "09:30 AM")
 */
const minutesToTimeSlot = (mins) => {
  const hours24 = Math.floor(mins / 60);
  const m = mins % 60;
  const modifier = hours24 >= 12 ? "PM" : "AM";
  let hours12 = hours24 % 12;
  if (hours12 === 0) hours12 = 12;
  return `${String(hours12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${modifier}`;
};

/**
 * Format doctor title with Dr. prefix safely
 */
const formatDoctorTitle = (name) => {
  if (!name || typeof name !== "string") return "Doctor";
  const trimmed = name.trim();
  return /^Dr\.?\s*/i.test(trimmed) ? trimmed : `Dr. ${trimmed}`;
};

/**
 * Get normalized doctor working hours, schedule, and breaks for a specific day of week or date
 */
const getDoctorDaySchedule = (doctor, dayOrDateInput) => {
  const workingHours = doctor?.workingHours || {};
  let dayName = String(dayOrDateInput || "").trim();

  // If a date string like '2026-10-21' or ISO Date was passed, extract day name
  if (dayName.includes("-") || dayName.includes("T")) {
    dayName = getDayOfWeekName(dayName);
  }

  // Check if doctor has a custom weekly schedule configured
  if (Array.isArray(workingHours.weeklySchedule) && workingHours.weeklySchedule.length > 0) {
    const foundDay = workingHours.weeklySchedule.find(
      (s) => s.day?.toLowerCase() === dayName?.toLowerCase()
    );
    if (foundDay) {
      return {
        isWorkingDay: Boolean(foundDay.isWorkingDay),
        dayName,
        startTime: foundDay.startTime || workingHours.start || "08:00 AM",
        endTime: foundDay.endTime || workingHours.end || "08:00 PM",
        slotDurationMinutes: Number(foundDay.slotDurationMinutes) || Number(workingHours.slotDurationMinutes) || 30,
        breaks: Array.isArray(foundDay.breaks) ? foundDay.breaks : (workingHours.breaks || []),
      };
    }
  }

  // Fallback to workingDays array
  const configuredWorkingDays =
    Array.isArray(workingHours.workingDays) && workingHours.workingDays.length > 0
      ? workingHours.workingDays.map((d) => d.toLowerCase())
      : ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  const isWorking = configuredWorkingDays.includes(dayName.toLowerCase());

  let startStr = workingHours.start || "08:00 AM";
  let endStr = workingHours.end || "08:00 PM";
  if (startStr === "09:00 AM" && endStr === "05:00 PM") {
    startStr = "08:00 AM";
    endStr = "08:00 PM";
  }

  return {
    isWorkingDay: isWorking,
    dayName,
    startTime: startStr,
    endTime: endStr,
    slotDurationMinutes: Number(workingHours.slotDurationMinutes) || 30,
    breaks: Array.isArray(workingHours.breaks) ? workingHours.breaks : [],
  };
};

/**
 * Check if a time interval overlaps any break interval
 * Supports both (startMins, endMins, breaks) and (timeSlot, durationMinutes, breaks)
 */
const isSlotInBreak = (arg1, arg2, arg3 = []) => {
  let slotStartMins = -1;
  let slotEndMins = -1;
  let breaks = Array.isArray(arg3) ? arg3 : [];

  if (typeof arg1 === "string" && typeof arg2 === "number") {
    slotStartMins = parseTimeSlotToMinutes(arg1);
    slotEndMins = slotStartMins + arg2;
  } else if (typeof arg1 === "number" && typeof arg2 === "number") {
    slotStartMins = arg1;
    slotEndMins = arg2;
  } else if (typeof arg1 === "string" && typeof arg2 === "string") {
    slotStartMins = parseTimeSlotToMinutes(arg1);
    slotEndMins = parseTimeSlotToMinutes(arg2);
  }

  if (slotStartMins === -1 || slotEndMins === -1) return { inBreak: false };
  if (!Array.isArray(breaks) || breaks.length === 0) return { inBreak: false };

  for (const brk of breaks) {
    const bStart = parseTimeSlotToMinutes(brk.startTime);
    const bEnd = parseTimeSlotToMinutes(brk.endTime);
    if (bStart === -1 || bEnd === -1 || bStart >= bEnd) continue;

    if (slotStartMins < bEnd && slotEndMins > bStart) {
      return {
        inBreak: true,
        breakTitle: brk.title || "Doctor break time",
        breakInfo: { title: brk.title || "Break", startTime: brk.startTime, endTime: brk.endTime },
      };
    }
  }
  return { inBreak: false };
};

/**
 * Check if target date and slot overlap any active doctor leave
 * Supports:
 * - checkSlotInLeaves(targetDateUTC, slotStartMins, slotEndMins, activeLeaves)
 * - checkSlotInLeaves(timeSlot, durationMinutes, targetDate, activeLeaves)
 */
const checkSlotInLeaves = (arg1, arg2, arg3, arg4) => {
  let targetDateUTC = null;
  let slotStartMins = -1;
  let slotEndMins = -1;
  let activeLeaves = [];

  if (typeof arg1 === "string" && typeof arg2 === "number" && arg3) {
    // Signature: (timeSlot, durationMinutes, targetDate, activeLeaves)
    slotStartMins = parseTimeSlotToMinutes(arg1);
    slotEndMins = slotStartMins + arg2;
    targetDateUTC = parseDateUTC(arg3);
    activeLeaves = Array.isArray(arg4) ? arg4 : [];
  } else {
    // Signature: (targetDateUTC, slotStartMins, slotEndMins, activeLeaves)
    targetDateUTC = parseDateUTC(arg1);
    slotStartMins = typeof arg2 === "number" ? arg2 : parseTimeSlotToMinutes(arg2);
    slotEndMins = typeof arg3 === "number" ? arg3 : parseTimeSlotToMinutes(arg3);
    activeLeaves = Array.isArray(arg4) ? arg4 : [];
  }

  if (!targetDateUTC || isNaN(targetDateUTC.getTime())) {
    return { inLeave: false };
  }

  if (!Array.isArray(activeLeaves) || activeLeaves.length === 0) {
    return { inLeave: false };
  }

  const targetTime = targetDateUTC.getTime();

  for (const leave of activeLeaves) {
    if (leave.status && leave.status !== "active") continue;

    const leaveStart = parseDateUTC(leave.startDate);
    const leaveEnd = parseDateUTC(leave.endDate);
    if (!leaveStart || !leaveEnd) continue;

    const leaveStartTime = leaveStart.getTime();
    const leaveEndTime = leaveEnd.getTime() + 24 * 60 * 60 * 1000 - 1;

    // Check if target date falls within the leave date range
    if (targetTime >= leaveStartTime && targetTime <= leaveEndTime) {
      if (leave.isFullDay !== false) {
        return {
          inLeave: true,
          isFullDay: true,
          reason: leave.reason || "Doctor is on approved leave",
          leaveNotice: "Doctor is on approved leave on this date.",
        };
      }

      // Partial day leave check
      const lStart = parseTimeSlotToMinutes(leave.startTime);
      const lEnd = parseTimeSlotToMinutes(leave.endTime);
      if (lStart !== -1 && lEnd !== -1) {
        if (slotStartMins < lEnd && slotEndMins > lStart) {
          return {
            inLeave: true,
            isFullDay: false,
            reason: leave.reason || "Doctor is on leave during this time slot",
            leaveNotice: `Doctor is on partial leave on this date (${leave.startTime} - ${leave.endTime}).`,
          };
        }
      }
    }
  }

  return { inLeave: false };
};

/**
 * Generate all atomic slots and their availability state for a given doctor and date
 * Supports both positional (doctor, dateStr, timezone) and object ({ doctor, dateStr, timezone })
 */
const calculateDoctorSlots = async (arg1, arg2, arg3) => {
  let doctor, dateStr, timezone;
  if (arg1 && arg1.doctor) {
    doctor = arg1.doctor;
    dateStr = arg1.dateStr || arg1.date;
    timezone = arg1.timezone;
  } else {
    doctor = arg1;
    dateStr = arg2;
    timezone = arg3;
  }

  const targetDateUTC = parseDateUTC(dateStr);
  const targetDateStr = extractDateOnlyStr(dateStr, timezone);
  if (!targetDateUTC || !targetDateStr) {
    return {
      success: false,
      message: "Invalid date format. Please use YYYY-MM-DD.",
    };
  }

  const nowTz = getNowInTimezone(timezone);

  const isTargetDatePast = targetDateStr < nowTz.dateStr;
  const isToday = targetDateStr === nowTz.dateStr;
  const currentMinutes = nowTz.currentMinutes;

  const dayOfWeekName = getDayOfWeekName(targetDateUTC, timezone);
  const daySchedule = getDoctorDaySchedule(doctor, dayOfWeekName);

  // Retrieve active leaves overlapping this date
  const startOfDay = new Date(targetDateUTC.getTime());
  const endOfDay = new Date(targetDateUTC.getTime() + 24 * 60 * 60 * 1000 - 1);

  let activeLeaves = [];
  let dayAppointments = [];

  if (mongoose.connection.readyState === 1) {
    activeLeaves = await DoctorLeave.find({
      doctorId: doctor._id,
      status: "active",
      startDate: { $lte: endOfDay },
      endDate: { $gte: startOfDay },
    });

    dayAppointments = await Appointment.find({
      doctorId: doctor._id,
      appointmentDate: { $gte: startOfDay, $lte: endOfDay },
    }).select("timeSlot status");
  }

  const fullDayLeave = activeLeaves.find((l) => l.isFullDay);
  const isLeaveDay = Boolean(fullDayLeave);
  const isNonWorkingDay = !daySchedule.isWorkingDay;

  // Active appointments that occupy slots (exclude Cancelled and Rejected)
  const activeAppointments = dayAppointments.filter((app) => {
    const s = String(app.status || "").trim().toUpperCase();
    return s !== "CANCELLED" && s !== "REJECTED";
  });

  const bookedSlotStrings = new Set(
    activeAppointments.map((app) => String(app.timeSlot || "").trim().toLowerCase())
  );
  const bookedSlotMinutes = new Set(
    activeAppointments
      .map((app) => parseTimeSlotToMinutes(app.timeSlot))
      .filter((mins) => mins !== -1)
  );

  // Generate slots within working hours
  const startMins = parseTimeSlotToMinutes(daySchedule.startTime);
  const endMins = parseTimeSlotToMinutes(daySchedule.endTime);
  const interval = daySchedule.slotDurationMinutes || 30;

  const slots = [];

  if (startMins !== -1 && endMins !== -1 && startMins < endMins && interval > 0) {
    for (let mins = startMins; mins + interval <= endMins; mins += interval) {
      const slotEndMins = mins + interval;
      const slotStr = minutesToTimeSlot(mins);

      // Check conditions
      const isPast = isTargetDatePast || (isToday && mins <= currentMinutes);

      const leaveCheck = isLeaveDay
        ? { inLeave: true, isFullDay: true }
        : checkSlotInLeaves(targetDateUTC, mins, slotEndMins, activeLeaves);

      const breakCheck = isSlotInBreak(mins, slotEndMins, daySchedule.breaks);

      const isBooked =
        bookedSlotStrings.has(slotStr.trim().toLowerCase()) ||
        bookedSlotMinutes.has(mins);

      let isAvailable = true;
      let reason = "Available";

      if (isPast) {
        isAvailable = false;
        reason = isTargetDatePast ? "Appointment date has passed" : "Time slot has passed";
      } else if (isNonWorkingDay) {
        isAvailable = false;
        reason = `Doctor not available on ${dayOfWeekName}s`;
      } else if (leaveCheck.inLeave) {
        isAvailable = false;
        reason = "Doctor on approved leave";
      } else if (breakCheck.inBreak) {
        isAvailable = false;
        reason = breakCheck.breakTitle || "Doctor break time";
      } else if (isBooked) {
        isAvailable = false;
        reason = "Booked by another patient";
      }

      slots.push({
        timeSlot: slotStr,
        isAvailable,
        isBooked,
        isPast,
        isLeave: leaveCheck.inLeave,
        isBreak: breakCheck.inBreak,
        reason,
      });
    }
  }

  return {
    success: true,
    doctorId: doctor._id,
    doctorName: formatDoctorTitle(doctor.name),
    department: doctor.specialization,
    date: targetDateStr,
    dayOfWeek: dayOfWeekName,
    timezone: nowTz.timeZone,
    isWorkingDay: daySchedule.isWorkingDay,
    isNonWorkingDay,
    isLeaveDay,
    leaveNotice: isLeaveDay
      ? "Doctor is on approved leave on this date"
      : isNonWorkingDay
      ? `Doctor does not consult on ${dayOfWeekName}`
      : null,
    workingHours: {
      start: daySchedule.startTime,
      end: daySchedule.endTime,
      slotDurationMinutes: daySchedule.slotDurationMinutes,
      breaks: daySchedule.breaks,
    },
    totalSlots: slots.length,
    availableSlotsCount: slots.filter((s) => s.isAvailable).length,
    slots,
  };
};

/**
 * Validate appointment booking / rescheduling request on backend (Mandatory Enforcement)
 */
const validateBookingAvailability = async ({
  doctorId,
  appointmentDate,
  timeSlot,
  timezone,
  excludeAppointmentId = null,
}) => {
  const doctor = await User.findOne({ _id: doctorId, role: "doctor" });
  if (!doctor) {
    return {
      isValid: false,
      statusCode: 404,
      message: "Selected doctor was not found in the verified healthcare database.",
    };
  }

  if (doctor.verificationStatus !== "verified") {
    return {
      isValid: false,
      statusCode: 403,
      message: `${formatDoctorTitle(doctor.name)} is currently awaiting medical credential verification and cannot accept appointments.`,
    };
  }

  const cleanTimeSlot =
    typeof timeSlot === "string"
      ? timeSlot.trim()
      : timeSlot?.timeSlot
      ? String(timeSlot.timeSlot).trim()
      : "";

  if (!appointmentDate || !cleanTimeSlot) {
    return {
      isValid: false,
      statusCode: 400,
      message: "Appointment date and a valid time slot are required.",
    };
  }

  const parsedDate = parseDateUTC(appointmentDate);
  if (!parsedDate) {
    return {
      isValid: false,
      statusCode: 400,
      message: "Invalid appointment date format. Please use YYYY-MM-DD.",
    };
  }

  const nowTz = getNowInTimezone(timezone);
  const targetDateStr = extractDateOnlyStr(appointmentDate, timezone);

  // 1. Past Date Check
  if (!targetDateStr || targetDateStr < nowTz.dateStr) {
    return {
      isValid: false,
      statusCode: 400,
      message: "Appointment date cannot be in the past. Please select today or a future date.",
    };
  }

  const slotStartMins = parseTimeSlotToMinutes(cleanTimeSlot);
  if (slotStartMins === -1) {
    return {
      isValid: false,
      statusCode: 400,
      message: "Invalid appointment time slot format. Please select a valid slot.",
    };
  }

  const dayOfWeekName = getDayOfWeekName(parsedDate, timezone);
  const daySchedule = getDoctorDaySchedule(doctor, dayOfWeekName);
  const interval = daySchedule.slotDurationMinutes || 30;
  const slotEndMins = slotStartMins + interval;

  // 2. Working Day Check
  if (!daySchedule.isWorkingDay) {
    return {
      isValid: false,
      statusCode: 400,
      message: `${formatDoctorTitle(doctor.name)} is not available for appointments on ${dayOfWeekName}s.`,
    };
  }

  // 3. Working Hours Check
  const startMins = parseTimeSlotToMinutes(daySchedule.startTime);
  const endMins = parseTimeSlotToMinutes(daySchedule.endTime);

  if (slotStartMins < startMins || slotEndMins > endMins) {
    return {
      isValid: false,
      statusCode: 400,
      message: `Selected time slot falls outside ${formatDoctorTitle(doctor.name)}'s working hours (${daySchedule.startTime} – ${daySchedule.endTime}).`,
    };
  }

  // 4. Elapsed Slot Check for Today
  if (targetDateStr === nowTz.dateStr && slotStartMins <= nowTz.currentMinutes) {
    return {
      isValid: false,
      statusCode: 400,
      message: `The selected time slot (${cleanTimeSlot}) has already passed for today. Please select an upcoming slot.`,
    };
  }

  // 5. Break Time Check
  const breakCheck = isSlotInBreak(slotStartMins, slotEndMins, daySchedule.breaks);
  if (breakCheck.inBreak) {
    return {
      isValid: false,
      statusCode: 400,
      message: `Selected slot overlaps ${formatDoctorTitle(doctor.name)}'s scheduled break time (${breakCheck.breakTitle || "Break"}).`,
    };
  }

  // 6. Active Leave Check (Full-day or partial-day)
  const startOfDay = new Date(parsedDate.getTime());
  const endOfDay = new Date(parsedDate.getTime() + 24 * 60 * 60 * 1000 - 1);

  const activeLeaves = await DoctorLeave.find({
    doctorId: doctor._id,
    status: "active",
    startDate: { $lte: endOfDay },
    endDate: { $gte: startOfDay },
  });

  const leaveCheck = checkSlotInLeaves(parsedDate, slotStartMins, slotEndMins, activeLeaves);
  if (leaveCheck.inLeave) {
    const leaveMsg = leaveCheck.isFullDay
      ? `${formatDoctorTitle(doctor.name)} is on approved leave on ${targetDateStr}. Please select another date.`
      : `${formatDoctorTitle(doctor.name)} is on approved leave from ${leaveCheck.startTime} to ${leaveCheck.endTime} on ${targetDateStr}.`;
    return {
      isValid: false,
      statusCode: 400,
      message: leaveMsg,
    };
  }

  // 7. Concurrent Booking / Slot Occupancy Check
  const conflictQuery = {
    doctorId: doctor._id,
    appointmentDate: { $gte: startOfDay, $lte: endOfDay },
    timeSlot: cleanTimeSlot,
    status: { $in: ["Scheduled", "Confirmed", "In Progress", "Completed"] },
  };

  if (excludeAppointmentId) {
    conflictQuery._id = { $ne: excludeAppointmentId };
  }

  const existingConflict = await Appointment.findOne(conflictQuery);
  if (existingConflict) {
    return {
      isValid: false,
      statusCode: 409,
      message: `Slot Conflict: ${cleanTimeSlot} on ${targetDateStr} is already reserved by another patient. Please choose another available slot.`,
    };
  }

  return {
    isValid: true,
    doctor,
    parsedDate,
    targetDateStr,
    cleanTimeSlot,
    daySchedule,
  };
};

/**
 * Identify, flag, and notify existing appointments affected by a newly scheduled doctor leave
 */
const processLeaveAffectedAppointments = async (leave, performedByUser) => {
  const startDate = parseDateUTC(leave.startDate);
  const endDate = parseDateUTC(leave.endDate);

  const startRange = new Date(startDate.getTime());
  const endRange = new Date(endDate.getTime() + 24 * 60 * 60 * 1000 - 1);

  // Find all active scheduled or confirmed appointments in this date range
  const candidateAppointments = await Appointment.find({
    doctorId: leave.doctorId,
    appointmentDate: { $gte: startRange, $lte: endRange },
    status: { $in: ["Scheduled", "Confirmed"] },
  })
    .populate("patientId", "name email phoneNumber")
    .populate("doctorId", "name");

  const affectedAppointments = [];

  for (const app of candidateAppointments) {
    if (leave.isFullDay) {
      affectedAppointments.push(app);
    } else {
      // Partial day: check time slot overlap
      const slotMins = parseTimeSlotToMinutes(app.timeSlot);
      const leaveStartMins = parseTimeSlotToMinutes(leave.startTime);
      const leaveEndMins = parseTimeSlotToMinutes(leave.endTime);

      if (slotMins !== -1 && leaveStartMins !== -1 && leaveEndMins !== -1) {
        const slotEndMins = slotMins + 30; // standard slot duration
        if (slotMins < leaveEndMins && slotEndMins > leaveStartMins) {
          affectedAppointments.push(app);
        }
      }
    }
  }

  // Update affected appointments and notify patients
  for (const app of affectedAppointments) {
    app.status = "Rescheduling Needed";
    app.leaveId = leave._id;
    app.rescheduleReason = "Doctor on approved leave";
    await app.save();

    const apptDateStr = extractDateOnlyStr(app.appointmentDate);
    const doctorName = formatDoctorTitle(app.doctorId?.name || app.doctorName);
    const patientUser = app.patientId;

    if (patientUser) {
      const patientMsg = `Your consultation with ${doctorName} on ${apptDateStr} at ${app.timeSlot} requires rescheduling due to doctor leave. Please choose an alternate slot or doctor.`;

      // In-app Notification
      createNotification({
        userId: patientUser._id || patientUser,
        title: "Consultation Rescheduling Required",
        message: patientMsg,
        type: "appointment_reschedule_needed",
        relatedId: app._id,
        relatedModel: "Appointment",
        link: `/appointment?rescheduleId=${app._id}`,
      }).catch((e) => console.warn("Patient reschedule notification warning:", e.message));

      // Privacy-Safe Web Push
      try {
        sendPushToUser(patientUser._id || patientUser, {
          title: "Appointment Rescheduling Required",
          body: `Dr. ${doctorName}'s availability changed on ${apptDateStr}. Tap to select an alternate appointment time.`,
          tag: `reschedule-needed-${app._id}`,
          data: { url: `/appointment?rescheduleId=${app._id}` },
        });
      } catch {}
    }

    // Real-time synchronization
    notifyAppointmentEvent({
      doctorId: leave.doctorId,
      patientId: app.patientId?._id || app.patientId,
      appointment: app,
      action: "updated",
    });
  }

  // Update leave record with count
  leave.affectedAppointmentsCount = affectedAppointments.length;
  await leave.save();

  // Notify Doctor
  const leaveStartStr = extractDateOnlyStr(leave.startDate);
  const leaveEndStr = extractDateOnlyStr(leave.endDate);
  const dateRangeStr =
    leaveStartStr === leaveEndStr ? leaveStartStr : `${leaveStartStr} to ${leaveEndStr}`;

  createNotification({
    userId: leave.doctorId,
    title: "Leave Scheduled — Patient Notices Issued",
    message: `Your leave for ${dateRangeStr} has been registered. ${affectedAppointments.length} existing patient consultation(s) were flagged for rescheduling.`,
    type: "doctor_leave_scheduled",
    relatedId: leave._id,
    relatedModel: "DoctorLeave",
    link: "/doctor-dashboard",
  }).catch((e) => console.warn("Doctor leave notification warning:", e.message));

  // Notify Administrators
  const admins = await User.find({ role: { $in: ["admin", "superadmin"] } }).select("_id");
  for (const admin of admins) {
    createNotification({
      userId: admin._id,
      title: "Doctor Leave Registered",
      message: `Dr. ${formatDoctorTitle(candidateAppointments[0]?.doctorName)} scheduled leave on ${dateRangeStr} (${affectedAppointments.length} appointment(s) require rescheduling).`,
      type: "doctor_leave_scheduled",
      relatedId: leave._id,
      relatedModel: "DoctorLeave",
      link: "/admin-dashboard",
    }).catch(() => {});
  }

  return affectedAppointments;
};

module.exports = {
  getClinicTimezone,
  getNowInTimezone,
  parseDateUTC,
  extractDateOnlyStr,
  getDayOfWeekName,
  minutesToTimeSlot,
  formatDoctorTitle,
  getDoctorDaySchedule,
  isSlotInBreak,
  checkSlotInLeaves,
  calculateDoctorSlots,
  validateBookingAvailability,
  processLeaveAffectedAppointments,
};
