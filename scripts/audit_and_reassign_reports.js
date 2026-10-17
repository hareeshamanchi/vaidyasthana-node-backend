/**
 * Vaidyasthana Safe Report Audit & Reassignment Tool
 *
 * This utility audits existing reports in the database to detect reports
 * where the owner (userId) is an account with role "doctor", and allows
 * safe, verified reassignment to the intended patient.
 *
 * Usage:
 *   node scripts/audit_and_reassign_reports.js --audit
 *   node scripts/audit_and_reassign_reports.js --reassign --reportId <id> --targetPatientId <patientId>
 */

require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../src/models/User");
const Report = require("../src/models/Report");

const connectDB = async () => {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/vaidyasthana";
  await mongoose.connect(uri);
  console.log("Connected to MongoDB for audit.");
};

const runAudit = async () => {
  try {
    await connectDB();

    // 1. Find all doctor accounts
    const doctors = await User.find({ role: "doctor" });
    const doctorIds = doctors.map((d) => d._id);
    const doctorMap = new Map(doctors.map((d) => [d._id.toString(), d]));

    console.log(`\n======================================================`);
    console.log(`VAIDYASTHANA REPORT AUDIT REPORT`);
    console.log(`Found ${doctors.length} doctor account(s) registered in system.`);
    console.log(`======================================================\n`);

    // 2. Find reports where userId matches a doctor's ID
    const reportsOwnedByDoctors = await Report.find({
      userId: { $in: doctorIds },
    });

    console.log(`Found ${reportsOwnedByDoctors.length} report(s) where userId matches a Doctor ID.`);

    if (reportsOwnedByDoctors.length === 0) {
      console.log("✔ No misattributed reports found! All reports have non-doctor owners or are already clean.");
    } else {
      console.log("\n⚠️ ATTENTION: The following reports are stored under a Doctor ID instead of a Patient ID:\n");
      reportsOwnedByDoctors.forEach((r, idx) => {
        const doc = doctorMap.get(r.userId.toString());
        console.log(`[${idx + 1}] Report ID: ${r._id}`);
        console.log(`    File: ${r.originalName || r.fileName}`);
        console.log(`    Current Owner (Doctor): ${doc?.name || "Unknown"} (${r.userId})`);
        console.log(`    Category: ${r.category}`);
        console.log(`    Uploaded At: ${r.createdAt}`);
        console.log(`    Notes: ${r.notes || "None"}`);
        console.log(`    UploadedBy: ${r.uploadedBy || "Not set"}`);
        console.log(`    Suggested Action: Use --reassign --reportId ${r._id} --targetPatientId <patientId>\n`);
      });
    }

    // 3. Find reports uploaded by doctors for patients
    const doctorUploadedReports = await Report.find({
      uploadedByRole: "doctor",
      userId: { $nin: doctorIds },
    });

    console.log(`✔ Verified ${doctorUploadedReports.length} report(s) correctly uploaded by doctors for patient accounts.`);
    console.log(`======================================================\n`);
  } catch (err) {
    console.error("Audit error:", err);
  } finally {
    await mongoose.disconnect();
  }
};

const runReassign = async (reportId, targetPatientId) => {
  if (!reportId || !targetPatientId) {
    console.error("Error: --reportId and --targetPatientId are required.");
    process.exit(1);
  }

  try {
    await connectDB();

    const patient = await User.findById(targetPatientId);
    if (!patient) {
      console.error(`Error: Target patient '${targetPatientId}' not found.`);
      process.exit(1);
    }

    const report = await Report.findById(reportId);
    if (!report) {
      console.error(`Error: Report '${reportId}' not found.`);
      process.exit(1);
    }

    console.log(`Current Report Owner: ${report.userId}`);
    console.log(`Reassigning to Patient: ${patient.name} (${patient._id})...`);

    const prevOwner = report.userId;
    report.userId = patient._id;
    report.uploadedBy = prevOwner; // Record previous owner (doctor) as uploader
    report.uploadedByRole = "doctor";
    await report.save();

    console.log(`✔ SUCCESS: Report ${reportId} successfully reassigned to Patient ${patient._id}.`);
  } catch (err) {
    console.error("Reassignment error:", err);
  } finally {
    await mongoose.disconnect();
  }
};

const args = process.argv.slice(2);
if (args.includes("--reassign")) {
  const repIdx = args.indexOf("--reportId");
  const patIdx = args.indexOf("--targetPatientId");
  const reportId = repIdx !== -1 ? args[repIdx + 1] : null;
  const targetPatientId = patIdx !== -1 ? args[patIdx + 1] : null;
  runReassign(reportId, targetPatientId);
} else {
  runAudit();
}
