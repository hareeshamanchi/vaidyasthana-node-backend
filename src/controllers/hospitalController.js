const mongoose = require("mongoose");
const Hospital = require("../models/Hospital");
const HospitalInvitation = require("../models/HospitalInvitation");
const User = require("../models/User");
const Appointment = require("../models/Appointment");
const bcrypt = require("bcryptjs");
const { recordAuditEvent } = require("../services/auditService");
const { sendHospitalInvitationEmail } = require("../services/emailService");

/**
 * Onboard a new Hospital Tenant (Platform Owner only)
 * POST /api/hospitals
 */
const createHospital = async (req, res) => {
  try {
    const {
      name,
      hospitalCode,
      address,
      city,
      state,
      postalCode,
      contactEmail,
      contactPhone,
      emergencyContact,
      timezone,
      branding,
      subscription,
      operationalHours,
      initialAdmin,
    } = req.body;

    if (!name || !hospitalCode || !contactEmail) {
      return res.status(400).json({
        success: false,
        message: "Hospital name, unique hospital code, and contact email are required.",
      });
    }

    const cleanCode = hospitalCode.trim().toUpperCase();

    let existingAdminUser = null;
    let adminEmail = null;

    // Validate initial hospital admin setup prior to creating tenant record
    if (initialAdmin && initialAdmin.email) {
      adminEmail = initialAdmin.email.toLowerCase().trim();

      // Guard: Platform Owner cannot assign their own superadmin account as a hospital admin
      if (req.user && req.user.role === "superadmin" && adminEmail === req.user.email.toLowerCase().trim()) {
        return res.status(400).json({
          success: false,
          message: "Platform Owner cannot designate their own superadmin account as a hospital administrator. Please provide a separate email address for the hospital administrator.",
        });
      }

      existingAdminUser = await User.findOne({ email: adminEmail });

      if (existingAdminUser) {
        // Guard: Prevent any superadmin from being demoted or bound to a single hospital
        if (existingAdminUser.role === "superadmin") {
          return res.status(400).json({
            success: false,
            message: `The account '${adminEmail}' is a Platform Owner (superadmin) and cannot be assigned as a hospital-level administrator. Please provide a distinct email address for the hospital administrator.`,
          });
        }

        // Associate existing user if not already attached to another hospital
        if (existingAdminUser.hospitalId) {
          return res.status(400).json({
            success: false,
            message: `User with email ${adminEmail} is already affiliated with another hospital tenant.`,
          });
        }
      }
    }

    // Check code uniqueness
    const existingCode = await Hospital.findOne({ hospitalCode: cleanCode });
    if (existingCode) {
      return res.status(409).json({
        success: false,
        message: `Hospital code '${cleanCode}' is already registered to another institution.`,
      });
    }

    // Create Hospital tenant
    const hospital = await Hospital.create({
      name: name.trim(),
      hospitalCode: cleanCode,
      address: address || "",
      city: city || "",
      state: state || "",
      postalCode: postalCode || "",
      contactEmail: contactEmail.toLowerCase().trim(),
      contactPhone: contactPhone || "",
      emergencyContact: emergencyContact || "",
      timezone: timezone || "Asia/Kolkata",
      branding: branding || { primaryColor: "#0d9488" },
      subscription: subscription || {
        plan: "trial",
        status: "trial",
        maxStaff: 50,
        maxDoctors: 20,
      },
      operationalHours: operationalHours || {
        start: "08:00 AM",
        end: "08:00 PM",
        workingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
      },
      status: "active",
      createdBy: req.user._id,
    });

    let adminResult = null;
    let inviteResult = null;

    // Optional initial hospital admin setup
    if (adminEmail) {
      if (existingAdminUser) {
        existingAdminUser.role = "hospital_admin";
        existingAdminUser.hospitalId = hospital._id;
        if (initialAdmin.name) existingAdminUser.name = initialAdmin.name.trim();
        await existingAdminUser.save();
        adminResult = {
          id: existingAdminUser._id,
          name: existingAdminUser.name,
          email: existingAdminUser.email,
          role: "hospital_admin",
        };
      } else if (initialAdmin.password) {
        // Direct creation with credentials
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(initialAdmin.password, salt);

        const newAdmin = await User.create({
          name: initialAdmin.name || `${hospital.name} Admin`,
          email: adminEmail,
          password: hashedPassword,
          phoneNumber: initialAdmin.phoneNumber || "",
          role: "hospital_admin",
          hospitalId: hospital._id,
          status: "active",
        });

        adminResult = {
          id: newAdmin._id,
          name: newAdmin.name,
          email: newAdmin.email,
          role: "hospital_admin",
        };
      } else {
        // Generate single-use invitation token
        const { invitation, rawToken } = await HospitalInvitation.createInvitation({
          hospitalId: hospital._id,
          email: adminEmail,
          name: initialAdmin.name || "",
          role: "hospital_admin",
          invitedBy: req.user._id,
          expiryDays: 7,
        });

        const setupLink = `/accept-invitation?token=${rawToken}`;
        const frontendUrl = process.env.FRONTEND_URL || "https://vaidyasthana-frontend.onrender.com";
        const fullSetupUrl = `${frontendUrl.replace(/\/$/, "")}${setupLink}`;

        // Attempt asynchronous email dispatch without blocking API response
        sendHospitalInvitationEmail({
          to: adminEmail,
          name: initialAdmin.name,
          hospitalName: hospital.name,
          role: "hospital_admin",
          setupLink: fullSetupUrl,
          expiresAt: invitation.expiresAt,
        }).catch((err) => {
          console.warn("[SAFE_DIAGNOSTIC] Hospital admin invite email dispatch warning:", err.message);
        });

        inviteResult = {
          invitationId: invitation._id,
          token: rawToken,
          expiresAt: invitation.expiresAt,
          setupLink,
        };
      }
    }

    recordAuditEvent({
      eventType: "HOSPITAL_ONBOARDED",
      actor: req.user,
      action: `Onboarded new hospital tenant: ${hospital.name} (${hospital.hospitalCode})`,
      outcome: "success",
      targetId: hospital._id,
      req,
    });

    return res.status(201).json({
      success: true,
      message: `Hospital '${hospital.name}' onboarded successfully.`,
      hospital,
      admin: adminResult,
      invitation: inviteResult,
    });
  } catch (error) {
    console.error("Error creating hospital tenant:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to onboard hospital tenant.",
    });
  }
};

/**
 * List all Hospitals (Platform Owner only)
 * GET /api/hospitals
 */
const getHospitals = async (req, res) => {
  try {
    const { status, plan, search } = req.query;
    const query = {};

    if (status) query.status = status;
    if (plan) query["subscription.plan"] = plan;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { hospitalCode: { $regex: search, $options: "i" } },
        { city: { $regex: search, $options: "i" } },
      ];
    }

    const hospitals = await Hospital.find(query).sort({ createdAt: -1 });

    // Aggregate staff and doctor counts
    const hospitalIds = hospitals.map((h) => h._id);
    const staffCounts = await User.aggregate([
      { $match: { hospitalId: { $in: hospitalIds } } },
      {
        $group: {
          _id: { hospitalId: "$hospitalId", role: "$role" },
          count: { $sum: 1 },
        },
      },
    ]);

    const enriched = hospitals.map((h) => {
      const hObj = h.toObject();
      const hStaff = staffCounts.filter(
        (sc) => sc._id.hospitalId && sc._id.hospitalId.toString() === h._id.toString()
      );
      hObj.totalStaff = hStaff
        .filter((sc) => sc._id.role !== "patient")
        .reduce((sum, sc) => sum + sc.count, 0);
      hObj.totalDoctors = (hStaff.find((sc) => sc._id.role === "doctor") || {}).count || 0;
      hObj.totalPatients = (hStaff.find((sc) => sc._id.role === "patient") || {}).count || 0;
      return hObj;
    });

    return res.status(200).json({
      success: true,
      count: enriched.length,
      hospitals: enriched,
    });
  } catch (error) {
    console.error("Error listing hospitals:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve hospitals.",
    });
  }
};

/**
 * Get Hospital Details by ID
 * GET /api/hospitals/:id
 */
const getHospitalById = async (req, res) => {
  try {
    const { id } = req.params;
    const hospital = await Hospital.findById(id);

    if (!hospital) {
      return res.status(404).json({
        success: false,
        message: "Hospital tenant not found.",
      });
    }

    // Role-based authorization check:
    // If not superadmin, hospital_admin can only view their own hospital
    if (
      req.user.role !== "superadmin" &&
      (!req.user.hospitalId || req.user.hospitalId.toString() !== hospital._id.toString())
    ) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You are not authorized to view another hospital's details.",
      });
    }

    const [staffCount, doctorCount, patientCount, appointmentCount] = await Promise.all([
      User.countDocuments({
        hospitalId: hospital._id,
        role: { $in: ["doctor", "nurse", "receptionist", "lab_technician", "pharmacist", "billing_staff", "hospital_admin"] },
      }),
      User.countDocuments({ hospitalId: hospital._id, role: "doctor" }),
      User.countDocuments({ hospitalId: hospital._id, role: "patient" }),
      Appointment.countDocuments({ hospitalId: hospital._id }),
    ]);

    return res.status(200).json({
      success: true,
      hospital: {
        ...hospital.toObject(),
        metrics: {
          staffCount,
          doctorCount,
          patientCount,
          appointmentCount,
        },
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch hospital details.",
    });
  }
};

/**
 * Update Hospital Details
 * PUT /api/hospitals/:id
 */
const updateHospital = async (req, res) => {
  try {
    const { id } = req.params;
    const hospital = await Hospital.findById(id);

    if (!hospital) {
      return res.status(404).json({
        success: false,
        message: "Hospital tenant not found.",
      });
    }

    // Authorization: superadmin or hospital_admin of this specific hospital
    if (
      req.user.role !== "superadmin" &&
      (!req.user.hospitalId || req.user.hospitalId.toString() !== hospital._id.toString())
    ) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You cannot modify another hospital's configuration.",
      });
    }

    const allowedUpdates = [
      "name",
      "address",
      "city",
      "state",
      "postalCode",
      "contactEmail",
      "contactPhone",
      "emergencyContact",
      "timezone",
      "branding",
      "operationalHours",
    ];

    allowedUpdates.forEach((field) => {
      if (req.body[field] !== undefined) {
        hospital[field] = req.body[field];
      }
    });

    await hospital.save();

    recordAuditEvent({
      eventType: "HOSPITAL_UPDATED",
      actor: req.user,
      action: `Updated hospital configuration for ${hospital.name}`,
      outcome: "success",
      targetId: hospital._id,
      req,
    });

    return res.status(200).json({
      success: true,
      message: "Hospital updated successfully.",
      hospital,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update hospital.",
    });
  }
};

/**
 * Update Hospital Tenant Status (Activate / Suspend / Deactivate)
 * PATCH /api/hospitals/:id/status (Platform Owner only)
 */
const updateHospitalStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid hospital ID format.",
      });
    }

    if (!["active", "suspended", "deactivated"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status. Allowed values: active, suspended, deactivated.",
      });
    }

    const hospital = await Hospital.findById(id);
    if (!hospital) {
      return res.status(404).json({
        success: false,
        message: "Hospital tenant not found.",
      });
    }

    if (hospital.status === status) {
      return res.status(400).json({
        success: false,
        message: `Hospital is already in '${status}' status.`,
      });
    }

    const previousStatus = hospital.status;
    hospital.status = status;

    // When reactivating, ensure institutional subscription remains active
    if (status === "active") {
      if (!hospital.subscription) {
        hospital.subscription = {
          plan: "trial",
          status: "trial",
          maxDoctors: 20,
          maxStaff: 50,
        };
      } else if (hospital.subscription.status === "suspended") {
        hospital.subscription.status = "active";
      }
    }

    await hospital.save();

    // If suspended or deactivated, increment tokenVersion of all hospital staff to force session invalidation
    if (status === "suspended" || status === "deactivated") {
      await User.updateMany(
        { hospitalId: hospital._id },
        { $inc: { tokenVersion: 1 } }
      );
    }

    recordAuditEvent({
      eventType: status === "active" ? "HOSPITAL_REACTIVATED" : "HOSPITAL_SUSPENDED",
      actor: req.user,
      action: `Changed status of hospital '${hospital.name}' (${hospital.hospitalCode}) from '${previousStatus}' to '${status}'`,
      outcome: "success",
      targetId: hospital._id,
      reason: reason ? reason.trim() : (status === "active" ? "Platform Owner reactivation" : "Platform Owner deactivation/suspension"),
      req,
    });

    return res.status(200).json({
      success: true,
      message: `Hospital '${hospital.name}' has been successfully ${status === "active" ? "reactivated" : status}.`,
      hospital,
    });
  } catch (error) {
    console.error("Error updating hospital status:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update hospital status.",
    });
  }
};

/**
 * Update Subscription & Quotas (Platform Owner only)
 * PUT /api/hospitals/:id/subscription
 */
const updateSubscription = async (req, res) => {
  try {
    const { id } = req.params;
    const { plan, status, maxStaff, maxDoctors, validUntil } = req.body;

    const hospital = await Hospital.findById(id);
    if (!hospital) {
      return res.status(404).json({
        success: false,
        message: "Hospital tenant not found.",
      });
    }

    if (plan && !["trial", "starter", "professional", "enterprise"].includes(plan)) {
      return res.status(400).json({
        success: false,
        message: "Invalid subscription plan.",
      });
    }

    hospital.subscription = {
      ...hospital.subscription.toObject(),
      ...(plan && { plan }),
      ...(status && { status }),
      ...(maxStaff !== undefined && { maxStaff: Number(maxStaff) }),
      ...(maxDoctors !== undefined && { maxDoctors: Number(maxDoctors) }),
      ...(validUntil && { validUntil: new Date(validUntil) }),
    };

    await hospital.save();

    recordAuditEvent({
      eventType: "HOSPITAL_SUBSCRIPTION_UPDATED",
      actor: req.user,
      action: `Updated subscription for ${hospital.name} to ${hospital.subscription.plan}`,
      outcome: "success",
      targetId: hospital._id,
      req,
    });

    return res.status(200).json({
      success: true,
      message: "Subscription updated successfully.",
      subscription: hospital.subscription,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update hospital subscription.",
    });
  }
};

/**
 * Platform-wide Metrics & Health Summary (Platform Owner only)
 * GET /api/hospitals/metrics/platform
 */
const getPlatformMetrics = async (req, res) => {
  try {
    const [totalHospitals, activeHospitals, suspendedHospitals, trialHospitals] = await Promise.all([
      Hospital.countDocuments(),
      Hospital.countDocuments({ status: "active" }),
      Hospital.countDocuments({ status: "suspended" }),
      Hospital.countDocuments({ "subscription.plan": "trial" }),
    ]);

    const staffByRole = await User.aggregate([
      {
        $group: {
          _id: "$role",
          count: { $sum: 1 },
        },
      },
    ]);

    const planBreakdown = await Hospital.aggregate([
      {
        $group: {
          _id: "$subscription.plan",
          count: { $sum: 1 },
        },
      },
    ]);

    const totalAppointments = await Appointment.countDocuments();

    return res.status(200).json({
      success: true,
      metrics: {
        hospitals: {
          total: totalHospitals,
          active: activeHospitals,
          suspended: suspendedHospitals,
          trial: trialHospitals,
        },
        staffByRole: staffByRole.reduce((acc, curr) => {
          acc[curr._id] = curr.count;
          return acc;
        }, {}),
        planBreakdown: planBreakdown.reduce((acc, curr) => {
          acc[curr._id] = curr.count;
          return acc;
        }, {}),
        appointments: {
          total: totalAppointments,
        },
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve platform metrics.",
    });
  }
};

module.exports = {
  createHospital,
  getHospitals,
  getHospitalById,
  updateHospital,
  updateHospitalStatus,
  updateSubscription,
  getPlatformMetrics,
};
