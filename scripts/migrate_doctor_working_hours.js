/**
 * Migration Script: Update Doctors Working Hours to 8:00 AM - 8:00 PM
 * Vaidyasthana Healthcare Platform
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const User = require("../src/models/User");

async function migrateWorkingHours() {
  console.log("Connecting to MongoDB Atlas...");
  await connectDB();

  console.log("Updating all doctor working hours to 08:00 AM - 08:00 PM (30 min slots)...");
  const updateResult = await User.updateMany(
    {
      role: "doctor",
    },
    {
      $set: {
        "workingHours.start": "08:00 AM",
        "workingHours.end": "08:00 PM",
        "workingHours.slotDurationMinutes": 30,
      },
    }
  );

  console.log(`Matched and updated: ${updateResult.modifiedCount} doctor record(s).`);

  const doctors = await User.find({ role: "doctor" }).select("name email workingHours");
  console.log("\nVerified Doctor Working Hours in Atlas:");
  doctors.forEach((doc) => {
    console.log(`  - ${doc.name} (${doc.email}): ${doc.workingHours?.start} - ${doc.workingHours?.end} (${doc.workingHours?.slotDurationMinutes} min slots)`);
  });

  await mongoose.disconnect();
  console.log("✔ Migration completed successfully.");
}

migrateWorkingHours().catch((err) => {
  console.error("Migration error:", err);
  process.exit(1);
});
