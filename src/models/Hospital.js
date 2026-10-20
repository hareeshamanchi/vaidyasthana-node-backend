const mongoose = require("mongoose");

const hospitalSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Hospital name is required"],
      trim: true,
    },
    hospitalCode: {
      type: String,
      required: [true, "Hospital code is required"],
      unique: true,
      uppercase: true,
      trim: true,
      match: [/^[A-Z0-9_-]{3,20}$/, "Hospital code must be 3-20 alphanumeric characters, dashes, or underscores"],
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
    contactEmail: {
      type: String,
      required: [true, "Contact email is required"],
      lowercase: true,
      trim: true,
      match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,})+$/, "Please provide a valid contact email address"],
    },
    contactPhone: {
      type: String,
      default: "",
      trim: true,
    },
    emergencyContact: {
      type: String,
      default: "",
      trim: true,
    },
    timezone: {
      type: String,
      default: "Asia/Kolkata",
      trim: true,
    },
    branding: {
      logoUrl: { type: String, default: "" },
      primaryColor: { type: String, default: "#0d9488" },
      secondaryColor: { type: String, default: "#0284c7" },
    },
    subscription: {
      plan: {
        type: String,
        enum: ["trial", "starter", "professional", "enterprise"],
        default: "trial",
      },
      status: {
        type: String,
        enum: ["active", "trial", "suspended", "deactivated"],
        default: "trial",
      },
      maxStaff: {
        type: Number,
        default: 50,
      },
      maxDoctors: {
        type: Number,
        default: 20,
      },
      validUntil: {
        type: Date,
        default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // Default 30-day trial
      },
    },
    status: {
      type: String,
      enum: ["active", "suspended", "deactivated"],
      default: "active",
      index: true,
    },
    operationalHours: {
      start: { type: String, default: "08:00 AM" },
      end: { type: String, default: "08:00 PM" },
      workingDays: {
        type: [String],
        default: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
      },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  }
);

hospitalSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("Hospital", hospitalSchema);
