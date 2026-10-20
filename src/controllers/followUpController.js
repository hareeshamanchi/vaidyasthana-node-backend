const FollowUp = require("../models/FollowUp");
const Appointment = require("../models/Appointment");
const User = require("../models/User");
const mongoose = require("mongoose");
const { createNotification } = require("../services/notificationService");
const { sendPushToUser } = require("../services/pushNotificationService");

const isDbConnected = () => mongoose.connection && mongoose.connection.readyState === 1;

/**
 * Format Doctor Name with Dr. prefix if needed
 */
const formatDoctorTitle = (name) => {
  if (!name) return "Dr. Clinician";
  return name.startsWith("Dr.") ? name : `Dr. ${name}`;
};

// ==========================================
// Create Follow-Up Plan (Doctor only)
// POST /api/follow-ups
// ==========================================
const createFollowUp = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    // Only doctors or admins can create follow-up plans
    if (req.user.role !== "doctor" && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only verified doctors can author clinical follow-up plans.",
      });
    }

    const {
      patientId,
      consultationId,
      reason,
      doctorInstructions,
      recommendedDate,
      recommendedDateRange,
      priority,
      recommendedTests,
      notes,
    } = req.body;

    if (!patientId || !mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({
        success: false,
        message: "A valid patient reference ID is required.",
      });
    }

    if (!reason || !reason.trim()) {
      return res.status(400).json({
        success: false,
        message: "Follow-up clinical reason is required.",
      });
    }

    if (!doctorInstructions || !doctorInstructions.trim()) {
      return res.status(400).json({
        success: false,
        message: "Doctor clinical instructions are required.",
      });
    }

    if (!recommendedDate) {
      return res.status(400).json({
        success: false,
        message: "Recommended follow-up date is required.",
      });
    }

    const parsedRecDate = new Date(recommendedDate);
    if (isNaN(parsedRecDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid recommended follow-up date format.",
      });
    }

    // Verify patient existence
    const patientUser = await User.findById(patientId);
    if (!patientUser || patientUser.role !== "patient") {
      return res.status(404).json({
        success: false,
        message: "Patient account not found in verified database.",
      });
    }

    // Doctor profile lookup
    const doctorUser = await User.findById(req.user.id);
    const doctorName = formatDoctorTitle(doctorUser ? doctorUser.name : req.user.name);

    // Validate consultation reference if provided
    let verifiedConsultationId = null;
    if (consultationId && mongoose.Types.ObjectId.isValid(consultationId)) {
      const consultation = await Appointment.findById(consultationId);
      if (consultation) {
        verifiedConsultationId = consultation._id;
      }
    }

    // Validate priority
    const validPriorities = ["routine", "soon", "urgent"];
    const planPriority = validPriorities.includes(priority) ? priority : "routine";

    // Format recommended tests
    let testsArray = [];
    if (Array.isArray(recommendedTests)) {
      testsArray = recommendedTests.map((t) => String(t).trim()).filter(Boolean);
    } else if (typeof recommendedTests === "string") {
      testsArray = recommendedTests.split(",").map((t) => t.trim()).filter(Boolean);
    }

    // Format date range if provided
    let dateRange = { startDate: null, endDate: null };
    if (recommendedDateRange && (recommendedDateRange.startDate || recommendedDateRange.endDate)) {
      dateRange = {
        startDate: recommendedDateRange.startDate ? new Date(recommendedDateRange.startDate) : null,
        endDate: recommendedDateRange.endDate ? new Date(recommendedDateRange.endDate) : null,
      };
    }

    const followUp = await FollowUp.create({
      patientId: patientUser._id,
      doctorId: req.user.id,
      doctorName,
      patientName: patientUser.name,
      patientEmail: patientUser.email || "",
      patientPhone: patientUser.phoneNumber || "",
      consultationId: verifiedConsultationId,
      reason: reason.trim(),
      doctorInstructions: doctorInstructions.trim(),
      recommendedDate: parsedRecDate,
      recommendedDateRange: dateRange,
      priority: planPriority,
      recommendedTests: testsArray,
      notes: (notes || "").trim(),
      status: "pending_booking",
    });

    // Notify patient in-app and background push
    const dateFormatted = parsedRecDate.toISOString().slice(0, 10);
    createNotification({
      userId: patientUser._id,
      title: "New Follow-Up Care Plan Created",
      message: `${doctorName} created a follow-up care plan for ${dateFormatted}. Tap to review instructions and schedule your consultation.`,
      type: "follow_up_created",
      relatedId: followUp._id,
      relatedModel: "FollowUp",
      link: `/appointment?followUpId=${followUp._id}&doctorId=${req.user.id}`,
    }).catch((err) => console.warn("Patient follow-up notify error:", err.message));

    try {
      sendPushToUser(patientUser._id, {
        title: "New Follow-Up Plan",
        body: `${doctorName} created a recommended follow-up for ${dateFormatted}. Tap to schedule your appointment.`,
        tag: `follow-up-created-${followUp._id}`,
        data: { url: `/appointment?followUpId=${followUp._id}&doctorId=${req.user.id}` },
      });
    } catch {}

    return res.status(201).json({
      success: true,
      message: "Follow-up care plan created successfully.",
      followUp,
    });
  } catch (error) {
    console.error("Create Follow-Up Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create follow-up plan.",
    });
  }
};

// ==========================================
// Get Follow-Ups (Patient or Doctor scoped)
// GET /api/follow-ups
// ==========================================
const getFollowUps = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const query = {};
    const { status, priority, patientId, fromDate, toDate } = req.query;

    if (req.user.role === "patient") {
      // Patients strictly view their own follow-ups
      query.patientId = req.user.id;
    } else if (req.user.role === "doctor") {
      // Doctors view follow-ups they authored, or optionally filter by patientId
      query.doctorId = req.user.id;
      if (patientId && mongoose.Types.ObjectId.isValid(patientId)) {
        query.patientId = patientId;
      }
    } else if (req.user.role === "admin" || req.user.role === "superadmin") {
      if (patientId && mongoose.Types.ObjectId.isValid(patientId)) {
        query.patientId = patientId;
      }
    }

    if (status && status !== "all") {
      query.status = status;
    }

    if (priority && ["routine", "soon", "urgent"].includes(priority)) {
      query.priority = priority;
    }

    if (fromDate || toDate) {
      query.recommendedDate = {};
      if (fromDate) query.recommendedDate.$gte = new Date(fromDate);
      if (toDate) query.recommendedDate.$lte = new Date(toDate);
    }

    const followUps = await FollowUp.find(query)
      .populate("doctorId", "name specialization email phoneNumber")
      .populate("patientId", "name email phoneNumber address")
      .populate("appointmentId", "appointmentDate timeSlot status consultationType")
      .populate("consultationId", "appointmentDate timeSlot status")
      .sort({ recommendedDate: 1, createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: followUps.length,
      followUps,
    });
  } catch (error) {
    console.error("Get Follow-Ups Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve follow-up plans.",
    });
  }
};

// ==========================================
// Get Single Follow-Up by ID
// GET /api/follow-ups/:id
// ==========================================
const getFollowUpById = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const followUp = await FollowUp.findById(req.params.id)
      .populate("doctorId", "name specialization email phoneNumber")
      .populate("patientId", "name email phoneNumber address")
      .populate("appointmentId")
      .populate("consultationId");

    if (!followUp) {
      return res.status(404).json({
        success: false,
        message: "Follow-up plan not found.",
      });
    }

    // Authorization check
    const patientRefStr = followUp.patientId?._id?.toString() || followUp.patientId?.toString();
    const doctorRefStr = followUp.doctorId?._id?.toString() || followUp.doctorId?.toString();

    const isPatientOwner = patientRefStr === req.user.id;
    const isDoctorAuthor = doctorRefStr === req.user.id;
    const isAdmin = req.user.role === "admin" || req.user.role === "superadmin";

    if (!isPatientOwner && !isDoctorAuthor && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You are not authorized to view this follow-up plan.",
      });
    }

    return res.status(200).json({
      success: true,
      followUp,
    });
  } catch (error) {
    console.error("Get Follow-Up By ID Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve follow-up details.",
    });
  }
};

// ==========================================
// Update Follow-Up Plan (Doctor only)
// PUT /api/follow-ups/:id
// ==========================================
const updateFollowUp = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const followUp = await FollowUp.findById(req.params.id);
    if (!followUp) {
      return res.status(404).json({
        success: false,
        message: "Follow-up plan not found.",
      });
    }

    // Only the authoring doctor or admin can modify clinical instructions
    const doctorRefStr = followUp.doctorId?.toString();
    const isDoctorAuthor = doctorRefStr === req.user.id;
    const isAdmin = req.user.role === "admin" || req.user.role === "superadmin";

    if (!isDoctorAuthor && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "Access denied. Patients cannot modify doctor follow-up instructions or dates.",
      });
    }

    if (followUp.status === "cancelled" || followUp.status === "completed") {
      return res.status(400).json({
        success: false,
        message: `Cannot edit a follow-up plan that is already ${followUp.status}.`,
      });
    }

    const {
      reason,
      doctorInstructions,
      recommendedDate,
      recommendedDateRange,
      priority,
      recommendedTests,
      notes,
    } = req.body;

    if (reason && reason.trim()) followUp.reason = reason.trim();
    if (doctorInstructions && doctorInstructions.trim()) {
      followUp.doctorInstructions = doctorInstructions.trim();
    }
    if (recommendedDate) {
      const parsedDate = new Date(recommendedDate);
      if (!isNaN(parsedDate.getTime())) {
        followUp.recommendedDate = parsedDate;
      }
    }
    if (recommendedDateRange) {
      followUp.recommendedDateRange = {
        startDate: recommendedDateRange.startDate ? new Date(recommendedDateRange.startDate) : null,
        endDate: recommendedDateRange.endDate ? new Date(recommendedDateRange.endDate) : null,
      };
    }
    if (priority && ["routine", "soon", "urgent"].includes(priority)) {
      followUp.priority = priority;
    }
    if (recommendedTests !== undefined) {
      followUp.recommendedTests = Array.isArray(recommendedTests)
        ? recommendedTests.map((t) => String(t).trim()).filter(Boolean)
        : String(recommendedTests).split(",").map((t) => t.trim()).filter(Boolean);
    }
    if (notes !== undefined) followUp.notes = notes.trim();

    await followUp.save();

    // Notify patient of update
    createNotification({
      userId: followUp.patientId,
      title: "Follow-Up Care Plan Updated",
      message: `${followUp.doctorName} updated your follow-up care instructions. Tap to review.`,
      type: "follow_up_created",
      relatedId: followUp._id,
      relatedModel: "FollowUp",
      link: `/appointment?followUpId=${followUp._id}&doctorId=${followUp.doctorId}`,
    }).catch((e) => console.warn("Patient follow-up update notify error:", e.message));

    return res.status(200).json({
      success: true,
      message: "Follow-up care plan updated successfully.",
      followUp,
    });
  } catch (error) {
    console.error("Update Follow-Up Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update follow-up plan.",
    });
  }
};

// ==========================================
// Cancel Follow-Up Plan (Doctor only)
// PATCH /api/follow-ups/:id/cancel
// ==========================================
const cancelFollowUp = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const followUp = await FollowUp.findById(req.params.id);
    if (!followUp) {
      return res.status(404).json({
        success: false,
        message: "Follow-up plan not found.",
      });
    }

    const doctorRefStr = followUp.doctorId?.toString();
    const isDoctorAuthor = doctorRefStr === req.user.id;
    const isAdmin = req.user.role === "admin" || req.user.role === "superadmin";

    if (!isDoctorAuthor && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "Access denied. Only the authoring doctor can cancel a follow-up care plan.",
      });
    }

    if (followUp.status === "completed") {
      return res.status(400).json({
        success: false,
        message: "Cannot cancel a follow-up plan that has already been completed.",
      });
    }

    followUp.status = "cancelled";
    followUp.cancellationReason = req.body?.cancellationReason || "Cancelled by physician";
    await followUp.save();

    createNotification({
      userId: followUp.patientId,
      title: "Follow-Up Plan Cancelled",
      message: `Your follow-up plan with ${followUp.doctorName} has been cancelled. Reason: ${followUp.cancellationReason}`,
      type: "general",
      relatedId: followUp._id,
      relatedModel: "FollowUp",
      link: "/dashboard",
    }).catch((e) => console.warn("Follow-up cancellation notify error:", e.message));

    return res.status(200).json({
      success: true,
      message: "Follow-up care plan cancelled.",
      followUp,
    });
  } catch (error) {
    console.error("Cancel Follow-Up Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to cancel follow-up plan.",
    });
  }
};

// ==========================================
// Doctor Follow-Up Management Stats
// GET /api/follow-ups/doctor/stats
// ==========================================
const getDoctorFollowUpStats = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    if (req.user.role !== "doctor" && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only medical staff can access clinician follow-up statistics.",
      });
    }

    const docId = req.user.id;

    const [total, pendingBooking, appointmentBooked, completed, missed, cancelled] = await Promise.all([
      FollowUp.countDocuments({ doctorId: docId }),
      FollowUp.countDocuments({ doctorId: docId, status: "pending_booking" }),
      FollowUp.countDocuments({ doctorId: docId, status: "appointment_booked" }),
      FollowUp.countDocuments({ doctorId: docId, status: "completed" }),
      FollowUp.countDocuments({ doctorId: docId, status: "missed" }),
      FollowUp.countDocuments({ doctorId: docId, status: "cancelled" }),
    ]);

    return res.status(200).json({
      success: true,
      stats: {
        total,
        pendingBooking,
        appointmentBooked,
        completed,
        missed,
        cancelled,
      },
    });
  } catch (error) {
    console.error("Get Doctor Follow-Up Stats Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve doctor follow-up statistics.",
    });
  }
};

module.exports = {
  createFollowUp,
  getFollowUps,
  getFollowUpById,
  updateFollowUp,
  cancelFollowUp,
  getDoctorFollowUpStats,
};
