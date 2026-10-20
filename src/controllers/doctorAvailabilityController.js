const mongoose = require("mongoose");
const User = require("../models/User");
const DoctorLeave = require("../models/DoctorLeave");
const Appointment = require("../models/Appointment");
const {
  getClinicTimezone,
  getNowInTimezone,
  parseDateUTC,
  extractDateOnlyStr,
  calculateDoctorSlots,
  processLeaveAffectedAppointments,
} = require("../services/doctorAvailabilityService");
const { parseTimeSlotToMinutes } = require("../utils/appointmentSorting");

const VALID_DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

const isDbConnected = () => mongoose.connection.readyState === 1;

/**
 * ==========================================
 * Get Doctor Availability Settings
 * GET /api/doctor/availability
 * Doctor views own settings; Admin can view via ?doctorId=...
 * ==========================================
 */
const getDoctorAvailability = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const targetDoctorId =
      req.user.role === "admin" && req.query.doctorId
        ? req.query.doctorId
        : req.user.id;

    if (!mongoose.Types.ObjectId.isValid(targetDoctorId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid doctorId format.",
      });
    }

    const doctor = await User.findOne({
      _id: targetDoctorId,
      role: "doctor",
    }).select("name email specialization workingHours");

    if (!doctor) {
      return res.status(404).json({
        success: false,
        message: "Doctor not found.",
      });
    }

    const workingHours = doctor.workingHours || {};

    return res.status(200).json({
      success: true,
      doctorId: doctor._id,
      doctorName: doctor.name,
      specialization: doctor.specialization,
      workingHours: {
        workingDays: workingHours.workingDays || [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
        ],
        start: workingHours.start || "08:00 AM",
        end: workingHours.end || "08:00 PM",
        slotDurationMinutes: workingHours.slotDurationMinutes || 30,
        breaks: Array.isArray(workingHours.breaks) ? workingHours.breaks : [],
        weeklySchedule: Array.isArray(workingHours.weeklySchedule)
          ? workingHours.weeklySchedule
          : [],
      },
    });
  } catch (error) {
    console.error("Get Doctor Availability Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve doctor availability settings.",
    });
  }
};

/**
 * ==========================================
 * Update Doctor Availability Settings
 * PUT /api/doctor/availability
 * Doctor updates own settings; Admin can update via ?doctorId=...
 * ==========================================
 */
const updateDoctorAvailability = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const targetDoctorId =
      req.user.role === "admin" && req.query.doctorId
        ? req.query.doctorId
        : req.user.id;

    if (!mongoose.Types.ObjectId.isValid(targetDoctorId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid doctorId format.",
      });
    }

    const doctor = await User.findOne({
      _id: targetDoctorId,
      role: "doctor",
    });

    if (!doctor) {
      return res.status(404).json({
        success: false,
        message: "Doctor not found.",
      });
    }

    const {
      workingDays,
      start,
      end,
      slotDurationMinutes,
      breaks,
      weeklySchedule,
    } = req.body;

    const currentWorkingHours = doctor.workingHours || {};
    const updatedWorkingHours = { ...currentWorkingHours.toObject?.() || currentWorkingHours };

    // Validate and update working days
    if (workingDays !== undefined) {
      if (!Array.isArray(workingDays)) {
        return res.status(400).json({
          success: false,
          message: "workingDays must be an array of day names.",
        });
      }
      for (const day of workingDays) {
        if (!VALID_DAYS.includes(day)) {
          return res.status(400).json({
            success: false,
            message: `Invalid day '${day}'. Allowed values: ${VALID_DAYS.join(", ")}`,
          });
        }
      }
      updatedWorkingHours.workingDays = workingDays;
    }

    // Validate and update daily hours
    if (start !== undefined || end !== undefined) {
      const candidateStart = start || currentWorkingHours.start || "08:00 AM";
      const candidateEnd = end || currentWorkingHours.end || "08:00 PM";

      const startMins = parseTimeSlotToMinutes(candidateStart);
      const endMins = parseTimeSlotToMinutes(candidateEnd);

      if (startMins === -1 || endMins === -1) {
        return res.status(400).json({
          success: false,
          message: "Working hours start and end must be valid times (e.g. '08:00 AM').",
        });
      }

      if (startMins >= endMins) {
        return res.status(400).json({
          success: false,
          message: "Working hours start time must be before end time.",
        });
      }

      updatedWorkingHours.start = candidateStart;
      updatedWorkingHours.end = candidateEnd;
    }

    // Validate slot duration
    if (slotDurationMinutes !== undefined) {
      const durationNum = parseInt(slotDurationMinutes, 10);
      if (isNaN(durationNum) || durationNum < 10 || durationNum > 120) {
        return res.status(400).json({
          success: false,
          message: "slotDurationMinutes must be an integer between 10 and 120 minutes.",
        });
      }
      updatedWorkingHours.slotDurationMinutes = durationNum;
    }

    // Validate breaks
    if (breaks !== undefined) {
      if (!Array.isArray(breaks)) {
        return res.status(400).json({
          success: false,
          message: "breaks must be an array of break intervals.",
        });
      }

      const validatedBreaks = [];
      for (const b of breaks) {
        if (!b.startTime || !b.endTime) {
          return res.status(400).json({
            success: false,
            message: "Each break must specify startTime and endTime.",
          });
        }
        const bStartMins = parseTimeSlotToMinutes(b.startTime);
        const bEndMins = parseTimeSlotToMinutes(b.endTime);

        if (bStartMins === -1 || bEndMins === -1) {
          return res.status(400).json({
            success: false,
            message: `Invalid break time format for '${b.title || "Break"}': ${b.startTime} - ${b.endTime}`,
          });
        }

        if (bStartMins >= bEndMins) {
          return res.status(400).json({
            success: false,
            message: `Break start time (${b.startTime}) must precede end time (${b.endTime}).`,
          });
        }

        validatedBreaks.push({
          title: (b.title || "Break").trim(),
          startTime: b.startTime.trim(),
          endTime: b.endTime.trim(),
        });
      }

      updatedWorkingHours.breaks = validatedBreaks;
    }

    // Validate weeklySchedule
    if (weeklySchedule !== undefined) {
      if (!Array.isArray(weeklySchedule)) {
        return res.status(400).json({
          success: false,
          message: "weeklySchedule must be an array of daily schedules.",
        });
      }

      for (const ws of weeklySchedule) {
        if (!VALID_DAYS.includes(ws.day)) {
          return res.status(400).json({
            success: false,
            message: `Invalid day '${ws.day}' in weeklySchedule.`,
          });
        }
        if (ws.isWorkingDay) {
          if (ws.startTime && ws.endTime) {
            const sM = parseTimeSlotToMinutes(ws.startTime);
            const eM = parseTimeSlotToMinutes(ws.endTime);
            if (sM === -1 || eM === -1 || sM >= eM) {
              return res.status(400).json({
                success: false,
                message: `Invalid hours for ${ws.day}: ${ws.startTime} to ${ws.endTime}`,
              });
            }
          }
        }
      }

      updatedWorkingHours.weeklySchedule = weeklySchedule;
    }

    doctor.workingHours = updatedWorkingHours;
    await doctor.save();

    return res.status(200).json({
      success: true,
      message: "Doctor availability settings updated successfully.",
      workingHours: doctor.workingHours,
    });
  } catch (error) {
    console.error("Update Doctor Availability Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update doctor availability settings.",
    });
  }
};

/**
 * ==========================================
 * List Doctor Leaves
 * GET /api/doctor/leaves
 * Doctor lists own leaves; Admin can list via ?doctorId=...
 * ==========================================
 */
const getDoctorLeaves = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const targetDoctorId =
      req.user.role === "admin" && req.query.doctorId
        ? req.query.doctorId
        : req.user.id;

    if (!mongoose.Types.ObjectId.isValid(targetDoctorId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid doctorId format.",
      });
    }

    const query = { doctorId: targetDoctorId };
    if (req.query.status && ["active", "cancelled"].includes(req.query.status)) {
      query.status = req.query.status;
    }

    const leaves = await DoctorLeave.find(query).sort({ startDate: -1 });

    return res.status(200).json({
      success: true,
      count: leaves.length,
      leaves,
    });
  } catch (error) {
    console.error("Get Doctor Leaves Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve doctor leaves.",
    });
  }
};

/**
 * ==========================================
 * Schedule Doctor Leave
 * POST /api/doctor/leaves
 * Automatically flags overlapping appointments for rescheduling
 * ==========================================
 */
const createDoctorLeave = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const targetDoctorId =
      req.user.role === "admin" && req.body.doctorId
        ? req.body.doctorId
        : req.user.id;

    if (!mongoose.Types.ObjectId.isValid(targetDoctorId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid doctorId format.",
      });
    }

    const doctor = await User.findOne({
      _id: targetDoctorId,
      role: "doctor",
    });

    if (!doctor) {
      return res.status(404).json({
        success: false,
        message: "Doctor not found.",
      });
    }

    const {
      startDate,
      endDate,
      isFullDay = true,
      startTime,
      endTime,
      reason,
      notifyPatients = true,
    } = req.body;

    if (!startDate) {
      return res.status(400).json({
        success: false,
        message: "startDate is required (YYYY-MM-DD).",
      });
    }

    const parsedStart = parseDateUTC(startDate);
    const parsedEnd = endDate ? parseDateUTC(endDate) : parsedStart;

    if (!parsedStart || !parsedEnd) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format. Please use YYYY-MM-DD.",
      });
    }

    if (parsedStart.getTime() > parsedEnd.getTime()) {
      return res.status(400).json({
        success: false,
        message: "Leave startDate cannot be after endDate.",
      });
    }

    // Partial day validation
    const fullDayBool = isFullDay === true || isFullDay === "true";
    let cleanStartTime = null;
    let cleanEndTime = null;

    if (!fullDayBool) {
      if (!startTime || !endTime) {
        return res.status(400).json({
          success: false,
          message: "Partial-day leave requires both startTime and endTime.",
        });
      }

      const sMins = parseTimeSlotToMinutes(startTime);
      const eMins = parseTimeSlotToMinutes(endTime);

      if (sMins === -1 || eMins === -1) {
        return res.status(400).json({
          success: false,
          message: "Invalid partial-day leave time format.",
        });
      }

      if (sMins >= eMins) {
        return res.status(400).json({
          success: false,
          message: "Leave startTime must be before endTime.",
        });
      }

      cleanStartTime = startTime.trim();
      cleanEndTime = endTime.trim();
    }

    // Create the leave record
    const leave = await DoctorLeave.create({
      doctorId: doctor._id,
      startDate: parsedStart,
      endDate: parsedEnd,
      isFullDay: fullDayBool,
      startTime: cleanStartTime,
      endTime: cleanEndTime,
      reason: (reason || "").trim(),
      status: "active",
      createdBy: req.user.id,
      affectedAppointmentsCount: 0,
    });

    // Process affected appointments: mark as 'Rescheduling Needed' and notify
    let affectedAppointments = [];
    try {
      affectedAppointments = await processLeaveAffectedAppointments(leave, {
        notify: notifyPatients,
      });
    } catch (procErr) {
      console.error("Error processing affected appointments for leave:", procErr);
    }

    // Refresh leave object to include affectedAppointmentsCount
    const savedLeave = await DoctorLeave.findById(leave._id);

    return res.status(201).json({
      success: true,
      message: `Leave scheduled successfully. ${affectedAppointments.length} existing appointment(s) have been flagged for rescheduling.`,
      leave: savedLeave,
      affectedAppointmentsCount: affectedAppointments.length,
    });
  } catch (error) {
    console.error("Create Doctor Leave Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to schedule doctor leave.",
    });
  }
};

/**
 * ==========================================
 * Cancel Doctor Leave
 * PUT /api/doctor/leaves/:id/cancel
 * DELETE /api/doctor/leaves/:id
 * ==========================================
 */
const cancelDoctorLeave = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid leave ID format.",
      });
    }

    const leave = await DoctorLeave.findById(id);

    if (!leave) {
      return res.status(404).json({
        success: false,
        message: "Doctor leave not found.",
      });
    }

    // RBAC: Doctor can only cancel own leave; Admin can cancel any
    if (
      req.user.role !== "admin" &&
      leave.doctorId.toString() !== req.user.id
    ) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You cannot cancel another doctor's leave.",
      });
    }

    leave.status = "cancelled";
    await leave.save();

    return res.status(200).json({
      success: true,
      message: "Doctor leave cancelled successfully.",
      leave,
    });
  } catch (error) {
    console.error("Cancel Doctor Leave Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to cancel doctor leave.",
    });
  }
};

/**
 * ==========================================
 * Get Public Doctor Availability
 * GET /api/doctor/availability/:doctorId
 * Accessible to patients and public; strictly excludes private reasons
 * ==========================================
 */
const getPublicDoctorAvailability = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const { doctorId } = req.params;
    const { date, timezone } = req.query;

    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid doctorId format.",
      });
    }

    const doctor = await User.findOne({
      _id: doctorId,
      role: "doctor",
    });

    if (!doctor) {
      return res.status(404).json({
        success: false,
        message: "Doctor not found.",
      });
    }

    // If date is provided, compute complete slots calculation
    if (date) {
      const slotsResult = await calculateDoctorSlots(doctor, date, timezone);
      return res.status(200).json(slotsResult);
    }

    // If no date is specified, return general weekly working days and hours
    const workingHours = doctor.workingHours || {};

    return res.status(200).json({
      success: true,
      doctorId: doctor._id,
      doctorName: doctor.name.startsWith("Dr.") ? doctor.name : `Dr. ${doctor.name}`,
      specialization: doctor.specialization,
      workingDays: workingHours.workingDays || [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ],
      start: workingHours.start || "08:00 AM",
      end: workingHours.end || "08:00 PM",
      slotDurationMinutes: workingHours.slotDurationMinutes || 30,
      breaks: (workingHours.breaks || []).map((b) => ({
        title: b.title,
        startTime: b.startTime,
        endTime: b.endTime,
      })),
      weeklySchedule: workingHours.weeklySchedule || [],
    });
  } catch (error) {
    console.error("Get Public Doctor Availability Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve doctor availability.",
    });
  }
};

module.exports = {
  getDoctorAvailability,
  updateDoctorAvailability,
  getDoctorLeaves,
  createDoctorLeave,
  cancelDoctorLeave,
  getPublicDoctorAvailability,
};
