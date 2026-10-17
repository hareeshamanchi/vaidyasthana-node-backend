const assert = require("node:assert");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
require("dotenv").config({ path: __dirname + "/../.env" });

const app = require("../src/app");
const User = require("../src/models/User");
const Appointment = require("../src/models/Appointment");
const connectDB = require("../src/config/db");

let server;
let baseUrl;

const request = async (method, path, body = null, token = null) => {
  const url = `${baseUrl}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: res.status, data };
};

const createToken = (user) => {
  const secret = process.env.JWT_SECRET || "vaidyasthana_development_jwt_secret_key_32bytes";
  return jwt.sign(
    {
      id: user._id.toString(),
      role: user.role,
      name: user.name,
      email: user.email,
    },
    secret,
    { expiresIn: "7d" }
  );
};

const getFutureDateString = (daysAhead = 7) => {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

async function runPatientDoctorMappingVerification() {
  console.log("==========================================================================");
  console.log("  Vaidyasthana: Patient-Doctor Appointment Mapping E2E Verification      ");
  console.log("==========================================================================\n");

  // Step 0: Database Connection
  console.log("Connecting to MongoDB Atlas...");
  const conn = await connectDB();
  assert(conn, "Database connection must succeed");
  console.log(`✅ Connected to host: ${conn.connection.host}`);
  console.log(`✅ Verified database: ${conn.connection.name}`);
  assert.strictEqual(conn.connection.name, "vaidyasthana", "Database must be vaidyasthana");

  // Spin up test server
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`✅ Test HTTP server active on ${baseUrl}\n`);
      resolve();
    });
  });

  let createdTestAppointmentId = null;
  let testPatient2 = null;
  let testDoctor2 = null;
  let testAppointment2Id = null;

  try {
    // =========================================================================
    // STEP 1 & 2: Verify Patient 'sai' Identity and MongoDB _id
    // =========================================================================
    console.log("--- STEP 1 & 2: Verify Patient 'sai' Identity & Authentication ---");
    const saiUser = await User.findOne({ name: "sai", role: "patient" });
    assert(saiUser, "Patient 'sai' must exist in MongoDB Atlas users collection");
    assert.strictEqual(saiUser.role, "patient", "Role must be 'patient'");
    assert.strictEqual(saiUser.email, "sai@gmail.com", "Email must be sai@gmail.com");
    console.log(`✅ Patient 'sai' found in Atlas: ID = ${saiUser._id.toString()}`);
    console.log(`   Contact: ${saiUser.phoneNumber} | Address: ${saiUser.address}`);

    const saiToken = createToken(saiUser);
    const saiProfileRes = await request("GET", "/api/auth/profile", null, saiToken);
    assert.strictEqual(saiProfileRes.status, 200, "GET /api/auth/profile must return 200");
    assert.strictEqual(saiProfileRes.data.id.toString(), saiUser._id.toString());
    assert.strictEqual(saiProfileRes.data.role, "patient");
    console.log("✅ Authenticated patient profile verified via JWT session.");

    // =========================================================================
    // STEP 3: Verify Doctor 'Hema' Identity and Doctor Directory
    // =========================================================================
    console.log("\n--- STEP 3: Verify Doctor 'Hema' Identity & Directory ---");
    const hemaUser = await User.findOne({ name: "Hema", role: "doctor" });
    assert(hemaUser, "Doctor 'Hema' must exist in MongoDB Atlas users collection");
    assert.strictEqual(hemaUser.role, "doctor", "Role must be 'doctor'");
    assert.strictEqual(hemaUser.verificationStatus, "verified", "Doctor must be verified");
    console.log(`✅ Doctor 'Hema' found in Atlas: ID = ${hemaUser._id.toString()}`);
    console.log(`   Specialization: ${hemaUser.specialization} | Verification: ${hemaUser.verificationStatus}`);

    const hemaToken = createToken(hemaUser);
    const hemaProfileRes = await request("GET", "/api/auth/profile", null, hemaToken);
    assert.strictEqual(hemaProfileRes.status, 200, "GET /api/auth/profile must return 200");
    assert.strictEqual(hemaProfileRes.data.id.toString(), hemaUser._id.toString());
    assert.strictEqual(hemaProfileRes.data.role, "doctor");

    // Verify Hema appears in doctors directory
    const dirRes = await request("GET", "/api/appointments/doctors");
    assert.strictEqual(dirRes.status, 200);
    const foundDocInDir = dirRes.data.doctors.find((d) => d._id === hemaUser._id.toString());
    assert(foundDocInDir, "Doctor Hema must appear in verified directory");
    console.log("✅ Doctor 'Hema' verified in public clinical directory.");

    // =========================================================================
    // STEP 4: Inspect and Verify Existing Appointment (ID: 6ad1b99fb2d9e2cca3547d3d)
    // =========================================================================
    console.log("\n--- STEP 4: Verify Existing Appointment Document in Atlas ---");
    const existingAppt = await Appointment.findById("6ad1b99fb2d9e2cca3547d3d");
    assert(existingAppt, "Appointment 6ad1b99fb2d9e2cca3547d3d must exist in Atlas");
    assert.strictEqual(
      existingAppt.patientId.toString(),
      saiUser._id.toString(),
      "Appointment patientId must reference sai's MongoDB _id"
    );
    assert.strictEqual(
      existingAppt.doctorId.toString(),
      hemaUser._id.toString(),
      "Appointment doctorId must reference Hema's MongoDB _id"
    );
    assert.strictEqual(existingAppt.status, "Completed", "Existing appointment status must be Completed");
    console.log(`✅ Existing Appointment: ID = ${existingAppt._id.toString()}`);
    console.log(`   Patient ID: ${existingAppt.patientId.toString()} (${existingAppt.patientName})`);
    console.log(`   Doctor ID: ${existingAppt.doctorId.toString()} (${existingAppt.doctorName})`);
    console.log(`   Date & Time: ${existingAppt.appointmentDate.toISOString().slice(0, 10)} at ${existingAppt.timeSlot}`);
    console.log(`   Status: ${existingAppt.status} | Reason/Notes: ${existingAppt.notes}`);

    // Verify patient perspective:
    const saiApptsRes = await request("GET", "/api/appointments", null, saiToken);
    assert.strictEqual(saiApptsRes.status, 200);
    const saiMatch = saiApptsRes.data.appointments.find((a) => a._id === "6ad1b99fb2d9e2cca3547d3d");
    assert(saiMatch, "Patient 'sai' must see appointment 6ad1b99fb2d9e2cca3547d3d");
    assert.strictEqual(saiMatch.doctorName, "Dr. Hema");
    assert.strictEqual(saiMatch.department, "Orthopedics");
    assert.strictEqual(saiMatch.status, "Completed");
    console.log("✅ Patient 'sai' queries appointments: sees Dr. Hema, Orthopedics, Completed.");

    // Verify doctor perspective:
    const hemaApptsRes = await request("GET", "/api/appointments", null, hemaToken);
    assert.strictEqual(hemaApptsRes.status, 200);
    const hemaMatch = hemaApptsRes.data.appointments.find((a) => a._id === "6ad1b99fb2d9e2cca3547d3d");
    assert(hemaMatch, "Doctor 'Hema' must see appointment 6ad1b99fb2d9e2cca3547d3d");
    assert.strictEqual(hemaMatch.patientName, "sai");
    assert.strictEqual(hemaMatch.patientPhone, "9889898989");
    assert.strictEqual(hemaMatch.patientEmail, "sai@gmail.com");
    assert.strictEqual(hemaMatch.status, "Completed");
    assert.strictEqual(hemaApptsRes.data.count, hemaApptsRes.data.appointments.length);
    console.log("✅ Doctor 'Hema' queries appointments: sees patient sai, 9889898989, Completed.");

    // =========================================================================
    // STEP 5: Patient 'sai' Books a New Appointment with Doctor 'Hema'
    // =========================================================================
    console.log("\n--- STEP 5: Book New Appointment (sai -> Hema) ---");
    const futureDate = getFutureDateString(10);
    const futureSlot = "02:30 PM";
    const clinicalReason = "Follow-up consultation for lower lumbar spine mobility and rehabilitation";

    const bookRes = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: hemaUser._id.toString(),
        doctorName: "Dr. Hema",
        department: "Orthopedics",
        appointmentDate: futureDate,
        timeSlot: futureSlot,
        consultationType: "In-Person",
        type: "Follow-up",
        reason: clinicalReason,
        notes: clinicalReason,
      },
      saiToken
    );

    assert.strictEqual(bookRes.status, 201, `Booking must succeed: ${JSON.stringify(bookRes.data)}`);
    assert.strictEqual(bookRes.data.success, true);
    assert(bookRes.data.appointment, "Appointment object must be returned");
    createdTestAppointmentId = bookRes.data.appointment._id;

    // Verify in MongoDB Atlas
    const savedInAtlas = await Appointment.findById(createdTestAppointmentId);
    assert(savedInAtlas, "Saved appointment must exist in Atlas");
    assert.strictEqual(savedInAtlas.patientId.toString(), saiUser._id.toString(), "patientId must be sai's ID");
    assert.strictEqual(savedInAtlas.doctorId.toString(), hemaUser._id.toString(), "doctorId must be Hema's ID");
    assert.strictEqual(savedInAtlas.status, "Scheduled", "Newly booked appointment MUST be 'Scheduled', NOT 'Completed'!");
    assert.strictEqual(savedInAtlas.timeSlot, futureSlot);
    assert.strictEqual(savedInAtlas.reason, clinicalReason);
    assert.strictEqual(savedInAtlas.notes, clinicalReason);
    console.log(`✅ New Appointment Created: ID = ${createdTestAppointmentId}`);
    console.log(`   Status = ${savedInAtlas.status} (Verified NOT automatically completed)`);
    console.log(`   Patient ID = ${savedInAtlas.patientId.toString()} | Doctor ID = ${savedInAtlas.doctorId.toString()}`);

    // =========================================================================
    // STEP 6 & 7: Verify Synchronized Views on Patient and Doctor Dashboards
    // =========================================================================
    console.log("\n--- STEP 6 & 7: Verify Patient & Doctor Screen Synchronization ---");
    const saiApptsRes2 = await request("GET", "/api/appointments", null, saiToken);
    const newSaiAppt = saiApptsRes2.data.appointments.find((a) => a._id === createdTestAppointmentId);
    assert(newSaiAppt, "Patient must see new appointment in their list");
    assert.strictEqual(newSaiAppt.doctorName, "Dr. Hema");
    assert.strictEqual(newSaiAppt.department, "Orthopedics");
    assert.strictEqual(newSaiAppt.status, "Scheduled");
    assert.strictEqual(newSaiAppt.timeSlot, futureSlot);
    assert.strictEqual(newSaiAppt.reason, clinicalReason);

    const hemaApptsRes2 = await request("GET", "/api/appointments", null, hemaToken);
    const newHemaAppt = hemaApptsRes2.data.appointments.find((a) => a._id === createdTestAppointmentId);
    assert(newHemaAppt, "Doctor Hema must see new appointment in assigned consultations");
    assert.strictEqual(newHemaAppt.patientName, "sai");
    assert.strictEqual(newHemaAppt.patientPhone, "9889898989");
    assert.strictEqual(newHemaAppt.patientEmail, "sai@gmail.com");
    assert.strictEqual(newHemaAppt.status, "Scheduled");
    assert.strictEqual(newHemaAppt.timeSlot, futureSlot);
    assert.strictEqual(newHemaAppt.reason, clinicalReason);
    console.log("✅ Patient ID, Doctor ID, Date, Time, Reason, and Status match perfectly across both accounts.");

    // Test Status Transition:
    console.log("Testing status transitions...");
    // Doctor confirms appointment
    const confirmRes = await request(
      "PUT",
      `/api/appointments/${createdTestAppointmentId}`,
      { status: "Confirmed" },
      hemaToken
    );
    assert.strictEqual(confirmRes.status, 200);
    const confirmedDoc = await Appointment.findById(createdTestAppointmentId);
    assert.strictEqual(confirmedDoc.status, "Confirmed");
    console.log("✅ Doctor transitioned status: Scheduled -> Confirmed");

    // Patient CANNOT mark appointment as Completed
    const patientCompleteRes = await request(
      "PUT",
      `/api/appointments/${createdTestAppointmentId}`,
      { status: "Completed" },
      saiToken
    );
    // Patient modifying status to completed is disallowed (or ignored by authorization)
    const afterPatientAttempt = await Appointment.findById(createdTestAppointmentId);
    assert.strictEqual(afterPatientAttempt.status, "Confirmed", "Patient cannot mark appointment Completed");
    console.log("✅ Patient cannot arbitrarily mark consultation as Completed.");

    // Doctor completes consultation
    const completeRes = await request(
      "PUT",
      `/api/appointments/${createdTestAppointmentId}`,
      { status: "Completed" },
      hemaToken
    );
    assert.strictEqual(completeRes.status, 200);
    const completedDoc = await Appointment.findById(createdTestAppointmentId);
    assert.strictEqual(completedDoc.status, "Completed");
    console.log("✅ Doctor successfully transitioned status to Completed.");

    // =========================================================================
    // STEP 8: Isolation Test with Second Patient and Second Doctor
    // =========================================================================
    console.log("\n--- STEP 8: Multi-Account Isolation Verification ---");
    // Create second patient and second doctor test fixtures
    testPatient2 = await User.create({
      name: "Patient Pooja Test",
      email: `pooja_test_${Date.now()}@vaidyasthana-test.com`,
      password: "TestPassword123!",
      phoneNumber: "9876543219",
      address: "12 Indira Nagar, Bengaluru",
      city: "Bengaluru",
      role: "patient",
      verificationStatus: "verified",
    });

    testDoctor2 = await User.create({
      name: "Dr. Vikram Test",
      email: `vikram_test_${Date.now()}@vaidyasthana-test.com`,
      password: "TestPassword123!",
      phoneNumber: "9876543220",
      address: "88 MG Road, Bengaluru",
      city: "Bengaluru",
      role: "doctor",
      specialization: "Cardiology",
      verificationStatus: "verified",
    });

    const tokenPatient2 = createToken(testPatient2);
    const tokenDoctor2 = createToken(testDoctor2);

    // Patient 2 books an appointment with Doctor 2
    const book2Res = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: testDoctor2._id.toString(),
        appointmentDate: futureDate,
        timeSlot: "10:00 AM",
        department: "Cardiology",
        reason: "Cardiac health checkup",
      },
      tokenPatient2
    );
    assert.strictEqual(book2Res.status, 201);
    testAppointment2Id = book2Res.data.appointment._id;
    console.log(`✅ Created isolated appointment for Patient 2 -> Doctor 2 (ID: ${testAppointment2Id})`);

    // Verify Patient 1 (sai) CANNOT see Appointment 2
    const saiCheckRes = await request("GET", "/api/appointments", null, saiToken);
    const saiSeesAppt2 = saiCheckRes.data.appointments.some((a) => a._id === testAppointment2Id);
    assert.strictEqual(saiSeesAppt2, false, "Patient 'sai' must NEVER see Patient 2's appointments!");
    console.log("✅ Verified: Patient 'sai' cannot see Patient 2's appointments.");

    // Verify Doctor 1 (Hema) CANNOT see Appointment 2
    const hemaCheckRes = await request("GET", "/api/appointments", null, hemaToken);
    const hemaSeesAppt2 = hemaCheckRes.data.appointments.some((a) => a._id === testAppointment2Id);
    assert.strictEqual(hemaSeesAppt2, false, "Doctor 'Hema' must NEVER see Doctor 2's appointments!");
    console.log("✅ Verified: Doctor 'Hema' cannot see Doctor 2's appointments.");

    // Verify Patient 2 CANNOT see Patient 1's appointments
    const p2CheckRes = await request("GET", "/api/appointments", null, tokenPatient2);
    const p2SeesSaiAppt = p2CheckRes.data.appointments.some(
      (a) => a._id === "6ad1b99fb2d9e2cca3547d3d" || a._id === createdTestAppointmentId
    );
    assert.strictEqual(p2SeesSaiAppt, false, "Patient 2 must NEVER see 'sai's appointments!");
    console.log("✅ Verified: Patient 2 cannot see 'sai's appointments.");

    // Verify Doctor 2 CANNOT see Doctor 1's appointments
    const d2CheckRes = await request("GET", "/api/appointments", null, tokenDoctor2);
    const d2SeesHemaAppt = d2CheckRes.data.appointments.some(
      (a) => a._id === "6ad1b99fb2d9e2cca3547d3d" || a._id === createdTestAppointmentId
    );
    assert.strictEqual(d2SeesHemaAppt, false, "Doctor 2 must NEVER see 'Hema's appointments!");
    console.log("✅ Verified: Doctor 2 cannot see 'Hema's appointments.");

    // Verify Doctor 2 patient list isolation (GET /api/doctor/patients)
    const doc2PatientsRes = await request("GET", "/api/doctor/patients", null, tokenDoctor2);
    assert.strictEqual(doc2PatientsRes.status, 200);
    const doc2Patients = doc2PatientsRes.data.patients || [];
    assert(doc2Patients.some((p) => p._id === testPatient2._id.toString()));
    assert(!doc2Patients.some((p) => p._id === saiUser._id.toString()), "Doctor 2 must not see sai");
    console.log("✅ Verified: Doctor patients directory is strictly isolated by doctorId.");

    console.log("\n==========================================================================");
    console.log("  ALL 8 PATIENT-DOCTOR APPOINTMENT MAPPING STEPS VERIFIED WITH 100% SUCCESS! ");
    console.log("==========================================================================");
  } finally {
    // Clean up temporary test fixtures in MongoDB Atlas
    console.log("\nCleaning up temporary test records from MongoDB Atlas...");
    if (createdTestAppointmentId) {
      await Appointment.findByIdAndDelete(createdTestAppointmentId);
      console.log(`✔ Cleaned test appointment ${createdTestAppointmentId}`);
    }
    if (testAppointment2Id) {
      await Appointment.findByIdAndDelete(testAppointment2Id);
      console.log(`✔ Cleaned test appointment ${testAppointment2Id}`);
    }
    if (testPatient2) {
      await User.findByIdAndDelete(testPatient2._id);
      console.log(`✔ Cleaned temporary test patient ${testPatient2._id}`);
    }
    if (testDoctor2) {
      await User.findByIdAndDelete(testDoctor2._id);
      console.log(`✔ Cleaned temporary test doctor ${testDoctor2._id}`);
    }

    if (server) {
      server.close();
    }
    await mongoose.disconnect();
    console.log("✔ Disconnected cleanly from Atlas.");
  }
}

runPatientDoctorMappingVerification().catch((err) => {
  console.error("❌ Verification failed:", err);
  process.exit(1);
});
