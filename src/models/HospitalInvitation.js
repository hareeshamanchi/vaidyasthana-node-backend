const mongoose = require("mongoose");
const crypto = require("crypto");

const hospitalInvitationSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: [true, "Hospital ID is required"],
      index: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      lowercase: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      default: "",
      trim: true,
    },
    role: {
      type: String,
      enum: [
        "hospital_admin",
        "doctor",
        "nurse",
        "receptionist",
        "lab_technician",
        "pharmacist",
        "billing_staff",
      ],
      required: [true, "Role is required"],
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "revoked", "expired"],
      default: "pending",
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Helper to generate random hex token and store SHA-256 hash
 */
hospitalInvitationSchema.statics.createInvitation = async function ({
  hospitalId,
  email,
  name,
  role,
  invitedBy,
  expiryDays = 7,
}) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

  // Invalidate any existing pending invitations for this email + hospital
  await this.updateMany(
    { hospitalId, email: email.toLowerCase(), status: "pending" },
    { status: "revoked" }
  );

  const invitation = await this.create({
    hospitalId,
    email: email.toLowerCase(),
    name: name || "",
    role,
    tokenHash,
    invitedBy,
    expiresAt,
  });

  return { invitation, rawToken };
};

module.exports = mongoose.model("HospitalInvitation", hospitalInvitationSchema);
