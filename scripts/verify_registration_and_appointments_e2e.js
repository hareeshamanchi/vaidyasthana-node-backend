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

const getTomorrowDateString = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
};

async function runCompleteAppointmentVerification() {
  console.log("==========================================================================");
  console.log("  Vaidyasthana 10-Step Appointment Synchronization & Security Verification ");
  console.log("==========================================================================\n");

  // Database Connection
  console.log("Connecting to MongoDB Atlas...");
  const conn = await connectDB();
  assert(conn, "Database connection must succeed");
  console.log(`Connected to host: ${conn.connection.host}`);
  console.log(`Verified database name: ${conn.connection.name}`);
  assert.strictEqual(conn.connection.name, "vaidyasthana", "Database must be vaidyasthana");

  // Spin up test server
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
  console.log(`✔ Test HTTP server active on ${baseUrl}\n`);

  const timestamp = Date.now();
  const testEntities = { userIds: [], appointmentIds: [] };

  try {
    // ------------------------------------------------------------------------
    // STEP 1: Register a new test doctor
    // ------------------------------------------------------------------------
    console.log("--- STEP 1: Registering a new test doctor (POST /api/auth/register) ---");
    const doctorEmail = `dr_test_${timestamp}@vaidyasthana.com`;
    const doctorPassword = "DoctorSecurePass123!";
    const doctorName = `Dr. Specialist ${timestamp}`;

    const doctorRegRes = await request("POST", "/api/auth/register", {
      name: doctorName,
      email: doctorEmail,
      password: doctorPassword,
      phoneNumber: "+919876501234",
      address: "Suite 404, Specialty Medical Wing, Bengaluru",
      city: "Bengaluru",
      state: "Karnataka",
      postalCode: "560001",
      role: "doctor",
      specialization: "Cardiology",
      qualifications: "MBBS, MD (Cardiology)",
      medicalRegistrationNumber: `MCI-${timestamp}`,
      consultationFee: 700,
      experienceYears: 12,
    });

    assert.strictEqual(doctorRegRes.status, 201, `Doctor registration should succeed: ${JSON.stringify(doctorRegRes.data)}`);
    assert.strictEqual(doctorRegRes.data.success, true);
    assert.ok(doctorRegRes.data.token, "Doctor registration must return JWT token");
    const doctorToken = doctorRegRes.data.token;
    console.log(`✔ Doctor registration returned HTTP 201 Created for ${doctorEmail}`);

    // ------------------------------------------------------------------------
    // STEP 2: Verify that the doctor is stored in vaidyasthana.users with correct role
    // ------------------------------------------------------------------------
    console.log("\n--- STEP 2: Verifying doctor in MongoDB Atlas vaidyasthana.users ---");
    const doctorInDb = await User.findOne({ email: doctorEmail });
    assert(doctorInDb, "Doctor must exist in vaidyasthana.users");
    testEntities.userIds.push(doctorInDb._id);

    console.log(`✔ Found Doctor in Atlas:`);
    console.log(`  - _id: ${doctorInDb._id}`);
    console.log(`  - Name: ${doctorInDb.name}`);
    console.log(`  - Role: ${doctorInDb.role}`);
    console.log(`  - Specialization: ${doctorInDb.specialization}`);
    console.log(`  - Medical Reg No: ${doctorInDb.medicalRegistrationNumber}`);
    console.log(`  - Verification Status: ${doctorInDb.verificationStatus}`);

    assert.strictEqual(doctorInDb.role, "doctor", "User role must be doctor");
    assert.strictEqual(doctorInDb.specialization, "Cardiology");
    assert.strictEqual(doctorInDb.verificationStatus, "verified", "Doctor must be verified and eligible");
    assert(doctorInDb.password.startsWith("$2b$"), "Password must be bcrypt hashed");
    assert.notStrictEqual(doctorInDb.password, doctorPassword, "Plain text password must never be stored");
    console.log("✔ Doctor record fully validated in vaidyasthana.users!");

    // ------------------------------------------------------------------------
    // STEP 3: Register and log in as a test patient
    // ------------------------------------------------------------------------
    console.log("\n--- STEP 3: Registering and logging in as test patient ---");
    const patientEmail = `patient_${timestamp}@example.com`;
    const patientPassword = "PatientPass123!";
    const patientName = `Patient Test ${timestamp}`;

    const patientRegRes = await request("POST", "/api/auth/register", {
      name: patientName,
      email: patientEmail,
      password: patientPassword,
      phoneNumber: "+919123456780",
      address: "123 Residency Road, Bengaluru, Karnataka",
      city: "Bengaluru",
      role: "patient",
    });

    assert.strictEqual(patientRegRes.status, 201, `Patient registration should succeed: ${JSON.stringify(patientRegRes.data)}`);
    const patientInDb = await User.findOne({ email: patientEmail });
    assert(patientInDb, "Patient must exist in vaidyasthana.users");
    testEntities.userIds.push(patientInDb._id);

    // Test patient login API explicitly
    const patientLoginRes = await request("POST", "/api/auth/login", {
      email: patientEmail,
      password: patientPassword,
    });
    assert.strictEqual(patientLoginRes.status, 200, "Patient login must succeed with HTTP 200");
    const patientToken = patientLoginRes.data.token;
    assert.ok(patientToken, "Login must return valid JWT");
    console.log(`✔ Patient ${patientEmail} registered and authenticated successfully!`);

    // ------------------------------------------------------------------------
    // STEP 4: Confirm registered doctor appears dynamically in doctor directory
    // ------------------------------------------------------------------------
    console.log("\n--- STEP 4: Checking appointment doctor directory (GET /api/appointments/doctors) ---");
    const docsRes = await request("GET", "/api/appointments/doctors", null, patientToken);
    assert.strictEqual(docsRes.status, 200, "Doctor directory request must succeed");
    const doctors = docsRes.data.doctors || [];
    console.log(`Total verified doctors in directory: ${doctors.length}`);

    const matchedDoc = doctors.find((d) => d._id.toString() === doctorInDb._id.toString());
    assert(matchedDoc, `Newly registered doctor ${doctorName} must appear in doctors directory`);
    console.log(`✔ Doctor ${matchedDoc.name} dynamically retrieved from Atlas:`);
    console.log(`  - _id: ${matchedDoc._id}`);
    console.log(`  - Specialization: ${matchedDoc.specialization}`);
    console.log(`  - City / Address: ${matchedDoc.city || matchedDoc.address}`);
    console.log(`  - Fee: ₹${matchedDoc.consultationFee}`);

    // ------------------------------------------------------------------------
    // STEP 5: Select doctor and book a valid available time slot
    // ------------------------------------------------------------------------
    console.log("\n--- STEP 5: Patient booking available time slot with registered doctor ---");
    const targetDate = getTomorrowDateString();

    const slotsRes = await request(
      "GET",
      `/api/appointments/slots?doctorId=${doctorInDb._id}&date=${targetDate}`,
      null,
      patientToken
    );
    assert.strictEqual(slotsRes.status, 200, "Slots retrieval must succeed");
    const slots = slotsRes.data.slots || [];
    assert(slots.length > 0, "Slots must be available for tomorrow");

    const availableSlotObj = slots.find((s) => s.isAvailable);
    assert(availableSlotObj, "Must have at least one available slot");
    const chosenSlot = availableSlotObj.timeSlot;
    console.log(`Selected slot: ${chosenSlot} on ${targetDate}`);

    const bookingRes = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: doctorInDb._id.toString(),
        appointmentDate: targetDate,
        timeSlot: chosenSlot,
        consultationType: "In-Person",
        type: "Consultation",
        reason: "Cardiac assessment and checkup",
        notes: "Patient requested first morning slot",
      },
      patientToken
    );

    assert.strictEqual(bookingRes.status, 201, `Booking must succeed: ${JSON.stringify(bookingRes.data)}`);
    assert.strictEqual(bookingRes.data.success, true);
    const createdAppointment = bookingRes.data.appointment;
    testEntities.appointmentIds.push(createdAppointment._id);
    console.log(`✔ Appointment successfully booked in backend! ID: ${createdAppointment._id}`);

    // ------------------------------------------------------------------------
    // STEP 6: Confirm appointment exists in MongoDB Atlas with correct IDs
    // ------------------------------------------------------------------------
    console.log("\n--- STEP 6: Confirming appointment in MongoDB Atlas appointments collection ---");
    const apptInDb = await Appointment.findById(createdAppointment._id);
    assert(apptInDb, "Appointment must exist in vaidyasthana.appointments");

    console.log(`✔ Appointment Record in Atlas:`);
    console.log(`  - _id: ${apptInDb._id}`);
    console.log(`  - patientId: ${apptInDb.patientId}`);
    console.log(`  - doctorId: ${apptInDb.doctorId}`);
    console.log(`  - patientName: ${apptInDb.patientName}`);
    console.log(`  - doctorName: ${apptInDb.doctorName}`);
    console.log(`  - appointmentDate: ${apptInDb.appointmentDate.toISOString()}`);
    console.log(`  - timeSlot: ${apptInDb.timeSlot}`);
    console.log(`  - status: ${apptInDb.status}`);

    assert.strictEqual(apptInDb.patientId.toString(), patientInDb._id.toString(), "patientId must match authenticated patient");
    assert.strictEqual(apptInDb.doctorId.toString(), doctorInDb._id.toString(), "doctorId must match selected doctor");
    assert.strictEqual(apptInDb.status, "Scheduled", "Status must be Scheduled");
    console.log("✔ Appointment verified in Atlas with exact patient and doctor relationships!");

    // ------------------------------------------------------------------------
    // STEP 7: Confirm appointment appears on Patient Dashboard (GET /api/appointments)
    // ------------------------------------------------------------------------
    console.log("\n--- STEP 7: Verifying Patient Dashboard appointment retrieval ---");
    const patientDashboardRes = await request("GET", "/api/appointments", null, patientToken);
    assert.strictEqual(patientDashboardRes.status, 200);
    const patientAppointments = patientDashboardRes.data.appointments || [];

    const foundInPatientList = patientAppointments.find((a) => a._id.toString() === createdAppointment._id.toString());
    assert(foundInPatientList, "Appointment must appear in patient dashboard query");
    assert.strictEqual(foundInPatientList.doctorName, createdAppointment.doctorName);
    assert.strictEqual(foundInPatientList.timeSlot, chosenSlot);
    assert.strictEqual(foundInPatientList.status, "Scheduled");
    console.log(`✔ Patient Dashboard displays appointment with Doctor: ${foundInPatientList.doctorName}, Slot: ${foundInPatientList.timeSlot}, Status: ${foundInPatientList.status}`);

    // ------------------------------------------------------------------------
    // STEP 8: Log in as selected doctor and confirm appointment on Doctor Dashboard
    // ------------------------------------------------------------------------
    console.log("\n--- STEP 8: Doctor Login & Doctor Dashboard consultation count verification ---");
    const doctorLoginRes = await request("POST", "/api/auth/login", {
      email: doctorEmail,
      password: doctorPassword,
    });
    assert.strictEqual(doctorLoginRes.status, 200, "Doctor login must succeed with HTTP 200");
    const authenticatedDoctorToken = doctorLoginRes.data.token;

    const doctorDashboardRes = await request("GET", "/api/appointments", null, authenticatedDoctorToken);
    assert.strictEqual(doctorDashboardRes.status, 200);
    const doctorAppointments = doctorDashboardRes.data.appointments || [];

    console.log(`Doctor assigned consultations count: ${doctorAppointments.length}`);
    assert.strictEqual(doctorAppointments.length, 1, "Doctor must have exactly 1 assigned consultation");

    const foundInDoctorList = doctorAppointments.find((a) => a._id.toString() === createdAppointment._id.toString());
    assert(foundInDoctorList, "Appointment must appear in doctor assigned consultations");
    assert.strictEqual(foundInDoctorList.patientName, patientName);
    assert.strictEqual(foundInDoctorList.patientPhone, patientInDb.phoneNumber);
    assert.strictEqual(foundInDoctorList.timeSlot, chosenSlot);
    assert.strictEqual(foundInDoctorList.reason, "Cardiac assessment and checkup");
    assert.strictEqual(foundInDoctorList.consultationType, "In-Person");
    assert.strictEqual(foundInDoctorList.status, "Scheduled");
    console.log(`✔ Doctor Dashboard verified with patient details: ${foundInDoctorList.patientName} (${foundInDoctorList.patientPhone}) - Consultation count: ${doctorAppointments.length}`);

    // ------------------------------------------------------------------------
    // STEP 9: Cross-tenant Access Control & Authorization Boundaries
    // ------------------------------------------------------------------------
    console.log("\n--- STEP 9: Testing Authorization Isolation between other patients and doctors ---");
    // Register another patient (Patient B)
    const patientBEmail = `patient_b_${timestamp}@example.com`;
    const patientBRes = await request("POST", "/api/auth/register", {
      name: `Patient B ${timestamp}`,
      email: patientBEmail,
      password: "Password123!",
      phoneNumber: "+919555544444",
      address: "88 Gandhi Road, Bengaluru",
      role: "patient",
    });
    assert.strictEqual(patientBRes.status, 201);
    const patientBToken = patientBRes.data.token;
    testEntities.userIds.push(patientBRes.data.user._id || patientBRes.data.user.id);

    // Register another doctor (Doctor B)
    const doctorBEmail = `dr_b_${timestamp}@vaidyasthana.com`;
    const doctorBRes = await request("POST", "/api/auth/register", {
      name: `Dr. Other ${timestamp}`,
      email: doctorBEmail,
      password: "DoctorPass123!",
      phoneNumber: "+919666633333",
      address: "Clinic B, Medical Complex",
      role: "doctor",
      specialization: "Dermatology",
      medicalRegistrationNumber: `MCI-B-${timestamp}`,
    });
    assert.strictEqual(doctorBRes.status, 201);
    const doctorBToken = doctorBRes.data.token;
    testEntities.userIds.push(doctorBRes.data.user._id || doctorBRes.data.user.id);

    // Test A: Patient B's appointment list must NOT contain Patient A's appointment
    const patientBList = await request("GET", "/api/appointments", null, patientBToken);
    assert.strictEqual(patientBList.status, 200);
    assert.strictEqual(patientBList.data.appointments.length, 0, "Patient B must see 0 appointments");
    console.log("✔ Patient B list is isolated (0 appointments).");

    // Test B: Patient B cannot view Patient A's appointment by ID
    const unauthorizedViewRes = await request("GET", `/api/appointments/${createdAppointment._id}`, null, patientBToken);
    assert.strictEqual(unauthorizedViewRes.status, 403, "Patient B viewing Patient A appointment must return 403");
    console.log("✔ Patient B blocked from viewing Patient A appointment (HTTP 403).");

    // Test C: Doctor B's appointment list must NOT contain Doctor A's appointment
    const doctorBList = await request("GET", "/api/appointments", null, doctorBToken);
    assert.strictEqual(doctorBList.status, 200);
    assert.strictEqual(doctorBList.data.appointments.length, 0, "Doctor B must see 0 consultations");
    console.log("✔ Doctor B list is isolated (0 consultations).");

    // Test D: Doctor B cannot view or modify Doctor A's appointment
    const docBModifyRes = await request(
      "PUT",
      `/api/appointments/${createdAppointment._id}`,
      { status: "Confirmed" },
      doctorBToken
    );
    assert.strictEqual(docBModifyRes.status, 403, "Doctor B modifying Doctor A appointment must return 403");
    console.log("✔ Doctor B blocked from modifying Doctor A appointment (HTTP 403).");

    // ------------------------------------------------------------------------
    // STEP 10: Validation, Edge Cases & Error Handling
    // ------------------------------------------------------------------------
    console.log("\n--- STEP 10: Testing Edge Cases, Validation, and Double-booking Guards ---");

    // Test 10.1: Past date booking is rejected
    const pastDateRes = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: doctorInDb._id.toString(),
        appointmentDate: "2020-01-01",
        timeSlot: "10:00 AM",
      },
      patientToken
    );
    assert.strictEqual(pastDateRes.status, 400);
    assert.match(pastDateRes.data.message, /past/i);
    console.log("✔ Past appointment date rejected with HTTP 400.");

    // Test 10.2: Invalid date format is rejected
    const invalidDateRes = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: doctorInDb._id.toString(),
        appointmentDate: "not-a-date",
        timeSlot: "10:00 AM",
      },
      patientToken
    );
    assert.strictEqual(invalidDateRes.status, 400);
    console.log("✔ Invalid date format rejected with HTTP 400.");

    // Test 10.3: Invalid doctorId format is rejected
    const invalidDocIdRes = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: "invalid-mongo-id-123",
        appointmentDate: targetDate,
        timeSlot: "11:00 AM",
      },
      patientToken
    );
    assert.strictEqual(invalidDocIdRes.status, 400);
    console.log("✔ Malformed doctorId rejected with HTTP 400.");

    // Test 10.4: Duplicate booking of same slot by same patient
    const dupBookingRes = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: doctorInDb._id.toString(),
        appointmentDate: targetDate,
        timeSlot: chosenSlot,
      },
      patientToken
    );
    assert.strictEqual(dupBookingRes.status, 409);
    console.log("✔ Duplicate booking by same patient rejected with HTTP 409 Conflict.");

    // Test 10.5: Double booking of same doctor's slot by a DIFFERENT patient (Patient B)
    const doubleBookRes = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: doctorInDb._id.toString(),
        appointmentDate: targetDate,
        timeSlot: chosenSlot,
      },
      patientBToken
    );
    assert.strictEqual(doubleBookRes.status, 409);
    console.log("✔ Double-booking by different patient rejected with HTTP 409 Conflict.");

    // Test 10.6: Doctor status update lifecycle (Scheduled -> Confirmed -> In Progress -> Completed)
    const confirmRes = await request(
      "PUT",
      `/api/appointments/${createdAppointment._id}`,
      { status: "Confirmed" },
      authenticatedDoctorToken
    );
    assert.strictEqual(confirmRes.status, 200);
    assert.strictEqual(confirmRes.data.appointment.status, "Confirmed");
    console.log("✔ Doctor confirmed appointment (status: Confirmed).");

    const completeRes = await request(
      "PUT",
      `/api/appointments/${createdAppointment._id}`,
      { status: "Completed" },
      authenticatedDoctorToken
    );
    assert.strictEqual(completeRes.status, 200);
    assert.strictEqual(completeRes.data.appointment.status, "Completed");
    console.log("✔ Doctor completed appointment (status: Completed).");

    console.log("\n==========================================================================");
    console.log("  ALL 10 WORKFLOW STEPS PASSED WITH 100% SUCCESS AND FULL VERIFICATION!  ");
    console.log("==========================================================================");
  } finally {
    // Cleanup temporary test records
    console.log("\nCleaning up temporary test data in Atlas...");
    if (testEntities.appointmentIds.length > 0) {
      await Appointment.deleteMany({ _id: { $in: testEntities.appointmentIds } });
    }
    if (testEntities.userIds.length > 0) {
      await User.deleteMany({ _id: { $in: testEntities.userIds } });
    }
    console.log("✔ Cleanup complete.");

    server.close();
    await mongoose.disconnect();
  }
}

runCompleteAppointmentVerification().catch((err) => {
  console.error("Verification error:", err);
  if (server) server.close();
  mongoose.disconnect();
  process.exit(1);
});
