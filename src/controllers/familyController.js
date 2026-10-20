const mongoose = require("mongoose");
const FamilyMember = require("../models/FamilyMember");

const isDbConnected = () => mongoose.connection.readyState === 1;

/**
 * ==========================================
 * List Authenticated Patient's Family Members
 * GET /api/auth/family
 * ==========================================
 */
const getFamilyMembers = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const members = await FamilyMember.find({
      primaryAccountId: req.user.id,
    }).sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: members.length,
      familyMembers: members,
    });
  } catch (error) {
    console.error("Get Family Members Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve family members.",
    });
  }
};

/**
 * ==========================================
 * Add Family Member Profile
 * POST /api/auth/family
 * ==========================================
 */
const createFamilyMember = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const {
      name,
      relationship,
      gender = "Other",
      dateOfBirth,
      bloodGroup = "",
      allergies = [],
      emergencyContact = "",
      notes = "",
      permissions,
    } = req.body;

    if (!name || String(name).trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Family member's full name is required.",
      });
    }

    if (!relationship) {
      return res.status(400).json({
        success: false,
        message: "Relationship to account holder is required.",
      });
    }

    if (!["Spouse", "Child", "Parent", "Sibling", "Other"].includes(relationship)) {
      return res.status(400).json({
        success: false,
        message: "Invalid relationship. Allowed: Spouse, Child, Parent, Sibling, Other.",
      });
    }

    if (!dateOfBirth) {
      return res.status(400).json({
        success: false,
        message: "Date of birth is required.",
      });
    }

    const parsedDob = new Date(dateOfBirth);
    if (isNaN(parsedDob.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid date of birth format. Please use YYYY-MM-DD.",
      });
    }

    // Auto-calculate isMinor: age < 18 years
    const today = new Date();
    let age = today.getFullYear() - parsedDob.getFullYear();
    const m = today.getMonth() - parsedDob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < parsedDob.getDate())) {
      age--;
    }
    const isMinor = age < 18;

    const familyMember = await FamilyMember.create({
      primaryAccountId: req.user.id,
      name: name.trim(),
      relationship,
      gender: gender || "Other",
      dateOfBirth: parsedDob,
      isMinor,
      bloodGroup: bloodGroup ? bloodGroup.trim() : "",
      allergies: Array.isArray(allergies) ? allergies : [],
      emergencyContact: emergencyContact ? emergencyContact.trim() : "",
      notes: notes ? notes.trim() : "",
      permissions: {
        canBookAppointments: permissions?.canBookAppointments !== false,
        canViewReports: permissions?.canViewReports !== false,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Family member profile added successfully.",
      familyMember,
    });
  } catch (error) {
    console.error("Create Family Member Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to add family member profile.",
    });
  }
};

/**
 * ==========================================
 * Update Family Member Profile
 * PUT /api/auth/family/:id
 * ==========================================
 */
const updateFamilyMember = async (req, res) => {
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
        message: "Invalid family member ID format.",
      });
    }

    const member = await FamilyMember.findById(id);

    if (!member) {
      return res.status(404).json({
        success: false,
        message: "Family member profile not found.",
      });
    }

    // Ensure only primary account holder or admin can update
    if (
      member.primaryAccountId.toString() !== req.user.id &&
      req.user.role !== "superadmin"
    ) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You are not authorized to update this family member profile.",
      });
    }

    const {
      name,
      relationship,
      gender,
      dateOfBirth,
      bloodGroup,
      allergies,
      emergencyContact,
      notes,
      permissions,
    } = req.body;

    if (name && name.trim()) member.name = name.trim();
    if (relationship && ["Spouse", "Child", "Parent", "Sibling", "Other"].includes(relationship)) {
      member.relationship = relationship;
    }
    if (gender !== undefined) member.gender = gender;
    if (dateOfBirth) {
      const parsedDob = new Date(dateOfBirth);
      if (!isNaN(parsedDob.getTime())) {
        member.dateOfBirth = parsedDob;
        const today = new Date();
        let age = today.getFullYear() - parsedDob.getFullYear();
        const m = today.getMonth() - parsedDob.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < parsedDob.getDate())) {
          age--;
        }
        member.isMinor = age < 18;
      }
    }
    if (bloodGroup !== undefined) member.bloodGroup = bloodGroup.trim();
    if (allergies !== undefined && Array.isArray(allergies)) member.allergies = allergies;
    if (emergencyContact !== undefined) member.emergencyContact = emergencyContact.trim();
    if (notes !== undefined) member.notes = notes.trim();
    if (permissions) {
      if (permissions.canBookAppointments !== undefined) {
        member.permissions.canBookAppointments = permissions.canBookAppointments;
      }
      if (permissions.canViewReports !== undefined) {
        member.permissions.canViewReports = permissions.canViewReports;
      }
    }

    await member.save();

    return res.status(200).json({
      success: true,
      message: "Family member profile updated successfully.",
      familyMember: member,
    });
  } catch (error) {
    console.error("Update Family Member Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update family member profile.",
    });
  }
};

/**
 * ==========================================
 * Delete Family Member Profile
 * DELETE /api/auth/family/:id
 * ==========================================
 */
const deleteFamilyMember = async (req, res) => {
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
        message: "Invalid family member ID format.",
      });
    }

    const member = await FamilyMember.findById(id);

    if (!member) {
      return res.status(404).json({
        success: false,
        message: "Family member profile not found.",
      });
    }

    if (
      member.primaryAccountId.toString() !== req.user.id &&
      req.user.role !== "superadmin"
    ) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You are not authorized to delete this family member profile.",
      });
    }

    await FamilyMember.deleteOne({ _id: member._id });

    return res.status(200).json({
      success: true,
      message: "Family member profile removed successfully.",
    });
  } catch (error) {
    console.error("Delete Family Member Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to remove family member profile.",
    });
  }
};

module.exports = {
  getFamilyMembers,
  createFamilyMember,
  updateFamilyMember,
  deleteFamilyMember,
};
