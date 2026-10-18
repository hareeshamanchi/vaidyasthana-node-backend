const User = require("../models/User");
const Appointment = require("../models/Appointment");
const Report = require("../models/Report");
const Contact = require("../models/Contact");
const AuditLog = require("../models/AuditLog");
const Notification = require("../models/Notification");
const mongoose = require("mongoose");
const {
  BlobSASPermissions,
  generateBlobSASQueryParameters,
} = require("@azure/storage-blob");
const {
  isAzureStorageConfigured,
  getCredential,
  accountName,
  containerName,
} = require("../config/azureStorage");
const { isDocumentIntelligenceConfigured } = require("../services/documentIntelligenceService");
const { isAzureOpenAIConfigured } = require("../services/aiAnalysisService");
const { checkOllamaAvailability, getOllamaModel } = require("../services/ollamaNutritionService");
const { isEmailConfigured } = require("../services/emailService");
const { notifyVerificationEvent } = require("../config/socket");
const { recordAuditEvent } = require("../services/auditService");

const isDbConnected = () => mongoose.connection.readyState === 1;

// ==========================================
// 1. DASHBOARD OVERVIEW & ANALYTICS
// GET /api/admin/overview
// ==========================================
const getAdminDashboardOverview = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    const [
      totalUsers,
      totalPatients,
      totalDoctors,
      totalAdmins,
      activeUsers,
      suspendedUsers,
      verifiedDoctors,
      pendingDoctors,
      rejectedDoctors,
      totalAppointments,
      upcomingAppointments,
      completedAppointments,
      cancelledAppointments,
      rejectedAppointments,
      expiredAppointments,
      inProgressAppointments,
      totalReports,
      pendingReports,
      completedReports,
      failedReports,
      openSupportQueries,
      recentSecurityEventsCount,
      recentUsers,
      recentAppointments,
      monthlyRegistrations,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ role: "patient" }),
      User.countDocuments({ role: "doctor" }),
      User.countDocuments({ role: { $in: ["admin", "superadmin"] } }),
      User.countDocuments({ status: "active" }),
      User.countDocuments({ status: "suspended" }),
      User.countDocuments({ role: "doctor", verificationStatus: "verified" }),
      User.countDocuments({ role: "doctor", verificationStatus: "pending" }),
      User.countDocuments({ role: "doctor", verificationStatus: "rejected" }),
      Appointment.countDocuments(),
      Appointment.countDocuments({ status: { $in: ["Scheduled", "Confirmed"] } }),
      Appointment.countDocuments({ status: "Completed" }),
      Appointment.countDocuments({ status: "Cancelled" }),
      Appointment.countDocuments({ status: "Rejected" }),
      Appointment.countDocuments({ status: "Expired" }),
      Appointment.countDocuments({ status: "In Progress" }),
      Report.countDocuments(),
      Report.countDocuments({ analysisStatus: { $in: ["Pending", "Processing"] } }),
      Report.countDocuments({ analysisStatus: "Completed" }),
      Report.countDocuments({ analysisStatus: "Failed" }),
      Contact.countDocuments({ status: { $in: ["New", "In Review"] } }),
      AuditLog.countDocuments({
        timestamp: { $gte: twentyFourHoursAgo },
        outcome: { $in: ["failure", "warning"] },
      }),
      User.find()
        .select("_id name email role status verificationStatus createdAt")
        .sort({ createdAt: -1 })
        .limit(5),
      Appointment.find()
        .select("_id patientName doctorName appointmentDate timeSlot status consultationType createdAt")
        .sort({ createdAt: -1 })
        .limit(5),
      User.aggregate([
        { $match: { createdAt: { $gte: sixMonthsAgo } } },
        {
          $group: {
            _id: {
              year: { $year: "$createdAt" },
              month: { $month: "$createdAt" },
            },
            count: { $sum: 1 },
            patients: {
              $sum: { $cond: [{ $eq: ["$role", "patient"] }, 1, 0] },
            },
            doctors: {
              $sum: { $cond: [{ $eq: ["$role", "doctor"] }, 1, 0] },
            },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
      ]),
    ]);

    // Format monthly registration trend data
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const formattedTrends = monthlyRegistrations.map((item) => ({
      label: `${monthNames[item._id.month - 1]} ${item._id.year}`,
      total: item.count,
      patients: item.patients,
      doctors: item.doctors,
    }));

    return res.status(200).json({
      success: true,
      stats: {
        users: {
          total: totalUsers,
          patients: totalPatients,
          doctors: totalDoctors,
          admins: totalAdmins,
          active: activeUsers,
          suspended: suspendedUsers,
        },
        doctors: {
          total: totalDoctors,
          verified: verifiedDoctors,
          pending: pendingDoctors,
          rejected: rejectedDoctors,
        },
        appointments: {
          total: totalAppointments,
          upcoming: upcomingAppointments,
          inProgress: inProgressAppointments,
          completed: completedAppointments,
          cancelled: cancelledAppointments,
          rejected: rejectedAppointments,
          expired: expiredAppointments,
        },
        reports: {
          total: totalReports,
          pendingOrProcessing: pendingReports,
          completed: completedReports,
          failed: failedReports,
        },
        support: {
          openQueries: openSupportQueries,
        },
        security: {
          recentEvents24h: recentSecurityEventsCount,
        },
      },
      analytics: {
        registrationTrends: formattedTrends,
        appointmentDistribution: [
          { status: "Upcoming", count: upcomingAppointments },
          { status: "Completed", count: completedAppointments },
          { status: "In Progress", count: inProgressAppointments },
          { status: "Expired", count: expiredAppointments },
          { status: "Cancelled", count: cancelledAppointments },
          { status: "Rejected", count: rejectedAppointments },
        ],
        doctorVerificationDistribution: [
          { status: "Verified", count: verifiedDoctors },
          { status: "Pending", count: pendingDoctors },
          { status: "Rejected", count: rejectedDoctors },
        ],
      },
      recentActivity: {
        users: recentUsers,
        appointments: recentAppointments,
      },
    });
  } catch (error) {
    console.error("Get Admin Overview Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to compute platform overview statistics.",
    });
  }
};

// Legacy alias for compatibility with existing tests
const getAdminPlatformStats = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const [totalUsers, totalDoctors, verifiedDoctors, pendingDoctors, totalAppointments, totalReports] =
      await Promise.all([
        User.countDocuments(),
        User.countDocuments({ role: "doctor" }),
        User.countDocuments({ role: "doctor", verificationStatus: "verified" }),
        User.countDocuments({ role: "doctor", verificationStatus: "pending" }),
        Appointment.countDocuments(),
        Report.countDocuments(),
      ]);

    return res.status(200).json({
      success: true,
      stats: {
        totalUsers,
        totalDoctors,
        verifiedDoctors,
        pendingDoctors,
        totalAppointments,
        totalReports,
      },
    });
  } catch (error) {
    console.error("Get Admin Stats Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to compute platform statistics.",
    });
  }
};

// ==========================================
// 2. USER MANAGEMENT
// GET /api/admin/users
// ==========================================
const getAdminUsers = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const {
      search = "",
      role = "all",
      status = "all",
      verificationStatus = "all",
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const query = {};

    // Text search by name or email
    if (search && search.trim()) {
      const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "i");
      query.$or = [{ name: regex }, { email: regex }, { phoneNumber: regex }];
    }

    // Role filter
    if (role && role !== "all") {
      query.role = role;
    }

    // Status filter
    if (status && status !== "all") {
      query.status = status;
    }

    // Doctor verification filter
    if (verificationStatus && verificationStatus !== "all") {
      query.verificationStatus = verificationStatus;
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
    const skip = (pageNum - 1) * limitNum;

    // Allowed sort fields
    const allowedSortFields = ["createdAt", "name", "email", "role", "status"];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : "createdAt";
    const sortDirection = sortOrder === "asc" ? 1 : -1;

    const [totalUsers, users] = await Promise.all([
      User.countDocuments(query),
      User.find(query)
        .select("-password -resetPasswordToken -resetPasswordExpires")
        .sort({ [sortField]: sortDirection })
        .skip(skip)
        .limit(limitNum),
    ]);

    return res.status(200).json({
      success: true,
      users,
      pagination: {
        total: totalUsers,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(totalUsers / limitNum) || 1,
      },
    });
  } catch (error) {
    console.error("Get Admin Users Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve user accounts.",
    });
  }
};

// ==========================================
// User Details
// GET /api/admin/users/:id
// ==========================================
const getAdminUserDetails = async (req, res) => {
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
        message: "Invalid user identifier format.",
      });
    }

    const user = await User.findById(id).select("-password -resetPasswordToken -resetPasswordExpires");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User account not found.",
      });
    }

    // Gather operational stats without leaking raw clinical content
    let appointmentStats = { total: 0, upcoming: 0, completed: 0 };
    let reportCount = 0;

    if (user.role === "patient") {
      const [total, upcoming, completed, reports] = await Promise.all([
        Appointment.countDocuments({ patientId: user._id }),
        Appointment.countDocuments({ patientId: user._id, status: { $in: ["Scheduled", "Confirmed"] } }),
        Appointment.countDocuments({ patientId: user._id, status: "Completed" }),
        Report.countDocuments({ userId: user._id }),
      ]);
      appointmentStats = { total, upcoming, completed };
      reportCount = reports;
    } else if (user.role === "doctor") {
      const [total, upcoming, completed] = await Promise.all([
        Appointment.countDocuments({ doctorId: user._id }),
        Appointment.countDocuments({ doctorId: user._id, status: { $in: ["Scheduled", "Confirmed"] } }),
        Appointment.countDocuments({ doctorId: user._id, status: "Completed" }),
      ]);
      appointmentStats = { total, upcoming, completed };
    }

    return res.status(200).json({
      success: true,
      user,
      stats: {
        appointments: appointmentStats,
        reports: reportCount,
      },
    });
  } catch (error) {
    console.error("Get Admin User Details Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load user details.",
    });
  }
};

// ==========================================
// Update User Account Status (Suspend / Reactivate)
// PATCH /api/admin/users/:id/status
// ==========================================
const updateUserStatus = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const { id } = req.params;
    const { status, reason } = req.body;

    if (!["active", "suspended"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Account status must be either 'active' or 'suspended'.",
      });
    }

    if (!reason || !reason.trim()) {
      return res.status(400).json({
        success: false,
        message: "An administrative reason is mandatory when altering account status.",
      });
    }

    // Self-lockout prevention: Administrator cannot suspend their own account
    if (req.user && req.user.id === id) {
      return res.status(400).json({
        success: false,
        message: "Self-lockout prohibited: You cannot suspend your own administrative account.",
      });
    }

    const targetUser = await User.findById(id);
    if (!targetUser) {
      return res.status(404).json({
        success: false,
        message: "Target user account not found.",
      });
    }

    // Protection for last active superadmin
    if (status === "suspended" && (targetUser.role === "superadmin" || targetUser.role === "admin")) {
      const activeAdminCount = await User.countDocuments({
        role: { $in: ["admin", "superadmin"] },
        status: "active",
        _id: { $ne: targetUser._id },
      });
      if (activeAdminCount === 0) {
        return res.status(400).json({
          success: false,
          message: "Action rejected: Cannot suspend the last active administrator on the platform.",
        });
      }
    }

    const oldStatus = targetUser.status || "active";
    targetUser.status = status;

    if (!targetUser.suspensionHistory) {
      targetUser.suspensionHistory = [];
    }

    targetUser.suspensionHistory.push({
      action: status === "suspended" ? "suspended" : "reactivated",
      reason: reason.trim(),
      performedBy: req.user.id,
      performedByEmail: req.user.email,
      timestamp: new Date(),
    });

    await targetUser.save();

    // Record immutable audit event
    await recordAuditEvent({
      eventType: status === "suspended" ? "USER_SUSPENDED" : "USER_REACTIVATED",
      actor: req.user,
      targetId: targetUser._id,
      targetModel: "User",
      action: `Account status updated from '${oldStatus}' to '${status}'`,
      outcome: "success",
      reason: reason.trim(),
      details: {
        userId: targetUser._id,
        userEmail: targetUser.email,
        userRole: targetUser.role,
        oldStatus,
        newStatus: status,
      },
      req,
    });

    return res.status(200).json({
      success: true,
      message: `User ${targetUser.name} (${targetUser.email}) is now ${status}.`,
      user: {
        id: targetUser._id,
        _id: targetUser._id,
        name: targetUser.name,
        email: targetUser.email,
        role: targetUser.role,
        status: targetUser.status,
        suspensionHistory: targetUser.suspensionHistory,
      },
    });
  } catch (error) {
    console.error("Update User Status Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error altering user account status.",
    });
  }
};

// ==========================================
// 3. DOCTOR VERIFICATION MANAGEMENT
// GET /api/admin/doctors/pending-verification
// ==========================================
const getPendingDoctors = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const doctors = await User.find({
      role: "doctor",
      verificationStatus: { $in: ["pending", "not_submitted", "rejected"] },
    })
      .select(
        "_id name email phoneNumber address city specialization qualifications medicalRegistrationNumber verificationStatus verificationDocuments verificationReview createdAt status"
      )
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: doctors.length,
      doctors,
    });
  } catch (error) {
    console.error("Get Pending Doctors Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch doctors pending verification.",
    });
  }
};

// ==========================================
// List All Doctors with Status
// GET /api/admin/doctors
// ==========================================
const getAllDoctors = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const filter = { role: "doctor" };
    if (req.query.status && req.query.status !== "all") {
      filter.verificationStatus = req.query.status;
    }

    const doctors = await User.find(filter)
      .select("-password -resetPasswordToken -resetPasswordExpires")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: doctors.length,
      doctors,
    });
  } catch (error) {
    console.error("Get All Doctors Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch doctor directory.",
    });
  }
};

// ==========================================
// Generate Secure Temporary Access URL for a Credential
// GET /api/admin/doctors/:id/document/:docIndex
// ==========================================
const getDoctorDocumentAccessUrl = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const { id, docIndex } = req.params;

    const doctor = await User.findById(id);
    if (!doctor || doctor.role !== "doctor") {
      return res.status(404).json({
        success: false,
        message: "Doctor not found.",
      });
    }

    const index = parseInt(docIndex, 10);
    const doc = doctor.verificationDocuments?.[index];

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Credential document not found at specified index.",
      });
    }

    // Audit document access
    await recordAuditEvent({
      eventType: "ADMIN_VIEW_DOCTOR_CREDENTIAL",
      actor: req.user,
      targetId: doctor._id,
      targetModel: "User",
      action: `Viewed doctor credential document '${doc.originalName}'`,
      outcome: "success",
      details: { doctorId: doctor._id, docIndex: index, fileName: doc.originalName },
      req,
    });

    if (!isAzureStorageConfigured()) {
      return res.status(200).json({
        success: true,
        document: doc,
        simulated: true,
        message: "Azure Storage is not configured; document metadata returned safely.",
      });
    }

    const credential = getCredential();
    const expiresOn = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes private access

    const sasToken = generateBlobSASQueryParameters(
      {
        containerName: containerName || "medical-reports",
        blobName: doc.blobPath,
        permissions: BlobSASPermissions.parse("r"),
        expiresOn,
      },
      credential
    ).toString();

    const secureUrl = `https://${accountName}.blob.core.windows.net/${containerName}/${doc.blobPath}?${sasToken}`;

    return res.status(200).json({
      success: true,
      url: secureUrl,
      document: doc,
      expiresAt: expiresOn,
    });
  } catch (error) {
    console.error("Get Document Access URL Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error generating private document view link.",
    });
  }
};

// ==========================================
// Review and Update Doctor Verification Decision
// POST /api/admin/doctors/:id/verify
// ==========================================
const verifyDoctor = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const { id } = req.params;
    const { decision, rejectionReason, notes } = req.body;

    if (!["verified", "rejected"].includes(decision)) {
      return res.status(400).json({
        success: false,
        message: "Decision must be either 'verified' or 'rejected'.",
      });
    }

    if (decision === "rejected" && (!rejectionReason || !rejectionReason.trim())) {
      return res.status(400).json({
        success: false,
        message: "Rejection reason is mandatory when declining verification.",
      });
    }

    const doctor = await User.findById(id);
    if (!doctor || doctor.role !== "doctor") {
      return res.status(404).json({
        success: false,
        message: "Doctor account not found.",
      });
    }

    const oldStatus = doctor.verificationStatus;
    doctor.verificationStatus = decision;
    doctor.verificationReview = {
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
      decision,
      rejectionReason: decision === "rejected" ? rejectionReason.trim() : "",
      notes: notes ? notes.trim() : "",
    };

    await doctor.save();

    // Broadcast real-time verification update
    notifyVerificationEvent({
      doctorId: doctor._id,
      status: decision,
      decision,
      rejectionReason: doctor.verificationReview.rejectionReason,
    });

    // Notify doctor
    Notification.create({
      userId: doctor._id,
      title: decision === "verified" ? "Doctor Profile Verified" : "Verification Application Update",
      message:
        decision === "verified"
          ? "Congratulations! Your clinical credentials have been verified by administration. You are now eligible to accept patient consultations."
          : `Your verification submission was reviewed and declined. Reason: ${rejectionReason.trim()}`,
      type: "general",
      link: "/doctor-dashboard",
    }).catch((e) => console.error("Notification creation error:", e.message));

    // Record immutable audit event
    await recordAuditEvent({
      eventType: decision === "verified" ? "DOCTOR_VERIFIED" : "DOCTOR_REJECTED",
      actor: req.user,
      targetId: doctor._id,
      targetModel: "User",
      action: `Doctor verification updated from '${oldStatus}' to '${decision}'`,
      outcome: "success",
      reason: decision === "rejected" ? rejectionReason.trim() : (notes || "Credentials approved"),
      details: {
        doctorId: doctor._id,
        doctorName: doctor.name,
        doctorEmail: doctor.email,
        decision,
      },
      req,
    });

    console.log(
      `[SAFE_LOG] Admin ${req.user.id} updated Doctor ${doctor._id} (${doctor.name}) verification to '${decision}'.`
    );

    return res.status(200).json({
      success: true,
      message: `Doctor ${doctor.name} has been marked as ${decision}.`,
      doctor: {
        id: doctor._id,
        _id: doctor._id,
        name: doctor.name,
        email: doctor.email,
        verificationStatus: doctor.verificationStatus,
        verificationReview: doctor.verificationReview,
      },
    });
  } catch (error) {
    console.error("Verify Doctor Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error updating doctor verification.",
    });
  }
};

// ==========================================
// 4. GLOBAL APPOINTMENT MANAGEMENT
// GET /api/admin/appointments
// ==========================================
const getAdminAppointments = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const {
      search = "",
      status = "all",
      consultationType = "all",
      doctorId,
      patientId,
      startDate,
      endDate,
      page = 1,
      limit = 10,
    } = req.query;

    const query = {};

    if (search && search.trim()) {
      const regex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [{ patientName: regex }, { doctorName: regex }, { patientPhone: regex }];
    }

    if (status && status !== "all") {
      query.status = status;
    }

    if (consultationType && consultationType !== "all") {
      query.consultationType = consultationType;
    }

    if (doctorId && mongoose.Types.ObjectId.isValid(doctorId)) {
      query.doctorId = doctorId;
    }

    if (patientId && mongoose.Types.ObjectId.isValid(patientId)) {
      query.patientId = patientId;
    }

    if (startDate || endDate) {
      query.appointmentDate = {};
      if (startDate) query.appointmentDate.$gte = new Date(startDate);
      if (endDate) query.appointmentDate.$lte = new Date(endDate);
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
    const skip = (pageNum - 1) * limitNum;

    const [totalAppointments, appointments] = await Promise.all([
      Appointment.countDocuments(query),
      Appointment.find(query)
        .populate("patientId", "name email phoneNumber")
        .populate("doctorId", "name email specialization")
        .sort({ appointmentDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
    ]);

    return res.status(200).json({
      success: true,
      appointments,
      pagination: {
        total: totalAppointments,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(totalAppointments / limitNum) || 1,
      },
    });
  } catch (error) {
    console.error("Get Admin Appointments Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve appointments list.",
    });
  }
};

// ==========================================
// Administrative Appointment Update / Dispute Correction
// PATCH /api/admin/appointments/:id
// ==========================================
const updateAdminAppointment = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const { id } = req.params;
    const { status, reason, notes } = req.body;

    const validStatuses = ["Scheduled", "Confirmed", "In Progress", "Completed", "Cancelled", "Rejected", "Expired"];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Permitted: ${validStatuses.join(", ")}`,
      });
    }

    if (!reason || !reason.trim()) {
      return res.status(400).json({
        success: false,
        message: "Administrative reason is mandatory for modifying an appointment record.",
      });
    }

    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: "Appointment record not found.",
      });
    }

    const oldStatus = appointment.status;

    if (status) appointment.status = status;
    if (notes) appointment.notes = notes.trim();

    await appointment.save();

    await recordAuditEvent({
      eventType: "APPOINTMENT_ADMIN_UPDATE",
      actor: req.user,
      targetId: appointment._id,
      targetModel: "Appointment",
      action: `Appointment status updated from '${oldStatus}' to '${status || oldStatus}'`,
      outcome: "success",
      reason: reason.trim(),
      details: {
        appointmentId: appointment._id,
        patientName: appointment.patientName,
        doctorName: appointment.doctorName,
        oldStatus,
        newStatus: status || oldStatus,
      },
      req,
    });

    return res.status(200).json({
      success: true,
      message: "Appointment record updated successfully.",
      appointment,
    });
  } catch (error) {
    console.error("Update Admin Appointment Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update appointment record.",
    });
  }
};

// ==========================================
// 5. MEDICAL REPORT & STORAGE ADMINISTRATION
// GET /api/admin/reports
// ==========================================
const getAdminReports = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const {
      search = "",
      category = "all",
      analysisStatus = "all",
      page = 1,
      limit = 10,
    } = req.query;

    const query = {};

    if (search && search.trim()) {
      const regex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [{ originalName: regex }, { category: regex }, { uploaderName: regex }];
    }

    if (category && category !== "all") {
      query.category = category;
    }

    if (analysisStatus && analysisStatus !== "all") {
      query.analysisStatus = analysisStatus;
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
    const skip = (pageNum - 1) * limitNum;

    // Strict projection: NEVER return raw OCR text or clinical diagnostic AI findings in table list
    const [totalReports, reports] = await Promise.all([
      Report.countDocuments(query),
      Report.find(query)
        .select(
          "_id userId uploadedBy uploadedByRole uploaderName fileName originalName fileType fileSize category analysisStatus processingStage errorMessage uploadedAt createdAt"
        )
        .populate("userId", "name email")
        .populate("uploadedBy", "name email role")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
    ]);

    return res.status(200).json({
      success: true,
      reports,
      pagination: {
        total: totalReports,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(totalReports / limitNum) || 1,
      },
    });
  } catch (error) {
    console.error("Get Admin Reports Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve medical report operational logs.",
    });
  }
};

// ==========================================
// 6. SECURITY DASHBOARD & AUDIT LOGS
// GET /api/admin/security/audit-logs
// ==========================================
const getAdminAuditLogs = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const {
      eventType = "all",
      outcome = "all",
      search = "",
      startDate,
      endDate,
      page = 1,
      limit = 15,
    } = req.query;

    const query = {};

    if (eventType && eventType !== "all") {
      query.eventType = eventType;
    }

    if (outcome && outcome !== "all") {
      query.outcome = outcome;
    }

    if (search && search.trim()) {
      const regex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [{ actorEmail: regex }, { action: regex }, { reason: regex }];
    }

    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) query.timestamp.$gte = new Date(startDate);
      if (endDate) query.timestamp.$lte = new Date(endDate);
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 15));
    const skip = (pageNum - 1) * limitNum;

    const [totalEvents, logs] = await Promise.all([
      AuditLog.countDocuments(query),
      AuditLog.find(query)
        .populate("actorId", "name email role")
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limitNum),
    ]);

    return res.status(200).json({
      success: true,
      logs,
      pagination: {
        total: totalEvents,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(totalEvents / limitNum) || 1,
      },
    });
  } catch (error) {
    console.error("Get Admin Audit Logs Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve system security logs.",
    });
  }
};

// ==========================================
// Security Overview Metrics
// GET /api/admin/security/overview
// ==========================================
const getAdminSecurityOverview = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      failedLogins24h,
      successfulLogins24h,
      unauthorizedAttempts24h,
      rateLimitEvents24h,
      passwordResetRequests24h,
      suspensions7d,
      recentSecurityAlerts,
    ] = await Promise.all([
      AuditLog.countDocuments({
        eventType: "AUTH_LOGIN_FAILURE",
        timestamp: { $gte: twentyFourHoursAgo },
      }),
      AuditLog.countDocuments({
        eventType: { $in: ["AUTH_LOGIN_SUCCESS", "AUTH_ADMIN_LOGIN_SUCCESS"] },
        timestamp: { $gte: twentyFourHoursAgo },
      }),
      AuditLog.countDocuments({
        eventType: "UNAUTHORIZED_ADMIN_ATTEMPT",
        timestamp: { $gte: twentyFourHoursAgo },
      }),
      AuditLog.countDocuments({
        eventType: "RATE_LIMIT_TRIGGERED",
        timestamp: { $gte: twentyFourHoursAgo },
      }),
      AuditLog.countDocuments({
        eventType: "AUTH_PASSWORD_RESET_REQUEST",
        timestamp: { $gte: twentyFourHoursAgo },
      }),
      AuditLog.countDocuments({
        eventType: "USER_SUSPENDED",
        timestamp: { $gte: sevenDaysAgo },
      }),
      AuditLog.find({
        outcome: { $in: ["failure", "warning"] },
      })
        .sort({ timestamp: -1 })
        .limit(8),
    ]);

    return res.status(200).json({
      success: true,
      summary: {
        failedLogins24h,
        successfulLogins24h,
        unauthorizedAttempts24h,
        rateLimitEvents24h,
        passwordResetRequests24h,
        suspensions7d,
      },
      recentAlerts: recentSecurityAlerts,
    });
  } catch (error) {
    console.error("Get Admin Security Overview Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to compute security overview.",
    });
  }
};

// ==========================================
// 7. SYSTEM HEALTH AND OPERATIONS
// GET /api/admin/system-health
// ==========================================
const getAdminSystemHealth = async (req, res) => {
  try {
    const dbState = mongoose.connection.readyState;
    const dbStatusMap = {
      0: "Disconnected",
      1: "Connected",
      2: "Connecting",
      3: "Disconnecting",
    };

    // Calculate DB ping latency
    let dbLatencyMs = 0;
    if (dbState === 1 && mongoose.connection.db) {
      const pingStart = Date.now();
      try {
        await mongoose.connection.db.admin().ping();
        dbLatencyMs = Date.now() - pingStart;
      } catch (e) {
        dbLatencyMs = -1;
      }
    }

    const storageConfigured = isAzureStorageConfigured();
    const docIntelConfigured = isDocumentIntelligenceConfigured();
    const openAIConfigured = isAzureOpenAIConfigured();
    const ollamaStatus = await checkOllamaAvailability();
    const emailConfigured = isEmailConfigured();

    const memUsage = process.memoryUsage();

    const services = {
      backend: {
        status: "Healthy",
        uptimeSeconds: Math.floor(process.uptime()),
        memoryRssMb: Math.round(memUsage.rss / (1024 * 1024)),
        nodeVersion: process.version,
        environment: process.env.NODE_ENV || "development",
      },
      database: {
        status: dbState === 1 ? "Healthy" : "Degraded",
        connectionState: dbStatusMap[dbState] || "Unknown",
        latencyMs: dbLatencyMs,
      },
      azureBlobStorage: {
        configured: storageConfigured,
        status: storageConfigured ? "Healthy" : "Not Configured",
        container: process.env.AZURE_CONTAINER_NAME || "medical-reports",
      },
      azureDocumentIntelligence: {
        configured: docIntelConfigured,
        status: docIntelConfigured ? "Healthy" : "Not Configured",
      },
      azureOpenAI: {
        configured: openAIConfigured,
        status: openAIConfigured ? "Healthy" : "Not Configured",
        deployment: process.env.AZURE_OPENAI_DEPLOYMENT ? "Configured" : "Not Set",
      },
      ollamaAI: {
        configured: true,
        available: ollamaStatus.available,
        status: ollamaStatus.available ? "Online" : "Offline",
        model: getOllamaModel(),
        modelInstalled: ollamaStatus.isModelInstalled,
      },
      emailTransport: {
        configured: emailConfigured,
        status: emailConfigured ? "Healthy" : "Not Configured",
        smtpHostConfigured: Boolean(process.env.SMTP_HOST),
      },
      appointmentExpiryWorker: {
        status: "Active",
        intervalSeconds: 60,
      },
    };

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      services,
    });
  } catch (error) {
    console.error("Get Admin System Health Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to gather system health status.",
    });
  }
};

// ==========================================
// 8. SUPPORT AND CONTACT MANAGEMENT
// GET /api/admin/support
// ==========================================
const getAdminSupportQueries = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const { status = "all", search = "", page = 1, limit = 10 } = req.query;

    const query = {};

    if (status && status !== "all") {
      query.status = status;
    }

    if (search && search.trim()) {
      const regex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [{ name: regex }, { email: regex }, { query: regex }];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
    const skip = (pageNum - 1) * limitNum;

    const [totalQueries, queries] = await Promise.all([
      Contact.countDocuments(query),
      Contact.find(query)
        .populate("resolvedBy", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
    ]);

    return res.status(200).json({
      success: true,
      queries,
      pagination: {
        total: totalQueries,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(totalQueries / limitNum) || 1,
      },
    });
  } catch (error) {
    console.error("Get Admin Support Queries Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve support inquiries.",
    });
  }
};

// Update Support Query Status
// PATCH /api/admin/support/:id
const updateSupportQueryStatus = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const { id } = req.params;
    const { status, resolutionNotes } = req.body;

    if (!["New", "In Review", "Resolved"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be 'New', 'In Review', or 'Resolved'.",
      });
    }

    const inquiry = await Contact.findById(id);
    if (!inquiry) {
      return res.status(404).json({
        success: false,
        message: "Support inquiry record not found.",
      });
    }

    const oldStatus = inquiry.status;
    inquiry.status = status;
    if (resolutionNotes !== undefined) {
      inquiry.resolutionNotes = resolutionNotes.trim();
    }
    if (status === "Resolved") {
      inquiry.resolvedBy = req.user.id;
      inquiry.resolvedAt = new Date();
    }

    await inquiry.save();

    await recordAuditEvent({
      eventType: "SUPPORT_STATUS_UPDATE",
      actor: req.user,
      targetId: inquiry._id,
      targetModel: "Contact",
      action: `Support inquiry status updated from '${oldStatus}' to '${status}'`,
      outcome: "success",
      reason: resolutionNotes || "",
      details: { inquiryId: inquiry._id, from: inquiry.email, status },
      req,
    });

    return res.status(200).json({
      success: true,
      message: `Inquiry marked as ${status}.`,
      inquiry,
    });
  } catch (error) {
    console.error("Update Support Query Status Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update support inquiry.",
    });
  }
};

// ==========================================
// 9. ADMINISTRATOR NOTIFICATIONS
// GET /api/admin/notifications
// ==========================================
const getAdminNotifications = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const notifications = await Notification.find({
      userId: req.user.id,
    })
      .sort({ createdAt: -1 })
      .limit(20);

    const unreadCount = await Notification.countDocuments({
      userId: req.user.id,
      isRead: false,
    });

    return res.status(200).json({
      success: true,
      notifications,
      unreadCount,
    });
  } catch (error) {
    console.error("Get Admin Notifications Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve administrative notifications.",
    });
  }
};

module.exports = {
  getAdminDashboardOverview,
  getAdminPlatformStats,
  getAdminUsers,
  getAdminUserDetails,
  updateUserStatus,
  getPendingDoctors,
  getAllDoctors,
  getDoctorDocumentAccessUrl,
  verifyDoctor,
  getAdminAppointments,
  updateAdminAppointment,
  getAdminReports,
  getAdminAuditLogs,
  getAdminSecurityOverview,
  getAdminSystemHealth,
  getAdminSupportQueries,
  updateSupportQueryStatus,
  getAdminNotifications,
};
