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
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      default: null,
      index: true,
    },
    role: {
      type: String,
      enum: [
        "patient",
        "doctor",
        "nurse",
        "receptionist",
        "lab_technician",
        "pharmacist",
        "billing_staff",
        "hospital_admin",
        "admin",
        "superadmin",
      ],
      default: "patient",
      index: true,
    },
    department: {
      type: String,
      default: "",
      trim: true,
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    status: {
      type: String,
      enum: ["active", "suspended", "inactive"],
      default: "active",
      index: true,
    },
    suspensionHistory: [
      {
        action: {
          type: String,
          enum: ["suspended", "reactivated"],
          required: true,
        },
        reason: {
          type: String,
          required: true,
          trim: true,
        },
        performedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        performedByEmail: {
          type: String,
          default: "",
        },
        timestamp: {
          type: Date,
          default: Date.now,
        },
      },
    ],
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
    clinicName: {
      type: String,
      default: "",
      trim: true,
    },
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
    profilePhoto: {
      type: String,
      default: "",
      trim: true,
    },
    languagesSpoken: {
      type: [String],
      default: ["English"],
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
      workingDays: {
        type: [String],
        enum: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
        default: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
      },
      breaks: [
        {
          title: { type: String, default: "Lunch Break", trim: true },
          startTime: { type: String, required: true },
          endTime: { type: String, required: true },
        },
      ],
      weeklySchedule: [
        {
          day: { type: String, required: true },
          isWorkingDay: { type: Boolean, default: true },
          startTime: { type: String, default: "08:00 AM" },
          endTime: { type: String, default: "08:00 PM" },
          breaks: [
            {
              title: { type: String, default: "Break" },
              startTime: { type: String, required: true },
              endTime: { type: String, required: true },
            },
          ],
        },
      ],
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

    // Session Management & Token Revocation
    tokenVersion: {
      type: Number,
      default: 0,
      index: true,
    },

    // Two-Factor Authentication (2FA)
    twoFactorEnabled: {
      type: Boolean,
      default: false,
      index: true,
    },
    twoFactorSecret: {
      type: String,
      default: null,
      select: false,
    },
    twoFactorRecoveryCodes: {
      type: [
        {
          codeHash: { type: String, required: true },
          used: { type: Boolean, default: false },
        },
      ],
      default: [],
      select: false,
    },
  },
  {
    timestamps: true,
  }
);

userSchema.index({ role: 1, verificationStatus: 1 });
userSchema.index({ role: 1, status: 1 });
userSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("User", userSchema);