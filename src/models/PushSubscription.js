const mongoose = require("mongoose");

const pushSubscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User ID is required"],
      index: true,
    },
    endpoint: {
      type: String,
      required: [true, "Push subscription endpoint is required"],
      unique: true,
      trim: true,
      index: true,
    },
    keys: {
      p256dh: {
        type: String,
        required: [true, "P256DH key is required"],
        trim: true,
      },
      auth: {
        type: String,
        required: [true, "Auth key is required"],
        trim: true,
      },
    },
    userAgent: {
      type: String,
      default: "",
      trim: true,
    },
    status: {
      type: String,
      enum: ["active", "expired"],
      default: "active",
      index: true,
    },
    lastActive: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for querying active subscriptions by user
pushSubscriptionSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model("PushSubscription", pushSubscriptionSchema);
