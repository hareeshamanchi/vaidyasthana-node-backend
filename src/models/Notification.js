const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Recipient userId is required"],
      index: true,
    },
    title: {
      type: String,
      required: [true, "Notification title is required"],
      trim: true,
    },
    message: {
      type: String,
      required: [true, "Notification message is required"],
      trim: true,
    },
    type: {
      type: String,
      enum: [
        "appointment_booked",
        "appointment_confirmed",
        "appointment_rejected",
        "appointment_cancelled",
        "appointment_completed",
        "report_uploaded",
        "report_analyzed",
        "security_event",
        "general",
      ],
      default: "general",
      index: true,
    },
    relatedId: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "relatedModel",
      default: null,
    },
    relatedModel: {
      type: String,
      enum: ["Appointment", "Report", "User", null],
      default: null,
    },
    link: {
      type: String,
      default: "",
      trim: true,
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// High-performance index for fetching user unread counts and sorted recent feeds
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", notificationSchema);
