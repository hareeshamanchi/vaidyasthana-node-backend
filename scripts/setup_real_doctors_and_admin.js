require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../src/models/User");
const Appointment = require("../src/models/Appointment");

const run = async () => {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.error("MONGODB_URI not found in environment.");
      process.exit(1);
    }

    console.log("Connecting to MongoDB Atlas...");
    await mongoose.connect(uri);
    console.log("Connected to MongoDB Atlas.");

    // 1. Create or Verify System Admin
    let admin = await User.findOne({ email: "admin@vaidyasthana.com" });
    if (!admin) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash("Admin@12345", salt);
      admin = await User.create({
        name: "Chief Medical Administrator",
        email: "admin@vaidyasthana.com",
        password: hashedPassword,
        phoneNumber: "+91 99999 88888",
        address: "Vaidyasthana Healthcare Governance Hub, Level 4, Bengaluru, Karnataka",
        city: "Bengaluru",
        state: "Karnataka",
        postalCode: "560001",
        role: "admin",
        verificationStatus: "verified",
      });
      console.log("✔ Created system administrator: admin@vaidyasthana.com");
    } else {
      console.log("✔ Admin account exists: admin@vaidyasthana.com");
    }

    // 2. Setup Real Verified Doctors in Atlas
    const doc1 = await User.findOne({ email: "hareeshamanchi@gmail.com" });
    if (doc1) {
      doc1.specialization = "Cardiology";
      doc1.qualifications = "MBBS, MD (Cardiology), FACC";
      doc1.medicalRegistrationNumber = "MCI-CARD-48291";
      doc1.experienceYears = 14;
      doc1.consultationFee = 750;
      doc1.phoneNumber = doc1.phoneNumber || "+91 98765 43210";
      doc1.address = doc1.address || "Apollo Health City, Jubilee Hills, Hyderabad, Telangana";
      doc1.city = "Hyderabad";
      doc1.state = "Telangana";
      doc1.postalCode = "500033";
      doc1.verificationStatus = "verified";
      await doc1.save();
      console.log(`✔ Verified and configured Doctor: ${doc1.name} (${doc1._id}) - Cardiology`);
    }

    const doc2 = await User.findOne({ email: "rajamouli@gmail.com" });
    if (doc2) {
      doc2.specialization = "General Medicine";
      doc2.qualifications = "MBBS, MD (Internal Medicine)";
      doc2.medicalRegistrationNumber = "MCI-GEN-31908";
      doc2.experienceYears = 16;
      doc2.consultationFee = 500;
      doc2.phoneNumber = doc2.phoneNumber || "+91 91234 56789";
      doc2.address = doc2.address || "Care Multispecialty Hospital, Banjara Hills, Hyderabad, Telangana";
      doc2.city = "Hyderabad";
      doc2.state = "Telangana";
      doc2.postalCode = "500034";
      doc2.verificationStatus = "verified";
      await doc2.save();
      console.log(`✔ Verified and configured Doctor: ${doc2.name} (${doc2._id}) - General Medicine`);
    }

    // Also add another verified doctor in Orthopedics for variety
    let doc3 = await User.findOne({ email: "vikram.seth@vaidyasthana.com" });
    if (!doc3) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash("Doctor@12345", salt);
      doc3 = await User.create({
        name: "Dr. Vikram Seth",
        email: "vikram.seth@vaidyasthana.com",
        password: hashedPassword,
        phoneNumber: "+91 97890 12345",
        address: "Manipal Hospital, Whitefield, Bengaluru, Karnataka",
        city: "Bengaluru",
        state: "Karnataka",
        postalCode: "560066",
        role: "doctor",
        specialization: "Orthopedics",
        qualifications: "MBBS, MS (Orthopedics), M.Ch",
        medicalRegistrationNumber: "KMC-ORTHO-7721",
        experienceYears: 12,
        consultationFee: 650,
        verificationStatus: "verified",
      });
      console.log(`✔ Created and verified Doctor: Dr. Vikram Seth (${doc3._id}) - Orthopedics`);
    }

    // 3. Fix any legacy appointments missing doctorId
    const targetDocId = doc3?._id || doc1?._id;
    if (targetDocId) {
      const unlinkedAppts = await Appointment.find({ doctorId: null });
      if (unlinkedAppts.length > 0) {
        for (const app of unlinkedAppts) {
          app.doctorId = targetDocId;
          await app.save();
        }
        console.log(`✔ Linked ${unlinkedAppts.length} legacy appointments to verified doctor ${targetDocId}`);
      }
    }

    // 4. Ensure Mongoose indexes in Atlas
    await User.syncIndexes();
    await Appointment.syncIndexes();
    console.log("✔ Mongoose indexes synced in MongoDB Atlas.");

    console.log("\nSetup complete! All doctors and administrators are ready.");
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("Migration error:", err);
    process.exit(1);
  }
};

run();
