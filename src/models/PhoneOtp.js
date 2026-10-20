const mongoose = require("mongoose");

const phoneOtpSchema = new mongoose.Schema(
  {
    phoneNumber: {
      type: String,
      required: [true, "Phone number is required"],
      trim: true,
      index: true,
    },
    otpHash: {
      type: String,
      required: [true, "Hashed OTP is required"],
    },
    attempts: {
      type: Number,
      default: 0,
    },
    purpose: {
      type: String,
      enum: ["login", "registration", "verification"],
      default: "login",
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 }, // Document automatically deleted when expiresAt is reached
    },
  },
  {
    timestamps: true,
  }
);

phoneOtpSchema.index({ phoneNumber: 1, createdAt: -1 });

module.exports = mongoose.model("PhoneOtp", phoneOtpSchema);
