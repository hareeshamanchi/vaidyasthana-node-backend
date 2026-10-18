const mongoose = require("mongoose");

const emailIntegrationSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: ["GMAIL_OAUTH2", "RESEND", "SMTP"],
      default: "GMAIL_OAUTH2",
      required: true,
      index: true,
    },
    senderAddress: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    // Encrypted refresh token payload using AES-256-GCM
    encryptedRefreshToken: {
      type: String,
      required: true,
    },
    iv: {
      type: String,
      required: true,
    },
    tag: {
      type: String,
      required: true,
    },
    scope: {
      type: [String],
      default: ["https://www.googleapis.com/auth/gmail.send"],
    },
    status: {
      type: String,
      enum: ["active", "revoked", "expired"],
      default: "active",
      index: true,
    },
    authorizedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    lastAuthorizedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

emailIntegrationSchema.index({ provider: 1, senderAddress: 1 }, { unique: true });

module.exports = mongoose.model("EmailIntegration", emailIntegrationSchema);
