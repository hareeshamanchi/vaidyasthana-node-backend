/**
 * Vaidyasthana Video Consultation Window & 30-Minute Grace Period Utility (Backend)
 *
 * Implements strict consultation time rules:
 * - Consultations can be joined from the scheduled start time until the 30-minute grace period deadline.
 * - Prior to scheduled start time: Button disabled, status "Starts at [time]".
 * - During 30-min window: Button enabled, status "Join Video Consultation".
 * - After 30-min grace period: Button disabled, status "Consultation Time Exceeded".
 * - Cancelled, Rejected, or Completed: Button disabled with respective status.
 * - In-Person appointments: Video button not applicable.
 */

/**
 * Parses a time slot string into minutes from midnight (0 - 1439).
 */
const parseTimeSlotToMinutes = (timeSlot) => {
  if (!timeSlot || typeof timeSlot !== "string") return -1;
  const startPart = timeSlot.split("-")[0].trim();

  // Match 12-hour format: "4:30 PM", "04:30 PM", "11:30 AM"
  const match12 = startPart.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (match12) {
    let hours = parseInt(match12[1], 10);
    const minutes = parseInt(match12[2], 10);
    const modifier = match12[3].toUpperCase();
    if (modifier === "PM" && hours < 12) hours += 12;
    if (modifier === "AM" && hours === 12) hours = 0;
    return hours * 60 + minutes;
  }

  // Match 24-hour format: "16:30", "09:00"
  const match24 = startPart.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    const hours = parseInt(match24[1], 10);
    const minutes = parseInt(match24[2], 10);
    return hours * 60 + minutes;
  }

  return -1;
};

const GRACE_PERIOD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Normalizes appointment status string to uppercase trimmed format.
 */
const normalizeStatus = (status) => {
  return String(status || "").trim().toUpperCase();
};

/**
 * Checks whether an appointment's consultation mode is online/video.
 */
const isVideoConsultationMode = (consultationType) => {
  const norm = String(consultationType || "").trim().toUpperCase();
  return norm.includes("VIDEO") || norm.includes("ONLINE");
};

/**
 * Extracts year, month (0-indexed), and day from an appointmentDate.
 */
const extractAppointmentCalendarDate = (appointmentDate) => {
  if (!appointmentDate) return null;

  if (typeof appointmentDate === "string") {
    const match = appointmentDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      return {
        year: parseInt(match[1], 10),
        month: parseInt(match[2], 10) - 1,
        day: parseInt(match[3], 10),
      };
    }
  }

  const d = new Date(appointmentDate);
  if (isNaN(d.getTime())) return null;

  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
  };
};

/**
 * Formats minutes from midnight (0 - 1439) into 12-hour format string (e.g. "03:00 PM").
 */
const formatMinutesTo12Hour = (minutes) => {
  if (typeof minutes !== "number" || minutes < 0 || minutes >= 1440) return "";
  const hours24 = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const modifier = hours24 >= 12 ? "PM" : "AM";
  let hours12 = hours24 % 12;
  if (hours12 === 0) hours12 = 12;
  return `${String(hours12).padStart(2, "0")}:${String(mins).padStart(2, "0")} ${modifier}`;
};

/**
 * Computes exact scheduled start and 30-minute grace period deadline timestamps in milliseconds.
 *
 * @param {Date|string} appointmentDate
 * @param {string} timeSlot
 * @param {string} [timeZone] - Optional IANA timezone string (defaults to APP_TIMEZONE or system timezone)
 * @returns {{ startTimeMs: number, deadlineMs: number, slotMinutes: number, formattedTime: string }|null}
 */
const getAppointmentStartAndDeadline = (
  appointmentDate,
  timeSlot,
  timeZone = process.env.APP_TIMEZONE || process.env.CLINIC_TIMEZONE
) => {
  const cal = extractAppointmentCalendarDate(appointmentDate);
  if (!cal) return null;

  const slotMinutes = parseTimeSlotToMinutes(timeSlot);
  if (slotMinutes === -1) return null;

  const hours = Math.floor(slotMinutes / 60);
  const minutes = slotMinutes % 60;

  let startTimeMs;
  if (timeZone) {
    try {
      const pad = (n) => String(n).padStart(2, "0");
      const isoStr = `${cal.year}-${pad(cal.month + 1)}-${pad(cal.day)}T${pad(hours)}:${pad(minutes)}:00Z`;
      const tempDate = new Date(isoStr);
      const locStr = tempDate.toLocaleString("en-US", { timeZone });
      const locDate = new Date(locStr);
      const diff = tempDate.getTime() - locDate.getTime();
      startTimeMs = tempDate.getTime() + diff;
    } catch {
      startTimeMs = new Date(cal.year, cal.month, cal.day, hours, minutes, 0, 0).getTime();
    }
  } else {
    startTimeMs = new Date(cal.year, cal.month, cal.day, hours, minutes, 0, 0).getTime();
  }

  const deadlineMs = startTimeMs + GRACE_PERIOD_MS;
  const formattedTime = formatMinutesTo12Hour(slotMinutes);

  return {
    startTimeMs,
    deadlineMs,
    slotMinutes,
    formattedTime,
  };
};

/**
 * Evaluates the full consultation window state for a given appointment.
 *
 * @param {Object} appointment
 * @param {number} [now=Date.now()]
 * @returns {{
 *   isEligibleMode: boolean,
 *   status: string,
 *   canJoin: boolean,
 *   buttonText: string,
 *   badgeText: string,
 *   startTimeMs: number|null,
 *   deadlineMs: number|null,
 *   remainingMs: number,
 *   formattedTime: string
 * }}
 */
const getConsultationWindowState = (appointment, now = Date.now()) => {
  if (!appointment) {
    return {
      isEligibleMode: false,
      status: "INVALID_APPOINTMENT",
      canJoin: false,
      buttonText: "",
      badgeText: "Unavailable",
      startTimeMs: null,
      deadlineMs: null,
      remainingMs: 0,
      formattedTime: "",
    };
  }

  // 1. Consultation mode check
  const isEligibleMode = isVideoConsultationMode(appointment.consultationType);
  if (!isEligibleMode) {
    return {
      isEligibleMode: false,
      status: "NOT_VIDEO",
      canJoin: false,
      buttonText: "",
      badgeText: "In-Person",
      startTimeMs: null,
      deadlineMs: null,
      remainingMs: 0,
      formattedTime: "",
    };
  }

  // 2. Lifecycle Status checks (Never joinable if Cancelled, Rejected, Completed, or Expired)
  const statusNorm = normalizeStatus(appointment.status);
  if (statusNorm === "CANCELLED") {
    return {
      isEligibleMode: true,
      status: "CANCELLED",
      canJoin: false,
      buttonText: "Consultation Cancelled",
      badgeText: "Cancelled",
      startTimeMs: null,
      deadlineMs: null,
      remainingMs: 0,
      formattedTime: "",
    };
  }

  if (statusNorm === "REJECTED") {
    return {
      isEligibleMode: true,
      status: "REJECTED",
      canJoin: false,
      buttonText: "Consultation Rejected",
      badgeText: "Rejected",
      startTimeMs: null,
      deadlineMs: null,
      remainingMs: 0,
      formattedTime: "",
    };
  }

  if (statusNorm === "COMPLETED") {
    return {
      isEligibleMode: true,
      status: "COMPLETED",
      canJoin: false,
      buttonText: "Consultation Completed",
      badgeText: "Completed",
      startTimeMs: null,
      deadlineMs: null,
      remainingMs: 0,
      formattedTime: "",
    };
  }

  if (statusNorm === "EXPIRED") {
    return {
      isEligibleMode: true,
      status: "EXPIRED",
      canJoin: false,
      buttonText: "Consultation Time Exceeded",
      badgeText: "Expired",
      startTimeMs: null,
      deadlineMs: null,
      remainingMs: 0,
      formattedTime: "",
    };
  }

  // Active call in progress (never disconnect solely because joining grace period ended)
  if (statusNorm === "IN PROGRESS" || statusNorm === "IN_PROGRESS") {
    const timing = getAppointmentStartAndDeadline(
      appointment.appointmentDate,
      appointment.timeSlot || appointment.startTime
    );
    return {
      isEligibleMode: true,
      status: "IN_PROGRESS",
      canJoin: true,
      buttonText: "Join Video Consultation",
      badgeText: "In Progress",
      startTimeMs: timing?.startTimeMs || null,
      deadlineMs: timing?.deadlineMs || null,
      remainingMs: timing?.deadlineMs ? Math.max(0, timing.deadlineMs - now) : 0,
      formattedTime: timing?.formattedTime || "",
    };
  }

  // 3. Time Window calculation
  const timing = getAppointmentStartAndDeadline(
    appointment.appointmentDate,
    appointment.timeSlot || appointment.startTime
  );

  if (!timing) {
    return {
      isEligibleMode: true,
      status: "INVALID_TIME",
      canJoin: false,
      buttonText: "Consultation Unavailable",
      badgeText: "Time Undefined",
      startTimeMs: null,
      deadlineMs: null,
      remainingMs: 0,
      formattedTime: "",
    };
  }

  const { startTimeMs, deadlineMs, formattedTime } = timing;

  // A. Before scheduled start time
  if (now < startTimeMs) {
    return {
      isEligibleMode: true,
      status: "BEFORE_START",
      canJoin: false,
      buttonText: `Consultation starts at ${formattedTime}`,
      badgeText: "Upcoming",
      startTimeMs,
      deadlineMs,
      remainingMs: startTimeMs - now,
      formattedTime,
    };
  }

  // B. During permitted 30-minute grace period window
  if (now >= startTimeMs && now <= deadlineMs) {
    return {
      isEligibleMode: true,
      status: "JOINABLE",
      canJoin: true,
      buttonText: "Join Video Consultation",
      badgeText: "Available to Join",
      startTimeMs,
      deadlineMs,
      remainingMs: deadlineMs - now,
      formattedTime,
    };
  }

  // C. After the 30-minute grace period deadline
  return {
    isEligibleMode: true,
    status: "EXPIRED",
    canJoin: false,
    buttonText: "Consultation Time Exceeded",
    badgeText: "Expired",
    startTimeMs,
    deadlineMs,
    remainingMs: 0,
    formattedTime,
  };
};

/**
 * Evaluates whether a video appointment is eligible for automatic expiration.
 * Strictly returns true ONLY if:
 * 1. Appointment is a video/online consultation mode.
 * 2. Current status is "Scheduled" or "Confirmed" (never Completed, Cancelled, Rejected, or In Progress).
 * 3. The current time has strictly passed the 30-minute grace period deadline (now > deadlineMs).
 *
 * @param {Object} appointment
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
const isAppointmentExpired = (appointment, now = Date.now()) => {
  if (!appointment) return false;
  if (!isVideoConsultationMode(appointment.consultationType)) return false;

  const statusNorm = normalizeStatus(appointment.status);
  if (statusNorm !== "SCHEDULED" && statusNorm !== "CONFIRMED") {
    return false;
  }

  const timing = getAppointmentStartAndDeadline(
    appointment.appointmentDate,
    appointment.timeSlot || appointment.startTime
  );
  if (!timing || !timing.deadlineMs) return false;

  return now > timing.deadlineMs;
};

module.exports = {
  GRACE_PERIOD_MS,
  normalizeStatus,
  isVideoConsultationMode,
  getAppointmentStartAndDeadline,
  getConsultationWindowState,
  isAppointmentExpired,
  formatMinutesTo12Hour,
  parseTimeSlotToMinutes,
};
