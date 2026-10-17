const mongoose = require("mongoose");

const appointmentSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Patient reference is required"],
      index: true,
    },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Doctor reference is required"],
      index: true,
    },
    doctorName: {
      type: String,
      required: [true, "Doctor name is required"],
      trim: true,
    },
    patientName: {
      type: String,
      required: [true, "Patient name is required"],
      trim: true,
    },
    patientPhone: {
      type: String,
      default: "",
      trim: true,
    },
    patientEmail: {
      type: String,
      default: "",
      trim: true,
    },
    department: {
      type: String,
      required: true,
      trim: true,
      default: "General Medicine",
    },
    appointmentDate: {
      type: Date,
      required: [true, "Appointment date is required"],
      index: true,
    },
    timeSlot: {
      type: String,
      required: [true, "Time slot is required"],
      trim: true,
    },
    startTime: {
      type: String,
      default: "",
      trim: true,
    },
    endTime: {
      type: String,
      default: "",
      trim: true,
    },
    status: {
      type: String,
      enum: ["Scheduled", "Confirmed", "In Progress", "Completed", "Cancelled", "Rejected", "Expired"],
      default: "Scheduled",
      index: true,
    },
    type: {
      type: String,
      enum: ["Consultation", "Follow-up", "Routine Checkup", "Emergency"],
      default: "Consultation",
    },
    consultationType: {
      type: String,
      enum: ["In-Person", "Video / Online", "Phone"],
      default: "In-Person",
    },
    reason: {
      type: String,
      default: "",
      trim: true,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
    cancellationReason: {
      type: String,
      default: "",
      trim: true,
    },
    rejectionReason: {
      type: String,
      default: "",
      trim: true,
    },
    meetingRoomId: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Search & lookup indexes
appointmentSchema.index({ patientId: 1, appointmentDate: 1 });
appointmentSchema.index({ doctorId: 1, appointmentDate: 1 });

// Atomic double-booking prevention constraint:
// Ensures no two active appointments can have the exact same doctor, date, and timeslot
appointmentSchema.index(
  { doctorId: 1, appointmentDate: 1, timeSlot: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["Scheduled", "Confirmed", "In Progress", "Completed"] },
    },
  }
);

module.exports = mongoose.model("Appointment", appointmentSchema);
