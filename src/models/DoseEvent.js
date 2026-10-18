const mongoose = require("mongoose");

const doseEventSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Patient ID is required"],
      index: true,
    },
    medicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Medication",
      required: [true, "Medication ID is required"],
      index: true,
    },
    medicationName: {
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
      default: "",
      trim: true,
    },
    source: {
      type: String,
      enum: ["patient_entered", "doctor_prescribed"],
      default: "patient_entered",
    },
    scheduledDate: {
      type: String, // Format: "YYYY-MM-DD"
      required: [true, "Scheduled date is required"],
      index: true,
    },
    reminderTime: {
      type: String, // Format: "HH:mm" (24h)
      required: [true, "Reminder time is required"],
    },
    scheduledTime: {
      type: Date,
      required: [true, "Exact scheduled timestamp is required"],
      index: true,
    },
    status: {
      type: String,
      enum: ["Scheduled", "Taken", "Skipped", "Missed"],
      default: "Scheduled",
      index: true,
    },
    actionTime: {
      type: Date,
      default: null,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
    snoozeUntil: {
      type: Date,
      default: null,
    },
    reminderSent: {
      type: Boolean,
      default: false,
      index: true,
    },
    reminderSentAt: {
      type: Date,
      default: null,
    },
    lastAlertAt: {
      type: Date,
      default: null,
      index: true,
    },
    alertCount: {
      type: Number,
      default: 0,
    },
    maxAlerts: {
      type: Number,
      default: 20,
    },
    missedEvaluated: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Atomic unique index: strictly prevents duplicate dose entries for the same medication at the same time slot on any given date
doseEventSchema.index(
  { medicationId: 1, scheduledDate: 1, reminderTime: 1 },
  { unique: true }
);

// High performance index for patient daily dose schedule queries
doseEventSchema.index({ patientId: 1, scheduledDate: 1 });

// High performance index for reminder worker & adherence statistics
doseEventSchema.index({ status: 1, scheduledTime: 1 });
doseEventSchema.index({ status: 1, lastAlertAt: 1 });
doseEventSchema.index({ patientId: 1, scheduledTime: 1, status: 1 });

module.exports = mongoose.model("DoseEvent", doseEventSchema);
