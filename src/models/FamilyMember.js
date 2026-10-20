const mongoose = require("mongoose");

const familyMemberSchema = new mongoose.Schema(
  {
    primaryAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Primary account ID is required"],
      index: true,
    },
    name: {
      type: String,
      required: [true, "Family member name is required"],
      trim: true,
    },
    relationship: {
      type: String,
      enum: ["Spouse", "Child", "Parent", "Sibling", "Other"],
      required: [true, "Relationship to account holder is required"],
    },
    gender: {
      type: String,
      enum: ["Male", "Female", "Other", ""],
      default: "Other",
    },
    dateOfBirth: {
      type: Date,
      required: [true, "Date of birth is required for clinical records"],
    },
    isMinor: {
      type: Boolean,
      default: false,
      index: true,
    },
    bloodGroup: {
      type: String,
      default: "",
      trim: true,
    },
    allergies: {
      type: [String],
      default: [],
    },
    emergencyContact: {
      type: String,
      default: "",
      trim: true,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
    permissions: {
      canBookAppointments: {
        type: Boolean,
        default: true,
      },
      canViewReports: {
        type: Boolean,
        default: true,
      },
    },
  },
  {
    timestamps: true,
  }
);

// Pre-save hook: auto-compute isMinor based on dateOfBirth (age < 18)
familyMemberSchema.pre("save", function () {
  if (this.dateOfBirth) {
    const today = new Date();
    const birthDate = new Date(this.dateOfBirth);
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    this.isMinor = age < 18;
  }
});

familyMemberSchema.index({ primaryAccountId: 1, createdAt: -1 });

module.exports = mongoose.model("FamilyMember", familyMemberSchema);
