const Appointment = require("../models/Appointment");
const User = require("../models/User");
const mongoose = require("mongoose");
const crypto = require("crypto");
const { notifyAppointmentEvent } = require("../config/socket");
const { createNotification } = require("../services/notificationService");
const { compareAppointmentsDesc, parseTimeSlotToMinutes } = require("../utils/appointmentSorting");
const { getConsultationWindowState } = require("../utils/consultationWindow");

const isDbConnected = () => mongoose.connection.readyState === 1;

// Standard clinic appointment time slots (8:00 AM to 8:00 PM daily consultation schedule, 30-min intervals)
// 8:00 PM is the closing end time, so 7:30 PM is the last consultation start time (24 slots total).
const DEFAULT_SLOTS = [
  "08:00 AM",
  "08:30 AM",
  "09:00 AM",
  "09:30 AM",
  "10:00 AM",
  "10:30 AM",
  "11:00 AM",
  "11:30 AM",
  "12:00 PM",
  "12:30 PM",
  "01:00 PM",
  "01:30 PM",
  "02:00 PM",
  "02:30 PM",
  "03:00 PM",
  "03:30 PM",
  "04:00 PM",
  "04:30 PM",
  "05:00 PM",
  "05:30 PM",
  "06:00 PM",
  "06:30 PM",
  "07:00 PM",
  "07:30 PM",
];

// Dynamically compute consultation slots for a doctor.
// Consultations run 8:00 AM to 8:00 PM at 30-minute intervals by default (24 slots).
// 8:00 PM is the closing time, not a start slot.
const getDoctorConsultationSlots = (doctor) => {
  let startStr = doctor?.workingHours?.start || "08:00 AM";
  let endStr = doctor?.workingHours?.end || "08:00 PM";
  let interval = Number(doctor?.workingHours?.slotDurationMinutes) || 30;

  // Handle legacy schema defaults (09:00 AM - 05:00 PM) gracefully by expanding to full clinic schedule (08:00 AM - 08:00 PM)
  if (startStr === "09:00 AM" && endStr === "05:00 PM") {
    startStr = "08:00 AM";
    endStr = "08:00 PM";
  }

  const startMins = parseTimeSlotToMinutes(startStr);
  const endMins = parseTimeSlotToMinutes(endStr);

  if (startMins === -1 || endMins === -1 || startMins >= endMins || interval <= 0) {
    return DEFAULT_SLOTS;
  }

  const generatedSlots = [];
  // Loop strictly while mins + interval <= endMins so closing time (e.g. 8:00 PM) is never a slot start time
  for (let mins = startMins; mins + interval <= endMins; mins += interval) {
    const hours24 = Math.floor(mins / 60);
    const m = mins % 60;
    const modifier = hours24 >= 12 ? "PM" : "AM";
    let hours12 = hours24 % 12;
    if (hours12 === 0) hours12 = 12;
    const formatted = `${String(hours12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${modifier}`;
    generatedSlots.push(formatted);
  }

  return generatedSlots.length > 0 ? generatedSlots : DEFAULT_SLOTS;
};

// Parse date string (YYYY-MM-DD or ISO) into normalized UTC midnight Date object
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

// Convert a time slot string into minutes from midnight (delegating to robust parseTimeSlotToMinutes)
const slotToMinutes = (timeSlotStr) => {
  return parseTimeSlotToMinutes(timeSlotStr);
};

// Case-insensitive status normalization helper
const normalizeStatus = (status) => {
  return String(status || "").trim().toUpperCase();
};

// Check if a normalized UTC midnight date represents today in local date
const isDateToday = (targetDateUTC) => {
  if (!targetDateUTC) return false;
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0));
  return targetDateUTC.getTime() === todayUTC.getTime();
};

// Check if a normalized UTC midnight date is before today
const isDateInPast = (targetDateUTC) => {
  if (!targetDateUTC) return false;
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0));
  return targetDateUTC.getTime() < todayUTC.getTime();
};

// Check if an appointment's scheduled date and time has passed
const isAppointmentInPast = (appointment) => {
  if (!appointment || !appointment.appointmentDate) return false;
  const apptDate = new Date(appointment.appointmentDate);
  if (isNaN(apptDate.getTime())) return false;

  const now = new Date();
  const y = apptDate.getUTCFullYear();
  const m = apptDate.getUTCMonth();
  const d = apptDate.getUTCDate();

  const apptLocalMidnight = new Date(y, m, d, 0, 0, 0, 0).getTime();
  const todayLocalMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();

  if (apptLocalMidnight < todayLocalMidnight) {
    return true;
  }

  if (apptLocalMidnight === todayLocalMidnight && appointment.timeSlot) {
    const slotStartStr = String(appointment.timeSlot).split("-")[0]?.trim();
    const slotMins = slotToMinutes(slotStartStr);
    if (slotMins !== -1) {
      const currentMins = now.getHours() * 60 + now.getMinutes();
      if (slotMins < currentMins) {
        return true;
      }
    }
  }

  return false;
};

// Format doctor name with Dr. prefix without duplicating if already present
const formatDoctorTitle = (name) => {
  if (!name || typeof name !== "string") return "Doctor";
  const trimmed = name.trim();
  return /^Dr\.?\s*/i.test(trimmed) ? trimmed : `Dr. ${trimmed}`;
};

// ==========================================
// List Verified Doctors Directory
// GET /api/appointments/doctors
// ==========================================
const getDoctorsDirectory = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable. Please verify MONGODB_URI in environment.",
      });
    }

    // Only return doctors whose medical credentials have been verified
    const doctors = await User.find({
      role: "doctor",
      verificationStatus: "verified",
    })
      .select(
        "_id name email phoneNumber specialization qualifications experienceYears consultationFee workingHours verificationStatus city state address"
      )
      .sort({ name: 1 });

    return res.status(200).json({
      success: true,
      count: doctors.length,
      doctors,
    });
  } catch (error) {
    console.error("Get Doctors Directory Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve verified doctor directory.",
    });
  }
};

// ==========================================
// Get Doctor Available Slots for a Given Date
// GET /api/appointments/slots?doctorId=...&date=YYYY-MM-DD
// ==========================================
const getAvailableSlots = async (req, res) => {
  try {
    const { doctorId, date } = req.query;

    if (!doctorId || !date) {
      return res.status(400).json({
        success: false,
        message: "Both doctorId and date query parameters are required.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid doctorId format.",
      });
    }

    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    // Validate Doctor exists and is verified
    const doctor = await User.findOne({
      _id: doctorId,
      role: "doctor",
    });

    if (!doctor) {
      return res.status(404).json({
        success: false,
        message: "Doctor not found in clinical database.",
      });
    }

    if (doctor.verificationStatus !== "verified") {
      return res.status(403).json({
        success: false,
        message: "Doctor is not currently verified to accept clinical appointments.",
      });
    }

    const targetDateUTC = parseDateUTC(date);
    if (!targetDateUTC) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format. Please use YYYY-MM-DD.",
      });
    }

    if (isDateInPast(targetDateUTC)) {
      return res.status(400).json({
        success: false,
        message: "Appointment date cannot be in the past. Please select today or a future date.",
      });
    }

    // Date range for target day in UTC midnight
    const startOfDay = new Date(targetDateUTC.getTime());
    const endOfDay = new Date(targetDateUTC.getTime() + 24 * 60 * 60 * 1000 - 1);

    // Retrieve appointments for this doctor on this day
    const dayAppointments = await Appointment.find({
      doctorId: doctor._id,
      appointmentDate: { $gte: startOfDay, $lte: endOfDay },
    }).select("timeSlot status");

    // Filter out Cancelled and Rejected appointments so cancelled slots are immediately available again
    const activeAppointments = dayAppointments.filter((app) => {
      const s = normalizeStatus(app.status);
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

    const isToday = isDateToday(targetDateUTC);
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    // Dynamically retrieve doctor's daily slots (default 08:00 AM to 08:00 PM, 30-min intervals, ending at 07:30 PM)
    const consultationSlots = getDoctorConsultationSlots(doctor);

    // Compute slots with real availability, past slot detection, and double-booking checks
    const slots = consultationSlots.map((slot) => {
      const slotMins = parseTimeSlotToMinutes(slot);
      const isPast = isToday && slotMins !== -1 && slotMins <= currentMinutes;
      const isBooked =
        bookedSlotStrings.has(slot.trim().toLowerCase()) ||
        (slotMins !== -1 && bookedSlotMinutes.has(slotMins));
      const isAvailable = !isBooked && !isPast;

      let reason = "Available";
      if (isPast) {
        reason = "Time slot has passed";
      } else if (isBooked) {
        reason = "Booked by another patient";
      }

      return {
        timeSlot: slot,
        isAvailable,
        isBooked,
        isPast,
        reason,
      };
    });

    return res.status(200).json({
      success: true,
      doctorId: doctor._id,
      doctorName: doctor.name.startsWith("Dr.") ? doctor.name : `Dr. ${doctor.name}`,
      department: doctor.specialization,
      date: date.substring(0, 10),
      totalSlots: slots.length,
      availableSlotsCount: slots.filter((s) => s.isAvailable).length,
      slots,
    });
  } catch (error) {
    console.error("Get Available Slots Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to compute available appointment slots.",
    });
  }
};

// ==========================================
// Book / Create Appointment
// POST /api/appointments
// ==========================================
const createAppointment = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable. Cannot schedule appointments.",
      });
    }

    // Verify patient profile completeness (Mobile number & Address are mandatory)
    const patientUser = await User.findById(req.user.id);
    if (!patientUser) {
      return res.status(404).json({
        success: false,
        message: "Patient account not found.",
      });
    }

    // Ensure only registered patients or admins can schedule appointments
    if (patientUser.role !== "patient" && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only registered patients can schedule clinical appointments.",
      });
    }

    const hasPhone = Boolean(patientUser.phoneNumber && patientUser.phoneNumber.trim());
    const hasAddress = Boolean(patientUser.address && patientUser.address.trim());

    if (!hasPhone || !hasAddress) {
      return res.status(400).json({
        success: false,
        profileIncomplete: true,
        message:
          "Mandatory contact details missing. Please complete your mobile phone number and residential address in your profile before booking an appointment.",
      });
    }

    const {
      doctorId,
      doctorName,
      department,
      appointmentDate,
      timeSlot,
      consultationType,
      type,
      reason,
      notes,
    } = req.body;

    const cleanTimeSlot =
      typeof timeSlot === "string"
        ? timeSlot.trim()
        : timeSlot?.timeSlot
        ? String(timeSlot.timeSlot).trim()
        : "";

    if (!appointmentDate || !cleanTimeSlot) {
      return res.status(400).json({
        success: false,
        message: "Appointment date and a valid time slot are required.",
      });
    }

    const parsedDate = parseDateUTC(appointmentDate);
    if (!parsedDate) {
      return res.status(400).json({
        success: false,
        message: "Invalid appointment date format. Please use YYYY-MM-DD.",
      });
    }

    if (isDateInPast(parsedDate)) {
      return res.status(400).json({
        success: false,
        message: "Appointment date cannot be in the past. Please select today or a future date.",
      });
    }

    const candidateSlotMins = parseTimeSlotToMinutes(cleanTimeSlot);
    if (candidateSlotMins === -1) {
      return res.status(400).json({
        success: false,
        message: "Invalid appointment time slot format. Please select a valid slot between 08:00 AM and 07:30 PM.",
      });
    }

    // Schedule runs from 8:00 AM (480 mins) to 8:00 PM (1200 mins).
    // The last valid consultation start time is 7:30 PM (1170 mins).
    if (candidateSlotMins < 480 || candidateSlotMins > 1170) {
      return res.status(400).json({
        success: false,
        message: "Consultation slots are only available between 08:00 AM and 08:00 PM (last appointment start time is 07:30 PM).",
      });
    }

    if (isDateToday(parsedDate)) {
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      if (candidateSlotMins <= currentMinutes) {
        return res.status(400).json({
          success: false,
          message: `The selected time slot (${cleanTimeSlot}) has already passed for today. Please select an upcoming slot.`,
        });
      }
    }

    // Require valid doctorId. Never identify doctor solely by name.
    if (!doctorId || !mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({
        success: false,
        message: "A valid registered doctor ID is required to schedule an appointment.",
      });
    }

    // Resolve Target Doctor strictly by MongoDB _id and doctor role
    const targetDoctor = await User.findOne({ _id: doctorId, role: "doctor" });

    if (!targetDoctor) {
      return res.status(404).json({
        success: false,
        message: "Selected doctor was not found in the verified healthcare database.",
      });
    }

    // Enforce doctor verification restriction: Unverified doctors cannot be booked!
    if (targetDoctor.verificationStatus !== "verified") {
      return res.status(403).json({
        success: false,
        message: `Dr. ${targetDoctor.name} is currently awaiting medical credential verification and cannot accept appointments at this time.`,
      });
    }

    // Prevent double booking on backend (Race condition check)
    const startOfDay = new Date(parsedDate.getTime());
    const endOfDay = new Date(parsedDate.getTime() + 24 * 60 * 60 * 1000 - 1);

    // Fetch existing appointments on the target date for this doctor
    const dayAppointments = await Appointment.find({
      doctorId: targetDoctor._id,
      appointmentDate: { $gte: startOfDay, $lte: endOfDay },
    });

    const activeDayAppointments = dayAppointments.filter((app) => {
      const s = normalizeStatus(app.status);
      return s !== "CANCELLED" && s !== "REJECTED";
    });

    const existingConflict = activeDayAppointments.find((appt) => {
      if (String(appt.timeSlot || "").trim().toLowerCase() === cleanTimeSlot.toLowerCase()) {
        return true;
      }
      if (candidateSlotMins !== -1) {
        const apptMins = parseTimeSlotToMinutes(appt.timeSlot);
        if (apptMins !== -1 && apptMins === candidateSlotMins) {
          return true;
        }
      }
      return false;
    });

    const formattedDoctorName = formatDoctorTitle(targetDoctor.name);

    if (existingConflict) {
      if (existingConflict.patientId.toString() === patientUser._id.toString()) {
        return res.status(409).json({
          success: false,
          message: `You already have an active appointment scheduled with ${formattedDoctorName} for this time slot (${cleanTimeSlot}).`,
        });
      }
      return res.status(409).json({
        success: false,
        message: `This time slot (${cleanTimeSlot}) is already booked for ${formattedDoctorName}. Please select another time slot.`,
      });
    }

    const finalReason = (reason || notes || "").trim();
    const finalNotes = (notes || reason || "").trim();

    const appointment = await Appointment.create({
      patientId: patientUser._id,
      doctorId: targetDoctor._id,
      doctorName: formattedDoctorName,
      patientName: patientUser.name,
      patientPhone: patientUser.phoneNumber,
      patientEmail: patientUser.email,
      department: targetDoctor.specialization || department || "General Medicine",
      appointmentDate: parsedDate,
      timeSlot: cleanTimeSlot,
      consultationType: consultationType || "In-Person",
      type: type || "Consultation",
      reason: finalReason,
      notes: finalNotes,
      status: "Scheduled",
    });

    // Real-time synchronization: notify doctor and patient
    notifyAppointmentEvent({
      doctorId: targetDoctor._id,
      patientId: patientUser._id,
      appointment,
      action: "created",
    });

    // Create persistent notifications for doctor and patient
    const apptDateFormatted = parsedDate.toISOString().slice(0, 10);
    createNotification({
      userId: targetDoctor._id,
      title: "New Appointment Booked",
      message: `Patient ${patientUser.name} booked a consultation for ${apptDateFormatted} at ${cleanTimeSlot}.`,
      type: "appointment_booked",
      relatedId: appointment._id,
      relatedModel: "Appointment",
      link: "/doctor-dashboard",
    }).catch((err) => console.error("Doctor notification error:", err.message));

    createNotification({
      userId: patientUser._id,
      title: "Appointment Scheduled",
      message: `Your consultation with ${formattedDoctorName} on ${apptDateFormatted} at ${cleanTimeSlot} has been scheduled.`,
      type: "appointment_booked",
      relatedId: appointment._id,
      relatedModel: "Appointment",
      link: "/appointment",
    }).catch((err) => console.error("Patient notification error:", err.message));

    return res.status(201).json({
      success: true,
      message: `Appointment scheduled successfully with ${formattedDoctorName}.`,
      appointment,
    });
  } catch (error) {
    console.error("Create Appointment Error:", error);

    // Handle Mongo E11000 duplicate key constraint violation cleanly
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Concurrent booking collision: This slot was just reserved by another patient. Please choose another time.",
      });
    }

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to schedule appointment in database.",
    });
  }
};

// ==========================================
// Get User's Appointments
// GET /api/appointments
// ==========================================
const getAppointments = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    let query = {};
    const userIdObj = mongoose.Types.ObjectId.isValid(req.user.id)
      ? new mongoose.Types.ObjectId(req.user.id)
      : req.user.id;

    if (req.user.role === "doctor") {
      // Doctor view: strictly return appointments assigned to THIS doctor
      query = { doctorId: userIdObj };
    } else if (req.user.role === "patient") {
      // Patient view: strictly return appointments booked by THIS patient
      query = { patientId: userIdObj };
    } else if (req.user.role === "admin") {
      // Admin view: optionally filter
      if (req.query.doctorId) {
        query.doctorId = mongoose.Types.ObjectId.isValid(req.query.doctorId)
          ? new mongoose.Types.ObjectId(req.query.doctorId)
          : req.query.doctorId;
      }
      if (req.query.patientId) {
        query.patientId = mongoose.Types.ObjectId.isValid(req.query.patientId)
          ? new mongoose.Types.ObjectId(req.query.patientId)
          : req.query.patientId;
      }
    } else {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You are not authorized to view appointments.",
      });
    }

    const appointments = await Appointment.find(query)
      .populate("patientId", "name email phoneNumber address")
      .populate("doctorId", "name specialization qualifications consultationFee")
      .sort({
        appointmentDate: -1,
        createdAt: -1,
      });

    // Synchronize populated doctor and patient details from actual User records
    const enrichedAppointments = appointments.map((app) => {
      const appObj = app.toObject ? app.toObject() : { ...app };
      if (appObj.doctorId && typeof appObj.doctorId === "object") {
        const doc = appObj.doctorId;
        if (doc.name) {
          appObj.doctorName = doc.name.startsWith("Dr.") ? doc.name : `Dr. ${doc.name}`;
        }
        if (doc.specialization) {
          appObj.department = doc.specialization;
        }
      }
      if (appObj.patientId && typeof appObj.patientId === "object") {
        const pat = appObj.patientId;
        if (pat.name) {
          appObj.patientName = pat.name;
        }
        if (pat.phoneNumber) {
          appObj.patientPhone = pat.phoneNumber;
        }
        if (pat.email) {
          appObj.patientEmail = pat.email;
        }
      }
      return appObj;
    });

    // Strictly sort in descending order: latest appointment date and time first
    enrichedAppointments.sort(compareAppointmentsDesc);

    return res.status(200).json({
      success: true,
      count: enrichedAppointments.length,
      appointments: enrichedAppointments,
    });
  } catch (error) {
    console.error("Get Appointments Error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to retrieve appointments from database.",
    });
  }
};

// ==========================================
// Get Single Appointment
// GET /api/appointments/:id
// ==========================================
const getAppointmentById = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const appointment = await Appointment.findById(req.params.id)
      .populate("patientId", "name email phoneNumber address")
      .populate("doctorId", "name specialization qualifications");

    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: "Appointment not found.",
      });
    }

    // Access control: only the patient, assigned doctor, or admin
    const patientRefStr = appointment.patientId?._id?.toString() || appointment.patientId?.toString();
    const doctorRefStr = appointment.doctorId?._id?.toString() || appointment.doctorId?.toString();
    const isPatientOwner = patientRefStr === req.user.id;
    const isDoctorOwner = doctorRefStr === req.user.id;
    const isAdmin = req.user.role === "admin";

    if (!isPatientOwner && !isDoctorOwner && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You are not authorized to view this appointment.",
      });
    }

    const appObj = appointment.toObject ? appointment.toObject() : { ...appointment };
    if (appObj.doctorId && typeof appObj.doctorId === "object") {
      const doc = appObj.doctorId;
      if (doc.name) {
        appObj.doctorName = doc.name.startsWith("Dr.") ? doc.name : `Dr. ${doc.name}`;
      }
      if (doc.specialization) {
        appObj.department = doc.specialization;
      }
    }
    if (appObj.patientId && typeof appObj.patientId === "object") {
      const pat = appObj.patientId;
      if (pat.name) {
        appObj.patientName = pat.name;
      }
      if (pat.phoneNumber) {
        appObj.patientPhone = pat.phoneNumber;
      }
      if (pat.email) {
        appObj.patientEmail = pat.email;
      }
    }

    return res.status(200).json({
      success: true,
      appointment: appObj,
    });
  } catch (error) {
    console.error("Get Appointment Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve appointment details.",
    });
  }
};

// ==========================================
// Update Appointment (Status / Reschedule)
// PUT /api/appointments/:id
// ==========================================
const updateAppointment = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const appointment = await Appointment.findById(req.params.id);

    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: "Appointment not found.",
      });
    }

    const patientRefStr = appointment.patientId?._id?.toString() || appointment.patientId?.toString();
    const doctorRefStr = appointment.doctorId?._id?.toString() || appointment.doctorId?.toString();
    const isPatientOwner = patientRefStr === req.user.id;
    const isDoctorOwner = doctorRefStr === req.user.id;
    const isAdmin = req.user.role === "admin";

    if (!isPatientOwner && !isDoctorOwner && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You cannot modify another user's appointment.",
      });
    }

    const { status, appointmentDate, timeSlot, notes, cancellationReason, rejectionReason } = req.body;
    const requestedStatusNorm = status ? normalizeStatus(status) : null;
    const currentStatusNorm = normalizeStatus(appointment.status);

    // Doctor actions: Confirm, Complete, Reject, Cancel
    if (isDoctorOwner || isAdmin) {
      if (status) {
        if (!["Scheduled", "Confirmed", "In Progress", "Completed", "Cancelled", "Rejected"].includes(status)) {
          return res.status(400).json({
            success: false,
            message: "Invalid appointment status value.",
          });
        }

        // Doctor cannot cancel or reject an appointment that is already Completed
        if (currentStatusNorm === "COMPLETED" && (requestedStatusNorm === "CANCELLED" || requestedStatusNorm === "REJECTED")) {
          return res.status(400).json({
            success: false,
            message: "Cannot cancel or reject an appointment that has already been completed.",
          });
        }

        appointment.status = status;
      }
      if (rejectionReason) appointment.rejectionReason = rejectionReason.trim();
    }

    // Patient actions: Reschedule or Cancel
    if (isPatientOwner && !isDoctorOwner && !isAdmin) {
      if (status) {
        if (requestedStatusNorm !== "CANCELLED") {
          return res.status(403).json({
            success: false,
            message: "Patients are only authorized to cancel their own appointments.",
          });
        }

        // Validate current status before allowing cancellation
        if (currentStatusNorm === "COMPLETED") {
          return res.status(400).json({
            success: false,
            message: "Cannot cancel an appointment that has already been completed.",
          });
        }

        if (currentStatusNorm === "CANCELLED") {
          return res.status(400).json({
            success: false,
            message: "Appointment is already cancelled.",
          });
        }

        if (currentStatusNorm === "REJECTED") {
          return res.status(400).json({
            success: false,
            message: "Cannot cancel an appointment that has been rejected.",
          });
        }

        // Validate date/time: cannot cancel past appointments
        if (isAppointmentInPast(appointment)) {
          return res.status(400).json({
            success: false,
            message: "Cannot cancel past appointments. Only eligible future appointments can be cancelled.",
          });
        }

        appointment.status = "Cancelled";
        if (cancellationReason) appointment.cancellationReason = cancellationReason.trim();
      }

      // If rescheduling date or timeSlot
      if (appointmentDate || timeSlot) {
        if (currentStatusNorm === "COMPLETED" || currentStatusNorm === "CANCELLED" || currentStatusNorm === "REJECTED") {
          return res.status(400).json({
            success: false,
            message: `Cannot reschedule an appointment that is already ${appointment.status.toLowerCase()}.`,
          });
        }
        if (isAppointmentInPast(appointment)) {
          return res.status(400).json({
            success: false,
            message: "Cannot reschedule past appointments.",
          });
        }

        const newDate = appointmentDate ? parseDateUTC(appointmentDate) : appointment.appointmentDate;
        if (!newDate) {
          return res.status(400).json({
            success: false,
            message: "Invalid reschedule date format. Please use YYYY-MM-DD.",
          });
        }
        const newSlot = timeSlot ? timeSlot.trim() : appointment.timeSlot;

        // Check for double booking conflicts on the new slot
        const startOfDay = new Date(newDate.getTime());
        const endOfDay = new Date(newDate.getTime() + 24 * 60 * 60 * 1000 - 1);

        const conflict = await Appointment.findOne({
          _id: { $ne: appointment._id },
          doctorId: appointment.doctorId,
          appointmentDate: { $gte: startOfDay, $lte: endOfDay },
          timeSlot: newSlot,
          status: { $nin: ["Cancelled", "Rejected"] },
        });

        if (conflict) {
          return res.status(409).json({
            success: false,
            message: `The selected slot '${newSlot}' is already occupied. Please choose another slot.`,
          });
        }

        appointment.appointmentDate = newDate;
        appointment.timeSlot = newSlot;
        appointment.status = "Scheduled"; // Re-mark as scheduled on reschedule
      }
    }

    if (notes !== undefined) appointment.notes = notes;

    await appointment.save();

    // Notify real-time subscribers
    notifyAppointmentEvent({
      doctorId: appointment.doctorId,
      patientId: appointment.patientId,
      appointment,
      action: status ? status.toLowerCase() : "updated",
    });

    // Create persistent notifications for doctor / patient status changes
    const apptDateStr = appointment.appointmentDate
      ? new Date(appointment.appointmentDate).toISOString().slice(0, 10)
      : "";
    const slotStr = appointment.timeSlot || "";

    if (status === "Confirmed") {
      createNotification({
        userId: appointment.patientId,
        title: "Appointment Confirmed",
        message: `Dr. ${appointment.doctorName} confirmed your consultation for ${apptDateStr} at ${slotStr}.`,
        type: "appointment_confirmed",
        relatedId: appointment._id,
        relatedModel: "Appointment",
        link: "/appointment",
      }).catch((e) => console.error("Confirm notification error:", e.message));
    } else if (status === "Rejected") {
      const reasonPart = appointment.rejectionReason ? ` Reason: ${appointment.rejectionReason}` : "";
      createNotification({
        userId: appointment.patientId,
        title: "Appointment Rejected",
        message: `Your consultation request for ${apptDateStr} at ${slotStr} could not be confirmed.${reasonPart}`,
        type: "appointment_rejected",
        relatedId: appointment._id,
        relatedModel: "Appointment",
        link: "/appointment",
      }).catch((e) => console.error("Reject notification error:", e.message));
    } else if (status === "Completed") {
      createNotification({
        userId: appointment.patientId,
        title: "Consultation Completed",
        message: `Your consultation with Dr. ${appointment.doctorName} on ${apptDateStr} has been marked as completed.`,
        type: "appointment_completed",
        relatedId: appointment._id,
        relatedModel: "Appointment",
        link: "/appointment",
      }).catch((e) => console.error("Complete notification error:", e.message));
    } else if (status === "Cancelled") {
      createNotification({
        userId: appointment.doctorId,
        title: "Appointment Cancelled",
        message: `The consultation with ${appointment.patientName} on ${apptDateStr} at ${slotStr} was cancelled.`,
        type: "appointment_cancelled",
        relatedId: appointment._id,
        relatedModel: "Appointment",
        link: "/doctor-dashboard",
      }).catch((e) => console.error("Doctor cancel notification error:", e.message));

      createNotification({
        userId: appointment.patientId,
        title: "Appointment Cancelled",
        message: `Your consultation with Dr. ${appointment.doctorName} on ${apptDateStr} at ${slotStr} was cancelled.`,
        type: "appointment_cancelled",
        relatedId: appointment._id,
        relatedModel: "Appointment",
        link: "/appointment",
      }).catch((e) => console.error("Patient cancel notification error:", e.message));
    }

    return res.status(200).json({
      success: true,
      message: "Appointment updated successfully in database.",
      appointment,
    });
  } catch (error) {
    console.error("Update Appointment Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update appointment.",
    });
  }
};

// ==========================================
// Cancel / Delete Appointment
// DELETE /api/appointments/:id
// ==========================================
const deleteAppointment = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const appointment = await Appointment.findById(req.params.id);

    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: "Appointment not found.",
      });
    }

    const patientRefStr = appointment.patientId?._id?.toString() || appointment.patientId?.toString();
    const doctorRefStr = appointment.doctorId?._id?.toString() || appointment.doctorId?.toString();
    const isPatientOwner = patientRefStr === req.user.id;
    const isDoctorOwner = doctorRefStr === req.user.id;
    const isAdmin = req.user.role === "admin";

    if (!isPatientOwner && !isDoctorOwner && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You are not authorized to cancel this appointment.",
      });
    }

    const currentStatusNorm = normalizeStatus(appointment.status);

    if (currentStatusNorm === "COMPLETED") {
      return res.status(400).json({
        success: false,
        message: "Cannot cancel an appointment that has already been completed.",
      });
    }

    if (currentStatusNorm === "CANCELLED") {
      return res.status(400).json({
        success: false,
        message: "Appointment is already cancelled.",
      });
    }

    if (currentStatusNorm === "REJECTED") {
      return res.status(400).json({
        success: false,
        message: "Cannot cancel an appointment that has been rejected.",
      });
    }

    if (isAppointmentInPast(appointment)) {
      return res.status(400).json({
        success: false,
        message: "Cannot cancel past appointments. Only eligible future appointments can be cancelled.",
      });
    }

    appointment.status = "Cancelled";
    appointment.cancellationReason = req.body?.reason || "Cancelled by user";
    await appointment.save();

    notifyAppointmentEvent({
      doctorId: appointment.doctorId,
      patientId: appointment.patientId,
      appointment,
      action: "cancelled",
    });

    const apptDateStr = appointment.appointmentDate
      ? new Date(appointment.appointmentDate).toISOString().slice(0, 10)
      : "";
    const slotStr = appointment.timeSlot || "";

    createNotification({
      userId: appointment.doctorId,
      title: "Appointment Cancelled",
      message: `The consultation with ${appointment.patientName} on ${apptDateStr} at ${slotStr} was cancelled.`,
      type: "appointment_cancelled",
      relatedId: appointment._id,
      relatedModel: "Appointment",
      link: "/doctor-dashboard",
    }).catch((e) => console.error("Delete doc notify error:", e.message));

    createNotification({
      userId: appointment.patientId,
      title: "Appointment Cancelled",
      message: `Your consultation with Dr. ${appointment.doctorName} on ${apptDateStr} at ${slotStr} was cancelled.`,
      type: "appointment_cancelled",
      relatedId: appointment._id,
      relatedModel: "Appointment",
      link: "/appointment",
    }).catch((e) => console.error("Delete pat notify error:", e.message));

    return res.status(200).json({
      success: true,
      message: "Appointment marked as cancelled in database.",
      appointment,
    });
  } catch (error) {
    console.error("Delete Appointment Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to cancel appointment.",
    });
  }
};

// ==========================================
// Authorize & Retrieve Video Consultation Access
// GET /api/appointments/:id/video-access
// ==========================================
const getVideoAccess = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid appointment ID format.",
      });
    }

    const appointment = await Appointment.findById(req.params.id)
      .populate("patientId", "name email phoneNumber")
      .populate("doctorId", "name specialization qualifications");

    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: "Appointment record not found.",
      });
    }

    // Participant verification: strictly the assigned patient or doctor (or platform admin)
    const patientRefStr = appointment.patientId?._id?.toString() || appointment.patientId?.toString();
    const doctorRefStr = appointment.doctorId?._id?.toString() || appointment.doctorId?.toString();
    const userId = req.user.id;
    const isPatient = patientRefStr === userId;
    const isDoctor = doctorRefStr === userId;
    const isAdmin = req.user.role === "admin";

    if (!isPatient && !isDoctor && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "Access denied: You are not an authorized participant for this consultation.",
      });
    }

    // Evaluate consultation window state (mode, lifecycle status, 30-minute grace period)
    const windowState = getConsultationWindowState(appointment, Date.now());

    // 1. Consultation mode verification: must be VIDEO or ONLINE
    if (!windowState.isEligibleMode) {
      return res.status(400).json({
        success: false,
        error: "IN_PERSON_APPOINTMENT",
        message: `Video consultation is not available for in-person appointments. Consultation mode: ${appointment.consultationType || "In-Person"}.`,
      });
    }

    // 2. Lifecycle status checks: Cancelled, Rejected, or Completed cannot start/join call
    if (windowState.status === "CANCELLED") {
      return res.status(400).json({
        success: false,
        error: "CONSULTATION_CANCELLED",
        message: "This appointment has been cancelled. Video consultation cannot be started.",
      });
    }

    if (windowState.status === "REJECTED") {
      return res.status(400).json({
        success: false,
        error: "CONSULTATION_REJECTED",
        message: "This appointment was rejected. Video consultation is unavailable.",
      });
    }

    if (windowState.status === "COMPLETED") {
      return res.status(400).json({
        success: false,
        error: "CONSULTATION_COMPLETED",
        message: "This consultation has already been completed.",
      });
    }

    // 3. Time Window Enforcement: Scheduled start time through 30-minute grace period
    if (windowState.status === "BEFORE_START") {
      return res.status(400).json({
        success: false,
        error: "CONSULTATION_NOT_STARTED",
        message: `Consultation has not started yet. Starts at ${windowState.formattedTime}.`,
        startTime: windowState.startTimeMs,
        deadline: windowState.deadlineMs,
        timeSlot: appointment.timeSlot,
      });
    }

    if (windowState.status === "EXPIRED") {
      return res.status(400).json({
        success: false,
        error: "CONSULTATION_TIME_EXCEEDED",
        message: "Consultation time exceeded: The 30-minute consultation window for this video appointment has expired.",
        startTime: windowState.startTimeMs,
        deadline: windowState.deadlineMs,
        timeSlot: appointment.timeSlot,
      });
    }

    // Cryptographic, non-guessable, appointment-specific room identifier
    // Generates the exact same room identifier for both doctor and patient
    let roomName = appointment.meetingRoomId;
    if (!roomName) {
      const secret = process.env.JWT_SECRET || "vaidyasthana_secure_video_salt_key";
      const prefix = process.env.VIDEO_ROOM_PREFIX || "vaidyasthana-consult";
      const hash = crypto
        .createHmac("sha256", secret)
        .update(`appt:${appointment._id.toString()}:${appointment.createdAt ? appointment.createdAt.getTime() : 0}`)
        .digest("hex")
        .slice(0, 32);
      roomName = `${prefix}-${hash}`;

      // Persist to appointment document
      appointment.meetingRoomId = roomName;
      await appointment.save().catch((err) =>
        console.warn("Notice: could not persist meetingRoomId to DB:", err.message)
      );
    }

    const jitsiDomain = process.env.JITSI_DOMAIN || "meet.jit.si";
    const userRole = isDoctor ? "doctor" : isPatient ? "patient" : "admin";
    const displayName = isDoctor
      ? (req.user.name?.startsWith("Dr.") ? req.user.name : `Dr. ${req.user.name || "Doctor"}`)
      : req.user.name || "Patient";

    return res.status(200).json({
      success: true,
      meeting: {
        roomName,
        domain: jitsiDomain,
        appointmentId: appointment._id,
        appointmentDate: appointment.appointmentDate,
        timeSlot: appointment.timeSlot,
        consultationType: appointment.consultationType,
        status: appointment.status,
        doctorName: appointment.doctorName?.startsWith("Dr.") ? appointment.doctorName : `Dr. ${appointment.doctorName}`,
        patientName: appointment.patientName,
        department: appointment.department,
        userRole,
        displayName,
        startTime: windowState.startTimeMs,
        deadline: windowState.deadlineMs,
      },
    });
  } catch (error) {
    console.error("Get Video Access Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to authorize video consultation session.",
    });
  }
};

module.exports = {
  getDoctorsDirectory,
  getAvailableSlots,
  createAppointment,
  getAppointments,
  getAppointmentById,
  updateAppointment,
  deleteAppointment,
  getVideoAccess,
};
