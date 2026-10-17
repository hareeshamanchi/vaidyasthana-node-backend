const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,})+$/,
        "Please provide a valid email address",
      ],
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [6, "Password must be at least 6 characters"],
    },
    phoneNumber: {
      type: String,
      default: "",
      trim: true,
    },
    address: {
      type: String,
      default: "",
      trim: true,
    },
    city: {
      type: String,
      default: "",
      trim: true,
    },
    state: {
      type: String,
      default: "",
      trim: true,
    },
    postalCode: {
      type: String,
      default: "",
      trim: true,
    },
    role: {
      type: String,
      enum: ["patient", "doctor", "admin"],
      default: "patient",
      index: true,
    },
    gender: {
      type: String,
      enum: ["Male", "Female", "Other", ""],
      default: "",
    },
    bloodGroup: {
      type: String,
      default: "",
      trim: true,
    },
    dateOfBirth: {
      type: Date,
      default: null,
    },

    // Clinician & Medical Verification Attributes
    specialization: {
      type: String,
      default: "General Medicine",
      trim: true,
      index: true,
    },
    qualifications: {
      type: String,
      default: "MBBS",
      trim: true,
    },
    medicalRegistrationNumber: {
      type: String,
      default: "",
      trim: true,
    },
    experienceYears: {
      type: Number,
      default: 5,
    },
    consultationFee: {
      type: Number,
      default: 500,
    },
    workingHours: {
      start: { type: String, default: "08:00 AM" },
      end: { type: String, default: "08:00 PM" },
      slotDurationMinutes: { type: Number, default: 30 },
    },
    verificationStatus: {
      type: String,
      enum: ["not_submitted", "pending", "verified", "rejected"],
      default: "not_submitted",
      index: true,
    },
    verificationDocuments: [
      {
        documentType: {
          type: String,
          enum: ["id_proof", "medical_registration", "qualification", "other"],
        },
        fileName: { type: String, required: true },
        originalName: { type: String, required: true },
        blobPath: { type: String, required: true },
        fileType: { type: String, required: true },
        fileSize: { type: Number, required: true },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    verificationReview: {
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      reviewedAt: Date,
      decision: String,
      rejectionReason: String,
      notes: String,
    },

    // Security & Password Reset Attributes (Single-Use SHA-256 Hash)
    resetPasswordToken: {
      type: String,
      default: null,
      index: true,
    },
    resetPasswordExpires: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

userSchema.index({ role: 1, verificationStatus: 1 });

module.exports = mongoose.model("User", userSchema);