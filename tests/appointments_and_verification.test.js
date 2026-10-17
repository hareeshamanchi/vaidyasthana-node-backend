require("dotenv").config();
const assert = require("node:assert");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const app = require("../src/app");
const User = require("../src/models/User");
const Appointment = require("../src/models/Appointment");

let server;
let baseUrl;

let adminToken;
let doctorAToken;
let doctorBToken;
let patient1Token;
let patient2Token;

let doctorAUser;
let doctorBUser;
let patient1User;
let patient2User;
let adminUser;
let createdAppointmentId;

const request = async (method, path, body = null, token = null, headers = {}) => {
  const url = `${baseUrl}${path}`;
  const reqHeaders = { ...headers };

  if (token) {
    reqHeaders["Authorization"] = `Bearer ${token}`;
  }

  let reqBody = body;
  if (body && !headers["Content-Type"]) {
    reqHeaders["Content-Type"] = "application/json";
    reqBody = JSON.stringify(body);
  }

  const res = await fetch(url, {
    method,
    headers: reqHeaders,
    body: reqBody,
  });

  let parsed = null;
  const text = await res.text();
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  return {
    status: res.status,
    headers: res.headers,
    body: parsed,
  };
};

const createMultipartBody = (boundary, files = {}, fields = {}) => {
  const crlf = "\r\n";
  let body = "";

  for (const [k, v] of Object.entries(fields)) {
    body += `--${boundary}${crlf}`;
    body += `Content-Disposition: form-data; name="${k}"${crlf}${crlf}`;
    body += `${v}${crlf}`;
  }

  const parts = [Buffer.from(body, "utf-8")];

  for (const [fieldName, fileObj] of Object.entries(files)) {
    let header = `--${boundary}${crlf}`;
    header += `Content-Disposition: form-data; name="${fieldName}"; filename="${fileObj.name}"${crlf}`;
    header += `Content-Type: ${fileObj.mimeType || "application/octet-stream"}${crlf}${crlf}`;

    parts.push(Buffer.from(header, "utf-8"));
    parts.push(fileObj.buffer);
    parts.push(Buffer.from(crlf, "utf-8"));
  }

  parts.push(Buffer.from(`--${boundary}--${crlf}`, "utf-8"));
  return Buffer.concat(parts);
};

const runSuite = async () => {
  console.log("=================================================");
  console.log("  Vaidyasthana Appointments & Verification Tests ");
  console.log("=================================================");

  process.env.JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_key_minimum_32_chars";

  console.log("1. Connecting to MongoDB Atlas...");
  const connectDB = require("../src/config/db");
  if (mongoose.connection.readyState === 0) {
    await connectDB();
  }
  console.log("✔ Connected to MongoDB Atlas.");

  // Spin up test HTTP server
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
  console.log(`✔ Test HTTP server listening on ${baseUrl}`);

  // Create isolated test user fixtures
  const timestamp = Date.now();

  console.log("2. Setting up isolated test fixtures in Atlas...");
  adminUser = await User.create({
    name: `Test Admin ${timestamp}`,
    email: `admin_${timestamp}@test.com`,
    password: "Password123!",
    role: "admin",
    phoneNumber: "9876500000",
    address: "Admin Office, Hospital Complex",
    city: "Bengaluru",
  });

  doctorAUser = await User.create({
    name: `Dr. Alice Test ${timestamp}`,
    email: `doctor_a_${timestamp}@test.com`,
    password: "Password123!",
    role: "doctor",
    phoneNumber: "9876511111",
    address: "Doctors Quarters, 101",
    city: "Bengaluru",
    specialization: "Cardiology",
    medicalRegistrationNumber: `MCI-${timestamp}-A`,
    experienceYears: 10,
    consultationFee: 750,
    verificationStatus: "not_submitted",
  });

  doctorBUser = await User.create({
    name: `Dr. Bob Test ${timestamp}`,
    email: `doctor_b_${timestamp}@test.com`,
    password: "Password123!",
    role: "doctor",
    phoneNumber: "9876522222",
    address: "Doctors Quarters, 102",
    city: "Bengaluru",
    specialization: "Neurology",
    medicalRegistrationNumber: `MCI-${timestamp}-B`,
    experienceYears: 8,
    consultationFee: 800,
    verificationStatus: "verified", // already verified for comparison
  });

  patient1User = await User.create({
    name: `Patient One ${timestamp}`,
    email: `patient1_${timestamp}@test.com`,
    password: "Password123!",
    role: "patient",
    phoneNumber: "9876533333",
    address: "123 Indiranagar, Bengaluru",
    city: "Bengaluru",
  });

  patient2User = await User.create({
    name: `Patient Two ${timestamp}`,
    email: `patient2_${timestamp}@test.com`,
    password: "Password123!",
    role: "patient",
    phoneNumber: "9876544444",
    address: "456 Koramangala, Bengaluru",
    city: "Bengaluru",
  });

  adminToken = jwt.sign({ id: adminUser._id, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  doctorAToken = jwt.sign({ id: doctorAUser._id, role: "doctor" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  doctorBToken = jwt.sign({ id: doctorBUser._id, role: "doctor" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  patient1Token = jwt.sign({ id: patient1User._id, role: "patient" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  patient2Token = jwt.sign({ id: patient2User._id, role: "patient" }, process.env.JWT_SECRET, { expiresIn: "1h" });

  console.log("✔ Test fixtures created.\n");

  try {
    // =========================================================================
    // TEST 1: Phone Validation on Registration
    // =========================================================================
    process.stdout.write("Testing 1: POST /api/auth/register fails if phone number is invalid... ");
    const badPhoneRes = await request("POST", "/api/auth/register", {
      name: "Invalid Phone User",
      email: `bad_phone_${Date.now()}@test.com`,
      password: "Password123!",
      role: "patient",
      phoneNumber: "123", // too short (< 10 digits)
      address: "Valid Address Street, City",
    });
    assert.strictEqual(badPhoneRes.status, 400);
    assert.match(badPhoneRes.body.message, /valid 10/i);
    console.log("✔ PASSED");

    // =========================================================================
    // TEST 2: Address Validation on Registration
    // =========================================================================
    process.stdout.write("Testing 2: POST /api/auth/register fails if address is < 5 characters... ");
    const badAddrRes = await request("POST", "/api/auth/register", {
      name: "Invalid Address User",
      email: `bad_addr_${Date.now()}@test.com`,
      password: "Password123!",
      role: "patient",
      phoneNumber: "9876598765",
      address: "12", // too short (< 5 chars)
    });
    assert.strictEqual(badAddrRes.status, 400);
    assert.match(badAddrRes.body.message, /minimum 5 characters/i);
    console.log("✔ PASSED");

    // =========================================================================
    // TEST 3: Successful Registration with Phone and Address
    // =========================================================================
    process.stdout.write("Testing 3: POST /api/auth/register succeeds with valid phone and address... ");
    const goodEmail = `good_patient_${Date.now()}@test.com`;
    const goodRegRes = await request("POST", "/api/auth/register", {
      name: "Valid Patient User",
      email: goodEmail,
      password: "Password123!",
      role: "patient",
      phoneNumber: "9876543210",
      address: "77 Church Street, Bengaluru, Karnataka",
    });
    assert.strictEqual(goodRegRes.status, 201);
    assert.strictEqual(goodRegRes.body.success, true);
    assert.ok(goodRegRes.body.token);
    await User.deleteOne({ email: goodEmail });
    console.log("✔ PASSED");

    // =========================================================================
    // TEST 4: Unverified Doctor Excluded from Public Directory
    // =========================================================================
    process.stdout.write("Testing 4: GET /api/appointments/doctors excludes unverified doctors... ");
    const docDirRes = await request("GET", "/api/appointments/doctors");
    assert.strictEqual(docDirRes.status, 200);
    assert.strictEqual(docDirRes.body.success, true);
    const docIds = docDirRes.body.doctors.map((d) => d._id);
    assert.strictEqual(docIds.includes(doctorAUser._id.toString()), false, "Unverified doctor A must not be listed");
    assert.strictEqual(docIds.includes(doctorBUser._id.toString()), true, "Verified doctor B must be listed");
    console.log("✔ PASSED");

    // =========================================================================
    // TEST 5: Booking an Unverified Doctor is Blocked
    // =========================================================================
    process.stdout.write("Testing 5: POST /api/appointments blocks unverified doctor... ");
    const blockUnverifiedRes = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: doctorAUser._id.toString(),
        doctorName: doctorAUser.name,
        appointmentDate: "2026-11-20",
        timeSlot: "10:00 AM",
        department: "Cardiology",
      },
      patient1Token
    );
    assert.strictEqual(blockUnverifiedRes.status, 403);
    assert.match(blockUnverifiedRes.body.message, /credential verification/i);
    console.log("✔ PASSED");

    // =========================================================================
    // TEST 6: Doctor Credential Upload Transitions Status to Pending
    // =========================================================================
    process.stdout.write("Testing 6: POST /api/doctor/verification-documents submits credentials... ");
    const boundary = `----WebKitFormBoundary${Date.now()}`;
    const mockPdf = Buffer.from("%PDF-1.4 mock medical registration certificate", "utf-8");
    const multipart = createMultipartBody(
      boundary,
      {
        identityProof: { name: "passport.pdf", buffer: mockPdf, mimeType: "application/pdf" },
        medicalRegistrationProof: { name: "mci_license.pdf", buffer: mockPdf, mimeType: "application/pdf" },
      },
      {
        medicalRegistrationNumber: "MCI-APPROVED-2026",
      }
    );
    const uploadVerifRes = await request(
      "POST",
      "/api/doctor/verification-documents",
      multipart,
      doctorAToken,
      { "Content-Type": `multipart/form-data; boundary=${boundary}` }
    );
    assert.strictEqual(uploadVerifRes.status, 200);
    assert.strictEqual(uploadVerifRes.body.verificationStatus, "pending");
    const docInDb = await User.findById(doctorAUser._id);
    assert.strictEqual(docInDb.verificationStatus, "pending");
    assert.strictEqual(docInDb.verificationDocuments.length, 2);
    console.log("✔ PASSED");

    // =========================================================================
    // TEST 7: Admin Lists Pending Doctors & Approves
    // =========================================================================
    process.stdout.write("Testing 7: Admin verification approval activates doctor... ");
    const pendingListRes = await request("GET", "/api/admin/doctors/pending-verification", null, adminToken);
    assert.strictEqual(pendingListRes.status, 200);
    const pendingIds = pendingListRes.body.doctors.map((d) => d._id);
    assert.strictEqual(pendingIds.includes(doctorAUser._id.toString()), true);

    const approveRes = await request(
      "POST",
      `/api/admin/doctors/${doctorAUser._id}/verify`,
      {
        decision: "verified",
        notes: "License verified with State Medical Council.",
      },
      adminToken
    );
    assert.strictEqual(approveRes.status, 200);
    assert.strictEqual(approveRes.body.doctor.verificationStatus, "verified");

    // Verify Doctor A now appears in public directory
    const dirRes2 = await request("GET", "/api/appointments/doctors");
    const docIds2 = dirRes2.body.doctors.map((d) => d._id);
    assert.strictEqual(docIds2.includes(doctorAUser._id.toString()), true);
    console.log("✔ PASSED");

    // =========================================================================
    // TEST 8: Dynamic Slots Calculation
    // =========================================================================
    process.stdout.write("Testing 8: GET /api/appointments/slots returns slots for verified doctor... ");
    const appointmentDate = "2026-11-25";
    const testSlot = "11:00 AM";

    const slotsRes = await request(
      "GET",
      `/api/appointments/slots?doctorId=${doctorAUser._id}&date=${appointmentDate}`,
      null,
      patient1Token
    );
    assert.strictEqual(slotsRes.status, 200);
    assert.ok(Array.isArray(slotsRes.body.slots));
    const slot11 = slotsRes.body.slots.find((s) => s.timeSlot === testSlot);
    assert.ok(slot11, "11:00 AM slot must exist");
    assert.strictEqual(slot11.isBooked, false);
    console.log("✔ PASSED");

    // =========================================================================
    // TEST 9: Patient 1 Books Appointment
    // =========================================================================
    process.stdout.write("Testing 9: Patient 1 books available slot... ");
    const bookRes = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: doctorAUser._id.toString(),
        doctorName: doctorAUser.name,
        appointmentDate,
        timeSlot: testSlot,
        department: "Cardiology",
        consultationType: "In-Person",
        notes: "Cardio evaluation",
      },
      patient1Token
    );
    assert.strictEqual(bookRes.status, 201);
    createdAppointmentId = bookRes.body.appointment._id;

    // Verify slot is marked booked
    const slotsRes2 = await request(
      "GET",
      `/api/appointments/slots?doctorId=${doctorAUser._id}&date=${appointmentDate}`,
      null,
      patient1Token
    );
    const slot11Booked = slotsRes2.body.slots.find((s) => s.timeSlot === testSlot);
    assert.strictEqual(slot11Booked.isBooked, true);
    console.log("✔ PASSED");

    // =========================================================================
    // TEST 10: Atomic Double-Booking Conflict Prevention
    // =========================================================================
    process.stdout.write("Testing 10: Atomic double booking returns 409 Conflict... ");
    const conflictRes = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: doctorAUser._id.toString(),
        doctorName: doctorAUser.name,
        appointmentDate,
        timeSlot: testSlot,
        department: "Cardiology",
        notes: "Concurrent booking collision attempt",
      },
      patient2Token
    );
    assert.strictEqual(conflictRes.status, 409);
    assert.match(conflictRes.body.message, /already booked/i);
    console.log("✔ PASSED");

    // =========================================================================
    // TEST 11: Doctor Schedule Isolation
    // =========================================================================
    process.stdout.write("Testing 11: Doctor isolation - Doctor A sees appointment, Doctor B does not... ");
    const resA = await request("GET", "/api/appointments", null, doctorAToken);
    assert.strictEqual(resA.status, 200);
    const idsA = resA.body.appointments.map((a) => a._id);
    assert.strictEqual(idsA.includes(createdAppointmentId), true);

    const resB = await request("GET", "/api/appointments", null, doctorBToken);
    assert.strictEqual(resB.status, 200);
    const idsB = resB.body.appointments.map((a) => a._id);
    assert.strictEqual(idsB.includes(createdAppointmentId), false);
    console.log("✔ PASSED");

    // =========================================================================
    // TEST 12: Doctor Lifecycle & Cancellation Re-booking
    // =========================================================================
    process.stdout.write("Testing 12: Doctor status transitions & cancellation freeing slot... ");
    // Confirm
    const confRes = await request("PUT", `/api/appointments/${createdAppointmentId}`, { status: "Confirmed" }, doctorAToken);
    assert.strictEqual(confRes.body.appointment.status, "Confirmed");

    // In Progress
    const inProgRes = await request("PUT", `/api/appointments/${createdAppointmentId}`, { status: "In Progress" }, doctorAToken);
    assert.strictEqual(inProgRes.body.appointment.status, "In Progress");

    // Cancel
    const cancelRes = await request("PUT", `/api/appointments/${createdAppointmentId}`, { status: "Cancelled" }, patient1Token);
    assert.strictEqual(cancelRes.body.appointment.status, "Cancelled");

    // Verify slot is free again
    const slotsRes3 = await request(
      "GET",
      `/api/appointments/slots?doctorId=${doctorAUser._id}&date=${appointmentDate}`,
      null,
      patient2Token
    );
    const slot11Free = slotsRes3.body.slots.find((s) => s.timeSlot === testSlot);
    assert.strictEqual(slot11Free.isBooked, false);

    // Patient 2 can now book it!
    const rebookRes = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: doctorAUser._id.toString(),
        doctorName: doctorAUser.name,
        appointmentDate,
        timeSlot: testSlot,
        department: "Cardiology",
      },
      patient2Token
    );
    assert.strictEqual(rebookRes.status, 201);
    console.log("✔ PASSED");

    console.log("\n=================================================");
    console.log("  ALL 12 APPOINTMENT & VERIFICATION TESTS PASSED!");
    console.log("=================================================\n");
  } finally {
    // Cleanup fixtures
    console.log("Cleaning up test fixtures in MongoDB Atlas...");
    if (adminUser) {
      await User.deleteMany({
        _id: { $in: [adminUser._id, doctorAUser._id, doctorBUser._id, patient1User._id, patient2User._id] },
      });
      await Appointment.deleteMany({
        doctorId: { $in: [doctorAUser._id, doctorBUser._id] },
      });
    }

    if (server) {
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }

    await mongoose.disconnect();
    console.log("✔ Disconnected cleanly from Atlas.");
  }
};

runSuite().then(
  () => process.exit(0),
  (err) => {
    console.error("\n❌ TEST SUITE FAILED:", err);
    process.exit(1);
  }
);
