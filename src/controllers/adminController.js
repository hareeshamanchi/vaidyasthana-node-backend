const User = require("../models/User");
const Appointment = require("../models/Appointment");
const Report = require("../models/Report");
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
const { notifyVerificationEvent } = require("../config/socket");

const isDbConnected = () => mongoose.connection.readyState === 1;

// ==========================================
// Admin: Get Doctors Pending Verification
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
        "_id name email phoneNumber address city specialization qualifications medicalRegistrationNumber verificationStatus verificationDocuments verificationReview createdAt"
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
// Admin: List All Doctors with Status
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
    if (req.query.status) {
      filter.verificationStatus = req.query.status;
    }

    const doctors = await User.find(filter)
      .select("-password")
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
// Admin: Generate Secure Temporary Access URL for a Credential
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

    if (!isAzureStorageConfigured()) {
      // In development / test mode without Azure credentials
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
// Admin: Review and Update Doctor Verification Decision
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
// Admin: Platform Overview Statistics
// GET /api/admin/stats
// ==========================================
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

module.exports = {
  getPendingDoctors,
  getAllDoctors,
  getDoctorDocumentAccessUrl,
  verifyDoctor,
  getAdminPlatformStats,
};
