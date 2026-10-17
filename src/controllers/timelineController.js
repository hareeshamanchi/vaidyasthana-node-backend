const mongoose = require("mongoose");
const Report = require("../models/Report");
const Appointment = require("../models/Appointment");
const User = require("../models/User");
const { expireStaleAppointments } = require("../services/appointmentExpiryService");
const {
  isDoctorAuthorizedForPatient,
  resolvePatientUser,
} = require("../services/clinicalAuthorizationService");
const { inMemoryReports } = require("./uploadController");

const isDbConnected = () => mongoose.connection.readyState === 1;

// In-memory appointments repository for offline tests
const inMemoryAppointments = new Map();

/**
 * Normalizes a Report record into a unified timeline event.
 */
const formatReportTimelineEvent = (report) => {
  const repObj = report.toObject ? report.toObject() : { ...report };
  const abnormalList = repObj.aiAnalysis?.abnormalParameters || [];
  const repDate = repObj.createdAt || repObj.uploadedAt || new Date();

  return {
    id: String(repObj._id),
    recordType: "report",
    date: repDate,
    title: repObj.originalName || repObj.fileName || "Medical Diagnostic Record",
    fileName: repObj.fileName,
    originalName: repObj.originalName,
    category: repObj.category || "Medical Report",
    fileType: repObj.fileType || "application/pdf",
    fileSize: repObj.fileSize || 0,
    notes: repObj.notes || "",
    uploadedBy: repObj.uploadedBy,
    uploadedByRole: repObj.uploadedByRole || "patient",
    uploaderName:
      repObj.uploaderName ||
      (repObj.uploadedByRole === "doctor" ? "Clinical Doctor" : "Patient"),
    analysisStatus: repObj.analysisStatus || "Pending",
    aiAnalysis: {
      summary: repObj.aiAnalysis?.summary || "",
      severity: repObj.aiAnalysis?.severity || "Unknown",
      abnormalParameters: abnormalList,
      possibleDiseases: repObj.aiAnalysis?.possibleDiseases || [],
      recommendations: repObj.aiAnalysis?.recommendations || [],
      dietPlan: repObj.aiAnalysis?.dietPlan || [],
    },
    hasBiomarkers: abnormalList.length > 0,
    abnormalParameters: abnormalList,
    possibleDiseases: repObj.aiAnalysis?.possibleDiseases || [],
    recommendations: repObj.aiAnalysis?.recommendations || [],
    severity: repObj.aiAnalysis?.severity || "Unknown",
    viewEndpoint: `/upload/view/${repObj._id}`,
  };
};

/**
 * Normalizes an Appointment record into a unified timeline event.
 */
const formatAppointmentTimelineEvent = (appointment) => {
  const appObj = appointment.toObject ? appointment.toObject() : { ...appointment };
  const apptDate = appObj.appointmentDate || appObj.createdAt || new Date();
  const todayMidnight = new Date(new Date().setHours(0, 0, 0, 0));
  const isDateFutureOrToday = new Date(apptDate) >= todayMidnight;
  const nonActiveStatuses = ["Completed", "Cancelled", "Rejected", "Expired", "completed", "cancelled", "rejected", "expired"];
  const isUpcoming = isDateFutureOrToday && !nonActiveStatuses.includes(appObj.status);

  return {
    id: String(appObj._id),
    recordType: "appointment",
    date: apptDate,
    title: appObj.department
      ? `${appObj.department} Consultation`
      : "Medical Consultation",
    doctorName: appObj.doctorName || "Attending Physician",
    doctorId: appObj.doctorId,
    patientName: appObj.patientName || "Patient",
    patientId: appObj.patientId,
    department: appObj.department || "General Medicine",
    timeSlot: appObj.timeSlot || "",
    status: appObj.status || "Scheduled",
    type: appObj.type || "Consultation",
    consultationType: appObj.consultationType || "In-Person",
    reason: appObj.reason || "",
    notes: appObj.notes || "",
    cancellationReason: appObj.cancellationReason || "",
    rejectionReason: appObj.rejectionReason || "",
    meetingRoomId: appObj.meetingRoomId || "",
    isUpcoming,
  };
};

/**
 * Groups timeline events into chronological milestones (e.g. Month Year).
 */
const groupIntoMilestones = (events) => {
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  const milestonesMap = new Map();

  for (const event of events) {
    const d = new Date(event.date);
    const validDate = isNaN(d.getTime()) ? new Date() : d;
    const year = validDate.getFullYear();
    const month = monthNames[validDate.getMonth()];
    const periodKey = `${month} ${year}`;

    if (!milestonesMap.has(periodKey)) {
      milestonesMap.set(periodKey, {
        period: periodKey,
        year,
        month,
        count: 0,
        items: [],
      });
    }

    const group = milestonesMap.get(periodKey);
    group.count += 1;
    group.items.push(event);
  }

  return Array.from(milestonesMap.values());
};

/**
 * Controller: GET /api/timeline
 * Fetches the unified, chronological patient health timeline.
 */
const getPatientTimeline = async (req, res) => {
  try {
    const caller = req.user;
    if (!caller) {
      return res.status(401).json({
        success: false,
        message: "Authentication required to access health timeline.",
      });
    }

    let targetPatientId;

    if (caller.role === "patient") {
      targetPatientId = caller.id || caller._id;
      // Patient cannot inspect another patient's timeline
      const requestedPatientId = req.query.patientId || req.params.patientId;
      if (
        requestedPatientId &&
        requestedPatientId.toString().trim() !== targetPatientId.toString().trim()
      ) {
        return res.status(403).json({
          success: false,
          message: "Access denied. Patients may only view their own health timeline.",
        });
      }
    } else if (caller.role === "doctor") {
      targetPatientId = req.query.patientId || req.params.patientId;
      if (!targetPatientId) {
        return res.status(400).json({
          success: false,
          message: "Patient ID is required for doctor access to patient health timeline.",
        });
      }

      // Verify clinical authorization between doctor and patient
      const isAuthorized = await isDoctorAuthorizedForPatient(caller, targetPatientId);
      if (!isAuthorized) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied. You do not have an active or scheduled clinical relationship with this patient.",
        });
      }
    } else if (caller.role === "admin") {
      targetPatientId = req.query.patientId || req.params.patientId || caller.id;
    } else {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You are not authorized to access health timelines.",
      });
    }

    // Resolve patient details
    const patientUser = await resolvePatientUser(targetPatientId);
    if (!patientUser) {
      return res.status(404).json({
        success: false,
        message: "Patient not found.",
      });
    }

    const {
      type = "all",
      recordType = "all",
      category,
      status,
      startDate,
      endDate,
      order = "desc",
    } = req.query;

    const requestedRecordType = (type !== "all" ? type : recordType).toLowerCase();
    const shouldIncludeReports =
      requestedRecordType === "all" ||
      requestedRecordType === "reports" ||
      requestedRecordType === "report" ||
      requestedRecordType === "biomarkers";

    const shouldIncludeAppointments =
      requestedRecordType === "all" ||
      requestedRecordType === "appointments" ||
      requestedRecordType === "appointment";

    let rawReports = [];
    let rawAppointments = [];

    // Parse date boundaries
    let startBoundary = null;
    let endBoundary = null;
    if (startDate) {
      const parsedStart = new Date(startDate);
      if (!isNaN(parsedStart.getTime())) {
        startBoundary = parsedStart;
      }
    }
    if (endDate) {
      const parsedEnd = new Date(endDate);
      if (!isNaN(parsedEnd.getTime())) {
        parsedEnd.setHours(23, 59, 59, 999);
        endBoundary = parsedEnd;
      }
    }

    // 1. Fetch Reports
    if (shouldIncludeReports) {
      if (isDbConnected()) {
        const reportFilter = {
          userId: mongoose.Types.ObjectId.isValid(targetPatientId)
            ? new mongoose.Types.ObjectId(targetPatientId)
            : targetPatientId,
        };

        if (category && category !== "All" && category !== "all") {
          reportFilter.category = new RegExp(`^${category.trim()}$`, "i");
        }

        if (startBoundary || endBoundary) {
          reportFilter.createdAt = {};
          if (startBoundary) reportFilter.createdAt.$gte = startBoundary;
          if (endBoundary) reportFilter.createdAt.$lte = endBoundary;
        }

        if (requestedRecordType === "biomarkers") {
          reportFilter["aiAnalysis.abnormalParameters.0"] = { $exists: true };
        }

        rawReports = await Report.find(reportFilter)
          .sort({ createdAt: -1 })
          .lean();
      } else {
        // In-memory fallback
        for (const rep of inMemoryReports.values()) {
          const repPatId = (rep.userId?._id || rep.userId || "").toString();
          if (repPatId === targetPatientId.toString()) {
            if (category && category !== "All" && category !== "all") {
              if (String(rep.category).toLowerCase() !== category.toLowerCase()) continue;
            }
            const rDate = new Date(rep.createdAt || rep.uploadedAt || 0);
            if (startBoundary && rDate < startBoundary) continue;
            if (endBoundary && rDate > endBoundary) continue;
            if (requestedRecordType === "biomarkers") {
              if (!rep.aiAnalysis?.abnormalParameters?.length) continue;
            }
            rawReports.push(rep);
          }
        }
      }
    }

    // 2. Fetch Appointments
    if (shouldIncludeAppointments) {
      if (isDbConnected()) {
        try {
          await expireStaleAppointments({ patientId: targetPatientId });
        } catch (expErr) {
          // non-blocking
        }

        const apptFilter = {
          patientId: mongoose.Types.ObjectId.isValid(targetPatientId)
            ? new mongoose.Types.ObjectId(targetPatientId)
            : targetPatientId,
        };

        if (status && status !== "All" && status !== "all") {
          apptFilter.status = new RegExp(`^${status.trim()}$`, "i");
        }

        if (startBoundary || endBoundary) {
          apptFilter.appointmentDate = {};
          if (startBoundary) apptFilter.appointmentDate.$gte = startBoundary;
          if (endBoundary) apptFilter.appointmentDate.$lte = endBoundary;
        }

        rawAppointments = await Appointment.find(apptFilter)
          .populate("doctorId", "name specialization")
          .sort({ appointmentDate: -1, createdAt: -1 })
          .lean();
      } else {
        // In-memory fallback
        for (const app of inMemoryAppointments.values()) {
          const appPatId = (app.patientId?._id || app.patientId || "").toString();
          if (appPatId === targetPatientId.toString()) {
            if (status && status !== "All" && status !== "all") {
              if (String(app.status).toLowerCase() !== status.toLowerCase()) continue;
            }
            const aDate = new Date(app.appointmentDate || app.createdAt || 0);
            if (startBoundary && aDate < startBoundary) continue;
            if (endBoundary && aDate > endBoundary) continue;
            rawAppointments.push(app);
          }
        }
      }
    }

    // Format events
    const formattedReports = rawReports.map(formatReportTimelineEvent);
    const formattedAppointments = rawAppointments.map(formatAppointmentTimelineEvent);

    // Merge events
    let mergedTimeline = [...formattedReports, ...formattedAppointments];

    // Chronological Sort
    mergedTimeline.sort((a, b) => {
      const timeA = new Date(a.date).getTime();
      const timeB = new Date(b.date).getTime();
      return order === "asc" ? timeA - timeB : timeB - timeA;
    });

    // Compute metrics
    const totalReports = formattedReports.length;
    const totalAppointments = formattedAppointments.length;
    let abnormalBiomarkersCount = 0;
    for (const r of formattedReports) {
      if (r.abnormalParameters && Array.isArray(r.abnormalParameters)) {
        abnormalBiomarkersCount += r.abnormalParameters.length;
      }
    }

    const upcomingAppointmentsCount = formattedAppointments.filter((a) => a.isUpcoming).length;

    // Distinct categories and statuses
    const availableCategories = Array.from(
      new Set(formattedReports.map((r) => r.category).filter(Boolean))
    );
    const availableStatuses = Array.from(
      new Set(formattedAppointments.map((a) => a.status).filter(Boolean))
    );

    // Group into milestones
    const milestones = groupIntoMilestones(mergedTimeline);

    return res.status(200).json({
      success: true,
      patient: {
        _id: patientUser._id || targetPatientId,
        id: patientUser._id || targetPatientId,
        name: patientUser.name || "Patient",
        email: patientUser.email || "",
        phoneNumber: patientUser.phoneNumber || "",
        address: patientUser.address || "",
        gender: patientUser.gender || "",
        bloodGroup: patientUser.bloodGroup || "",
        dateOfBirth: patientUser.dateOfBirth || null,
      },
      metrics: {
        totalRecords: mergedTimeline.length,
        totalReports,
        totalAppointments,
        abnormalBiomarkersCount,
        upcomingAppointmentsCount,
      },
      availableCategories,
      availableStatuses,
      timeline: mergedTimeline,
      milestones,
    });
  } catch (error) {
    console.error("Health timeline error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching patient health timeline.",
    });
  }
};

module.exports = {
  getPatientTimeline,
  formatReportTimelineEvent,
  formatAppointmentTimelineEvent,
  groupIntoMilestones,
  inMemoryAppointments,
};
