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

const getFutureDateString = (daysAhead = 14) => {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const runRoleSeparationVerification = async () => {
  console.log("=================================================");
  console.log("   Vaidyasthana: Role Separation Verification    ");
  console.log("=================================================");

  // 1. Database Connection
  console.log("\n[1/8] Connecting to MongoDB Atlas...");
  await connectDB();
  assert.ok(mongoose.connection.readyState === 1, "Must be connected to Atlas");
  console.log("✔ Connected to Atlas successfully.");

  // 2. Start Test Server
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`✔ Test server listening on ${baseUrl}`);

  // 3. Locate verified patient & doctor accounts
  console.log("\n[2/8] Locating accounts for patient 'sai' and doctor 'Hema' in Atlas...");
  const patientSai = await User.findOne({ email: "sai@gmail.com", role: "patient" });
  assert.ok(patientSai, "Patient 'sai' (sai@gmail.com) must exist in Atlas");

  const doctorHema = await User.findOne({ email: "hema@gmail.com", role: "doctor" });
  assert.ok(doctorHema, "Doctor 'Hema' (hema@gmail.com) must exist in Atlas");

  const patientToken = createToken(patientSai);
  const doctorToken = createToken(doctorHema);

  console.log(`✔ Patient found: ${patientSai.name} (${patientSai._id})`);
  console.log(`✔ Doctor found:  ${doctorHema.name} (${doctorHema._id}, ${doctorHema.specialization})`);

  let testAppointmentId1 = null;
  let testAppointmentId2 = null;

  try {
    // 4. Test Step 1: Patient role appointments query
    console.log("\n[3/8] Testing Patient GET /api/appointments...");
    const patientRes = await request("GET", "/api/appointments", null, patientToken);
    assert.strictEqual(patientRes.status, 200, "Patient query must return 200 OK");
    assert.ok(Array.isArray(patientRes.data.appointments), "Appointments must be an array");

    console.log(`✔ Patient appointments returned: count = ${patientRes.data.count}`);
    for (const appt of patientRes.data.appointments) {
      const patIdStr = appt.patientId?._id ? appt.patientId._id.toString() : appt.patientId.toString();
      assert.strictEqual(
        patIdStr,
        patientSai._id.toString(),
        "Every appointment in patient query must strictly belong to patient 'sai'"
      );
      assert.ok(appt.doctorName, "Doctor name must be enriched in response");
      assert.ok(appt.department, "Department must be enriched in response");
    }
    console.log("✔ Strict patient ownership and doctor enrichment verified.");

    // 5. Test Step 2: Doctor role appointments query
    console.log("\n[4/8] Testing Doctor GET /api/appointments...");
    const doctorRes = await request("GET", "/api/appointments", null, doctorToken);
    assert.strictEqual(doctorRes.status, 200, "Doctor query must return 200 OK");
    assert.ok(Array.isArray(doctorRes.data.appointments), "Appointments must be an array");

    console.log(`✔ Doctor assigned consultations returned: count = ${doctorRes.data.count}`);
    for (const appt of doctorRes.data.appointments) {
      const docIdStr = appt.doctorId?._id ? appt.doctorId._id.toString() : appt.doctorId.toString();
      assert.strictEqual(
        docIdStr,
        doctorHema._id.toString(),
        "Every appointment in doctor query must strictly belong to doctor 'Hema'"
      );
      assert.ok(appt.patientName, "Patient name must be enriched in response");
    }
    console.log("✔ Strict doctor ownership and patient details enrichment verified.");

    // 6. Test Step 3: Doctor booking rejection (Role Guard Enforcement)
    console.log("\n[5/8] Testing Doctor POST /api/appointments booking role guard...");
    const doctorBookingAttempt = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: doctorHema._id.toString(),
        appointmentDate: getFutureDateString(10),
        timeSlot: "10:30 AM",
        consultationType: "In-Person",
        notes: "Doctor booking attempt",
      },
      doctorToken
    );

    assert.strictEqual(
      doctorBookingAttempt.status,
      403,
      "Doctor appointment booking MUST be rejected with HTTP 403 Forbidden"
    );
    assert.ok(
      doctorBookingAttempt.data?.message?.includes("patients can schedule"),
      `Expected message mentioning patients can schedule, got: ${JSON.stringify(doctorBookingAttempt.data)}`
    );
    console.log("✔ Doctor booking attempt correctly rejected with 403 Forbidden (booking hidden & protected).");

    // 7. Test Step 4: Patient successfully schedules appointment
    console.log("\n[6/8] Testing Patient scheduling appointment with Doctor Hema...");
    const futureDate = getFutureDateString(12);
    const bookRes = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: doctorHema._id.toString(),
        appointmentDate: futureDate,
        timeSlot: "11:00 AM",
        consultationType: "In-Person",
        notes: "Severe migraine and neck stiffness",
        reason: "Severe migraine and neck stiffness",
      },
      patientToken
    );

    assert.strictEqual(bookRes.status, 201, `Booking should succeed, got ${bookRes.status}`);
    assert.ok(bookRes.data.appointment, "Response must include created appointment");
    testAppointmentId1 = bookRes.data.appointment._id;
    console.log(`✔ Patient booked appointment ID: ${testAppointmentId1} on ${futureDate} at 11:00 AM`);

    // Verify stored fields in Atlas
    const savedAppt = await Appointment.findById(testAppointmentId1);
    assert.strictEqual(savedAppt.patientId.toString(), patientSai._id.toString());
    assert.strictEqual(savedAppt.doctorId.toString(), doctorHema._id.toString());
    assert.strictEqual(savedAppt.status, "Scheduled");
    assert.strictEqual(savedAppt.reason, "Severe migraine and neck stiffness");
    console.log("✔ Appointment verified in Atlas with correct patientId, doctorId, and reason.");

    // 8. Test Step 5: Doctor authorized workflow actions (Confirm, Start, Complete)
    console.log("\n[7/8] Testing Doctor status transitions (Confirm -> In Progress -> Complete)...");
    
    // 8a. Doctor Confirms
    const confirmRes = await request(
      "PUT",
      `/api/appointments/${testAppointmentId1}`,
      { status: "Confirmed" },
      doctorToken
    );
    assert.strictEqual(confirmRes.status, 200, "Doctor must be able to confirm");
    assert.strictEqual(confirmRes.data.appointment.status, "Confirmed");
    console.log("  ✔ Step 5a: Doctor set status to 'Confirmed'");

    // 8b. Doctor Starts Visit
    const startRes = await request(
      "PUT",
      `/api/appointments/${testAppointmentId1}`,
      { status: "In Progress" },
      doctorToken
    );
    assert.strictEqual(startRes.status, 200, "Doctor must be able to start consultation");
    assert.strictEqual(startRes.data.appointment.status, "In Progress");
    console.log("  ✔ Step 5b: Doctor set status to 'In Progress'");

    // 8c. Doctor Completes Visit
    const completeRes = await request(
      "PUT",
      `/api/appointments/${testAppointmentId1}`,
      { status: "Completed" },
      doctorToken
    );
    assert.strictEqual(completeRes.status, 200, "Doctor must be able to complete consultation");
    assert.strictEqual(completeRes.data.appointment.status, "Completed");
    console.log("  ✔ Step 5c: Doctor set status to 'Completed'");

    // 8d. Patient cannot perform clinician status changes
    const patientIllegalUpdate = await request(
      "PUT",
      `/api/appointments/${testAppointmentId1}`,
      { status: "Confirmed" },
      patientToken
    );
    // Patient attempting to change status back to Confirmed is rejected or ignored
    const checkAppt = await Appointment.findById(testAppointmentId1);
    assert.strictEqual(
      checkAppt.status,
      "Completed",
      "Patient cannot override clinician status transitions"
    );
    console.log("  ✔ Step 5d: Patient attempt to override clinician status is prevented");

    // 9. Test Step 6: Doctor Rejection Workflow
    console.log("\n[8/8] Testing Doctor Rejection & Reschedule Workflow...");
    const bookRes2 = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: doctorHema._id.toString(),
        appointmentDate: getFutureDateString(14),
        timeSlot: "02:00 PM",
        consultationType: "Video / Online",
        notes: "Routine follow-up",
        reason: "Routine follow-up",
      },
      patientToken
    );
    assert.strictEqual(bookRes2.status, 201);
    testAppointmentId2 = bookRes2.data.appointment._id;

    const rejectRes = await request(
      "PUT",
      `/api/appointments/${testAppointmentId2}`,
      {
        status: "Rejected",
        rejectionReason: "Emergency orthopedic surgery scheduled during this time slot.",
      },
      doctorToken
    );
    assert.strictEqual(rejectRes.status, 200);
    assert.strictEqual(rejectRes.data.appointment.status, "Rejected");
    assert.strictEqual(
      rejectRes.data.appointment.rejectionReason,
      "Emergency orthopedic surgery scheduled during this time slot."
    );
    console.log("✔ Doctor successfully rejected consultation with explanation note.");

    console.log("\n=================================================");
    console.log("  ALL 8 ROLE SEPARATION TESTS PASSED 100%!       ");
    console.log("=================================================");
  } finally {
    // Clean up test appointments created during this test
    if (testAppointmentId1) {
      await Appointment.findByIdAndDelete(testAppointmentId1);
      console.log(`Cleaned up test appointment ${testAppointmentId1}`);
    }
    if (testAppointmentId2) {
      await Appointment.findByIdAndDelete(testAppointmentId2);
      console.log(`Cleaned up test appointment ${testAppointmentId2}`);
    }

    // Verify existing appointment 6ad1b99fb2d9e2cca3547d3d remains intact
    const originalAppt = await Appointment.findById("6ad1b99fb2d9e2cca3547d3d");
    if (originalAppt) {
      console.log(`✔ Verified permanent production appointment 6ad1b99fb2d9e2cca3547d3d preserved.`);
    }

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await mongoose.connection.close();
    console.log("✔ Closed server and Atlas connection cleanly.");
  }
};

runRoleSeparationVerification().catch((err) => {
  console.error("❌ Role Separation Verification failed:", err);
  process.exit(1);
});
