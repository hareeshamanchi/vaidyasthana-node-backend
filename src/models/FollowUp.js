const mongoose = require("mongoose");

const followUpSchema = new mongoose.Schema(
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
    patientEmail: {
      type: String,
      default: "",
      trim: true,
    },
    patientPhone: {
      type: String,
      default: "",
      trim: true,
    },
    consultationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
      index: true,
    },
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
      index: true,
    },
    reason: {
      type: String,
      required: [true, "Follow-up reason is required"],
      trim: true,
    },
    doctorInstructions: {
      type: String,
      required: [true, "Doctor instructions are required"],
      trim: true,
    },
    recommendedDate: {
      type: Date,
      required: [true, "Recommended follow-up date is required"],
      index: true,
    },
    recommendedDateRange: {
      startDate: {
        type: Date,
        default: null,
      },
      endDate: {
        type: Date,
        default: null,
      },
    },
    priority: {
      type: String,
      enum: ["routine", "soon", "urgent"],
      default: "routine",
      index: true,
    },
    recommendedTests: {
      type: [String],
      default: [],
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
    status: {
      type: String,
      enum: [
        "pending_booking",     // Follow-up plan created, patient needs to book appointment
        "appointment_booked",  // Patient scheduled appointment linked to this follow-up
        "completed",           // Follow-up appointment completed
        "missed",              // Scheduled follow-up appointment was missed
        "cancelled",           // Follow-up cancelled by doctor
      ],
      default: "pending_booking",
      index: true,
    },
    cancellationReason: {
      type: String,
      default: "",
      trim: true,
    },
    remindersSent: [
      {
        type: {
          type: String,
          required: true, // e.g. "upcoming_3d", "upcoming_1d", "due_today", "overdue"
        },
        sentAt: {
          type: Date,
          default: Date.now,
        },
        channel: {
          type: String,
          default: "in_app_and_push",
        },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// High-performance search and sorting indexes
followUpSchema.index({ patientId: 1, status: 1, recommendedDate: 1 });
followUpSchema.index({ doctorId: 1, status: 1, recommendedDate: 1 });
followUpSchema.index({ recommendedDate: 1, status: 1 });

module.exports = mongoose.model("FollowUp", followUpSchema);
