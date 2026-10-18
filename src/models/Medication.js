const mongoose = require("mongoose");

const medicationSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Patient ID is required"],
      index: true,
    },
    name: {
      type: String,
      required: [true, "Medication name is required"],
      trim: true,
    },
    dosage: {
      type: String,
      required: [true, "Dosage is required"],
      trim: true,
    },
    dosageUnit: {
      type: String,
      required: [true, "Dosage unit is required"],
      trim: true,
      default: "mg",
    },
    frequency: {
      type: String,
      required: [true, "Frequency is required"],
      enum: [
        "once_daily",
        "twice_daily",
        "thrice_daily",
        "four_times_daily",
        "as_needed",
        "custom",
      ],
      default: "once_daily",
    },
    reminderTimes: {
      type: [String],
      validate: {
        validator: function (times) {
          if (!Array.isArray(times)) return false;
          // Times should match HH:mm 24h format
          const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
          return times.every((t) => typeof t === "string" && timeRegex.test(t));
        },
        message: "All reminder times must be in HH:mm 24-hour format (e.g. '08:00')",
      },
      default: ["08:00"],
    },
    foodTiming: {
      type: String,
      enum: [
        "before_food",
        "after_food",
        "with_food",
        "empty_stomach",
        "no_food_restriction",
      ],
      default: "no_food_restriction",
    },
    instructions: {
      type: String,
      trim: true,
      default: "",
    },
    startDate: {
      type: Date,
      required: [true, "Start date is required"],
      default: Date.now,
      index: true,
    },
    endDate: {
      type: Date,
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "paused", "ended"],
      default: "active",
      index: true,
    },
    source: {
      type: String,
      enum: ["patient_entered", "doctor_prescribed"],
      default: "patient_entered",
      index: true,
    },
    prescribedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    prescriberName: {
      type: String,
      trim: true,
      default: "",
    },
    prescriptionRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Report",
      default: null,
    },
    timezone: {
      type: String,
      default: "Asia/Kolkata",
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for querying active medications for a patient
medicationSchema.index({ patientId: 1, status: 1 });
medicationSchema.index({ status: 1, startDate: 1, endDate: 1 });

module.exports = mongoose.model("Medication", medicationSchema);
