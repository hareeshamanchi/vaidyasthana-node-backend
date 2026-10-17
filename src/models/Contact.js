const mongoose = require("mongoose");

const contactSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      trim: true,
      lowercase: true,
    },
    phoneNumber: {
      type: String,
      default: "",
      trim: true,
    },
    query: {
      type: String,
      required: [true, "Message or query is required"],
      trim: true,
    },
    status: {
      type: String,
      enum: ["New", "In Review", "Resolved"],
      default: "New",
    },
    ipAddress: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Contact", contactSchema);
