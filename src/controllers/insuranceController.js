const Insurance = require("../models/Insurance");

// ==========================================
// Add Insurance Policy
// POST /api/insurance
// ==========================================
const createInsurance = async (req, res) => {
  try {
    const {
      providerName,
      policyNumber,
      policyHolderName,
      coverageType,
      coverageAmount,
      validUntil,
      emergencyContact,
    } = req.body;

    if (!providerName || !policyNumber || !validUntil) {
      return res.status(400).json({
        success: false,
        message: "Provider name, policy number, and expiry date are required.",
      });
    }

    const insurance = await Insurance.create({
      userId: req.user.id,
      providerName: providerName.trim(),
      policyNumber: policyNumber.trim(),
      policyHolderName: (policyHolderName || req.user.name || "Policy Holder").trim(),
      coverageType: coverageType || "Comprehensive Health",
      coverageAmount: Number(coverageAmount) || 500000,
      validUntil: new Date(validUntil),
      emergencyContact: emergencyContact || "",
      status: "Active",
    });

    return res.status(201).json({
      success: true,
      message: "Insurance record added successfully.",
      insurance,
    });
  } catch (error) {
    console.error("Create Insurance Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to record insurance policy.",
    });
  }
};

// ==========================================
// Get User Insurance Policies
// GET /api/insurance
// ==========================================
const getInsuranceList = async (req, res) => {
  try {
    const policies = await Insurance.find({ userId: req.user.id }).sort({
      createdAt: -1,
    });

    return res.status(200).json({
      success: true,
      policies,
    });
  } catch (error) {
    console.error("Get Insurance Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch insurance records.",
    });
  }
};

// ==========================================
// Get Single Insurance Policy
// GET /api/insurance/:id
// ==========================================
const getInsuranceById = async (req, res) => {
  try {
    const policy = await Insurance.findById(req.params.id);

    if (!policy) {
      return res.status(404).json({
        success: false,
        message: "Policy not found.",
      });
    }

    if (policy.userId.toString() !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied.",
      });
    }

    return res.status(200).json({
      success: true,
      policy,
    });
  } catch (error) {
    console.error("Get Policy Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching policy.",
    });
  }
};

// ==========================================
// Update Insurance Policy
// PUT /api/insurance/:id
// ==========================================
const updateInsurance = async (req, res) => {
  try {
    const policy = await Insurance.findById(req.params.id);

    if (!policy) {
      return res.status(404).json({
        success: false,
        message: "Policy not found.",
      });
    }

    if (policy.userId.toString() !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied.",
      });
    }

    const {
      providerName,
      policyNumber,
      coverageType,
      coverageAmount,
      validUntil,
      status,
      emergencyContact,
    } = req.body;

    if (providerName) policy.providerName = providerName.trim();
    if (policyNumber) policy.policyNumber = policyNumber.trim();
    if (coverageType) policy.coverageType = coverageType;
    if (coverageAmount) policy.coverageAmount = Number(coverageAmount);
    if (validUntil) policy.validUntil = new Date(validUntil);
    if (status) policy.status = status;
    if (emergencyContact !== undefined) policy.emergencyContact = emergencyContact;

    await policy.save();

    return res.status(200).json({
      success: true,
      message: "Insurance policy updated successfully.",
      policy,
    });
  } catch (error) {
    console.error("Update Insurance Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update insurance policy.",
    });
  }
};

// ==========================================
// Delete Insurance Policy
// DELETE /api/insurance/:id
// ==========================================
const deleteInsurance = async (req, res) => {
  try {
    const policy = await Insurance.findById(req.params.id);

    if (!policy) {
      return res.status(404).json({
        success: false,
        message: "Policy not found.",
      });
    }

    if (policy.userId.toString() !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied.",
      });
    }

    await Insurance.findByIdAndDelete(req.params.id);

    return res.status(200).json({
      success: true,
      message: "Insurance record removed successfully.",
    });
  } catch (error) {
    console.error("Delete Insurance Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to remove insurance policy.",
    });
  }
};

module.exports = {
  createInsurance,
  getInsuranceList,
  getInsuranceById,
  updateInsurance,
  deleteInsurance,
};
