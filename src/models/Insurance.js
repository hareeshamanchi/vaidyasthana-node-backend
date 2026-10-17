const mongoose = require("mongoose");

const insuranceSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    providerName: {
      type: String,
      required: [true, "Insurance provider name is required"],
      trim: true,
    },
    policyNumber: {
      type: String,
      required: [true, "Policy number is required"],
      trim: true,
    },
    policyHolderName: {
      type: String,
      required: true,
      trim: true,
    },
    coverageType: {
      type: String,
      default: "Comprehensive Health",
      trim: true,
    },
    coverageAmount: {
      type: Number,
      default: 500000,
    },
    validFrom: {
      type: Date,
      default: Date.now,
    },
    validUntil: {
      type: Date,
      required: [true, "Policy expiration date is required"],
    },
    status: {
      type: String,
      enum: ["Active", "Pending Verification", "Expired", "Suspended"],
      default: "Active",
    },
    emergencyContact: {
      type: String,
      default: "",
    },
    claimSupportNumber: {
      type: String,
      default: "1800-102-4488",
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Insurance", insuranceSchema);
