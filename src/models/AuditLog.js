const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    eventType: {
      type: String,
      required: [true, "Event type is required"],
      trim: true,
      index: true,
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    actorRole: {
      type: String,
      default: "anonymous",
      trim: true,
      index: true,
    },
    actorEmail: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },
    targetId: {
      type: String,
      default: null,
      index: true,
    },
    targetModel: {
      type: String,
      default: null,
      trim: true,
    },
    action: {
      type: String,
      required: [true, "Action description is required"],
      trim: true,
    },
    outcome: {
      type: String,
      enum: ["success", "failure", "warning"],
      default: "success",
      index: true,
    },
    reason: {
      type: String,
      default: "",
      trim: true,
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    ipAddress: {
      type: String,
      default: "",
      trim: true,
    },
    userAgent: {
      type: String,
      default: "",
      trim: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// High-performance compound indexes for audit filtering and timeline queries
auditLogSchema.index({ eventType: 1, timestamp: -1 });
auditLogSchema.index({ actorId: 1, timestamp: -1 });
auditLogSchema.index({ outcome: 1, timestamp: -1 });
auditLogSchema.index({ targetId: 1, timestamp: -1 });

// Immutable Audit Log Protection: prevent editing or deleting historical audit entries
auditLogSchema.pre(["updateOne", "updateMany", "findOneAndUpdate", "replaceOne"], function () {
  throw new Error("Audit logs are immutable append-only records and cannot be modified.");
});

auditLogSchema.pre(["deleteOne", "deleteMany", "findOneAndDelete"], function () {
  throw new Error("Audit logs are immutable append-only records and cannot be deleted.");
});

module.exports = mongoose.model("AuditLog", auditLogSchema);
