const mongoose = require("mongoose");

const doctorLeaveSchema = new mongoose.Schema(
  {
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Doctor reference is required"],
      index: true,
    },
    startDate: {
      type: Date,
      required: [true, "Leave start date is required"],
      index: true,
    },
    endDate: {
      type: Date,
      required: [true, "Leave end date is required"],
      index: true,
    },
    isFullDay: {
      type: Boolean,
      default: true,
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
    reason: {
      type: String,
      default: "",
      trim: true,
    },
    status: {
      type: String,
      enum: ["active", "cancelled"],
      default: "active",
      index: true,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    cancellationReason: {
      type: String,
      default: "",
      trim: true,
    },
    affectedAppointmentsCount: {
      type: Number,
      default: 0,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// High performance compound indexes for overlapping leave queries
doctorLeaveSchema.index({ doctorId: 1, startDate: 1, endDate: 1, status: 1 });
doctorLeaveSchema.index({ doctorId: 1, status: 1, startDate: 1 });

module.exports = mongoose.model("DoctorLeave", doctorLeaveSchema);
