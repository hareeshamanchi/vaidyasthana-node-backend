const mongoose = require("mongoose");

const medicationItemSchema = new mongoose.Schema(
  {
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
      trim: true,
      default: "mg",
    },
    route: {
      type: String,
      trim: true,
      default: "Oral",
      enum: [
        "Oral",
        "Topical",
        "Inhalation",
        "Intravenous (IV)",
        "Intramuscular (IM)",
        "Sublingual",
        "Ophthalmic",
        "Otic",
        "Nasal",
        "Other",
      ],
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
    timing: {
      type: String,
      enum: [
        "before_food",
        "after_food",
        "with_food",
        "empty_stomach",
        "no_food_restriction",
      ],
      default: "after_food",
    },
    duration: {
      type: String,
      required: [true, "Duration is required"],
      trim: true,
    },
    durationDays: {
      type: Number,
      default: 5,
    },
    instructions: {
      type: String,
      trim: true,
      default: "",
    },
    reminderTimes: {
      type: [String],
      default: ["08:00"],
    },
  },
  { _id: true }
);

const prescriptionSchema = new mongoose.Schema(
  {
    prescriptionNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Patient reference is required"],
      index: true,
    },
    patientName: {
      type: String,
      required: [true, "Patient name is required"],
      trim: true,
    },
    patientPhone: {
      type: String,
      trim: true,
      default: "",
    },
    patientEmail: {
      type: String,
      trim: true,
      default: "",
    },
    patientAge: {
      type: String,
      trim: true,
      default: "",
    },
    patientGender: {
      type: String,
      trim: true,
      default: "",
    },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Prescribing doctor reference is required"],
      index: true,
    },
    doctorName: {
      type: String,
      required: [true, "Doctor name is required"],
      trim: true,
    },
    doctorSpecialization: {
      type: String,
      trim: true,
      default: "General Medicine",
    },
    doctorQualifications: {
      type: String,
      trim: true,
      default: "MBBS",
    },
    doctorRegistrationNumber: {
      type: String,
      trim: true,
      default: "",
    },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      default: null,
      index: true,
    },
    hospitalName: {
      type: String,
      trim: true,
      default: "",
    },
    hospitalCode: {
      type: String,
      trim: true,
      default: "",
    },
    hospitalAddress: {
      type: String,
      trim: true,
      default: "",
    },
    hospitalPhone: {
      type: String,
      trim: true,
      default: "",
    },
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
      index: true,
    },
    diagnosis: {
      type: String,
      required: [true, "Clinical diagnosis / indication is required"],
      trim: true,
    },
    vitals: {
      bloodPressure: { type: String, trim: true, default: "" },
      pulseRate: { type: String, trim: true, default: "" },
      temperature: { type: String, trim: true, default: "" },
      weight: { type: String, trim: true, default: "" },
      spo2: { type: String, trim: true, default: "" },
    },
    medications: {
      type: [medicationItemSchema],
      validate: {
        validator: function (items) {
          return Array.isArray(items) && items.length > 0;
        },
        message: "At least one medication item is required in a prescription.",
      },
    },
    generalInstructions: {
      type: String,
      trim: true,
      default: "",
    },
    followUpDate: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ["active", "completed", "cancelled"],
      default: "active",
      index: true,
    },
    isSigned: {
      type: Boolean,
      default: true,
    },
    signedAt: {
      type: Date,
      default: Date.now,
    },
    signedByDoctorName: {
      type: String,
      trim: true,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for high performance querying
prescriptionSchema.index({ patientId: 1, createdAt: -1 });
prescriptionSchema.index({ doctorId: 1, createdAt: -1 });
prescriptionSchema.index({ hospitalId: 1, createdAt: -1 });

module.exports = mongoose.model("Prescription", prescriptionSchema);
