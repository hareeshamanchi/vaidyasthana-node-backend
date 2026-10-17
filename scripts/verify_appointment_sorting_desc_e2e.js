const assert = require("node:assert");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
require("dotenv").config({ path: __dirname + "/../.env" });

const app = require("../src/app");
const User = require("../src/models/User");
const Appointment = require("../src/models/Appointment");
const connectDB = require("../src/config/db");
const { sortAppointmentsDesc } = require("../src/utils/appointmentSorting");

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

const runSortingVerificationE2E = async () => {
  console.log("==========================================================================");
  console.log("   Vaidyasthana: Global Appointment Descending Sorting E2E Test Suite    ");
  console.log("==========================================================================");

  // 1. Connect to Atlas
  console.log("\n[1/7] Connecting to MongoDB Atlas...");
  await connectDB();
  assert.ok(mongoose.connection.readyState === 1, "Must be connected to Atlas");
  console.log("✔ Connected to Atlas successfully.");

  // 2. Start Test Server
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`✔ Test server listening on ${baseUrl}`);

  const createdApptIds = [];

  try {
    // 3. Locate or create test accounts in Atlas
    console.log("\n[2/7] Loading test accounts from Atlas...");
    const hashedPassword = await bcrypt.hash("TestPass@123", 10);

    let patient = await User.findOne({ email: "sai@vaidyasthana.com" });
    if (!patient) {
      patient = await User.create({
        name: "Sai Patient",
        email: "sai@vaidyasthana.com",
        password: hashedPassword,
        phoneNumber: "+919876543210",
        address: "42 MG Road, Bengaluru",
        role: "patient",
      });
    }

    let doctor = await User.findOne({ email: "hema@vaidyasthana.com" });
    if (!doctor) {
      doctor = await User.create({
        name: "Dr. Hema",
        email: "hema@vaidyasthana.com",
        password: hashedPassword,
        phoneNumber: "+919876543211",
        address: "Hospital Road, Bengaluru",
        role: "doctor",
        specialization: "Cardiology",
        medicalRegistrationNumber: "MCI-HEMA-SORT-001",
        verificationStatus: "verified",
      });
    }

    const patientToken = createToken(patient);
    const doctorToken = createToken(doctor);

    // Clean previous appointments between patient and doctor
    await Appointment.deleteMany({
      patientId: patient._id,
      doctorId: doctor._id,
    });
    console.log("✔ Cleaned previous test appointments.");

    // 4. Seed appointments across the exact user example date (2026-10-16) and multiple dates
    console.log("\n[3/7] Seeding test appointments with varying dates, times, and statuses...");
    const sampleFixtures = [
      // Target Example Date: 2026-10-16
      {
        patientId: patient._id,
        doctorId: doctor._id,
        doctorName: doctor.name,
        patientName: patient.name,
        department: doctor.specialization,
        appointmentDate: new Date("2026-10-16T00:00:00.000Z"),
        timeSlot: "03:00 PM - 03:30 PM",
        status: "Cancelled",
        reason: "Patient cancelled due to conflict",
      },
      {
        patientId: patient._id,
        doctorId: doctor._id,
        doctorName: doctor.name,
        patientName: patient.name,
        department: doctor.specialization,
        appointmentDate: new Date("2026-10-16T00:00:00.000Z"),
        timeSlot: "04:00 PM - 04:30 PM",
        status: "Cancelled",
        reason: "Doctor clinic delayed",
      },
      {
        patientId: patient._id,
        doctorId: doctor._id,
        doctorName: doctor.name,
        patientName: patient.name,
        department: doctor.specialization,
        appointmentDate: new Date("2026-10-16T00:00:00.000Z"),
        timeSlot: "04:30 PM - 05:00 PM",
        status: "Scheduled",
        reason: "Cardiac routine evaluation",
      },
      // Additional multi-date fixtures
      {
        patientId: patient._id,
        doctorId: doctor._id,
        doctorName: doctor.name,
        patientName: patient.name,
        department: doctor.specialization,
        appointmentDate: new Date("2026-10-18T00:00:00.000Z"),
        timeSlot: "10:00 AM - 10:30 AM",
        status: "Scheduled",
        reason: "Follow-up consultation",
      },
      {
        patientId: patient._id,
        doctorId: doctor._id,
        doctorName: doctor.name,
        patientName: patient.name,
        department: doctor.specialization,
        appointmentDate: new Date("2026-10-17T00:00:00.000Z"),
        timeSlot: "02:00 PM - 02:30 PM",
        status: "Confirmed",
        reason: "Echocardiogram review",
      },
      {
        patientId: patient._id,
        doctorId: doctor._id,
        doctorName: doctor.name,
        patientName: patient.name,
        department: doctor.specialization,
        appointmentDate: new Date("2026-10-15T00:00:00.000Z"),
        timeSlot: "11:30 AM - 12:00 PM",
        status: "Completed",
        reason: "Preliminary vitals inspection",
      },
    ];

    const seededDocs = await Appointment.insertMany(sampleFixtures);
    seededDocs.forEach((d) => createdApptIds.push(d._id));
    console.log(`✔ Seeded ${seededDocs.length} test appointments into MongoDB Atlas.`);

    // 5. Test Patient View Sorting
    console.log("\n[4/7] Testing Patient appointments retrieval & descending ordering...");
    const patRes = await request("GET", "/api/appointments", null, patientToken);
    assert.strictEqual(patRes.status, 200);
    const patList = patRes.data.appointments;

    // Filter strictly to our created fixtures to isolate test verification
    const filteredPat = patList.filter((a) => createdApptIds.some((id) => id.toString() === a._id.toString()));
    assert.strictEqual(filteredPat.length, sampleFixtures.length);

    console.log("Retrieved Patient Appointments in order:");
    filteredPat.forEach((a, i) => {
      const dateStr = new Date(a.appointmentDate).toISOString().substring(0, 10);
      console.log(`  ${i + 1}. [${dateStr}] ${a.timeSlot} — ${a.status} (Reason: ${a.reason})`);
    });

    // Check Global Descending Order
    const expectedPatDatesAndTimes = [
      { date: "2026-10-18", slot: "10:00 AM - 10:30 AM", status: "Scheduled" },
      { date: "2026-10-17", slot: "02:00 PM - 02:30 PM", status: "Confirmed" },
      { date: "2026-10-16", slot: "04:30 PM - 05:00 PM", status: "Scheduled" },
      { date: "2026-10-16", slot: "04:00 PM - 04:30 PM", status: "Cancelled" },
      { date: "2026-10-16", slot: "03:00 PM - 03:30 PM", status: "Cancelled" },
      { date: "2026-10-15", slot: "11:30 AM - 12:00 PM", status: "Completed" },
    ];

    expectedPatDatesAndTimes.forEach((exp, idx) => {
      const act = filteredPat[idx];
      const actDate = new Date(act.appointmentDate).toISOString().substring(0, 10);
      assert.strictEqual(actDate, exp.date, `Index ${idx} date should be ${exp.date}, got ${actDate}`);
      assert.strictEqual(act.timeSlot, exp.slot, `Index ${idx} timeSlot should be ${exp.slot}, got ${act.timeSlot}`);
      assert.strictEqual(act.status, exp.status, `Index ${idx} status should be ${exp.status}, got ${act.status}`);
    });
    console.log("✔ Patient appointments strictly adhere to descending date and time ordering!");

    // Check specific user example on October 16, 2026
    const oct16Pat = filteredPat.filter((a) => new Date(a.appointmentDate).toISOString().substring(0, 10) === "2026-10-16");
    assert.strictEqual(oct16Pat.length, 3);
    assert.strictEqual(oct16Pat[0].timeSlot, "04:30 PM - 05:00 PM");
    assert.strictEqual(oct16Pat[0].status, "Scheduled");
    assert.strictEqual(oct16Pat[1].timeSlot, "04:00 PM - 04:30 PM");
    assert.strictEqual(oct16Pat[1].status, "Cancelled");
    assert.strictEqual(oct16Pat[2].timeSlot, "03:00 PM - 03:30 PM");
    assert.strictEqual(oct16Pat[2].status, "Cancelled");
    console.log("✔ Verified exact user example for October 16, 2026 (4:30 PM Scheduled > 4:00 PM Cancelled > 3:00 PM Cancelled).");

    // 6. Test Doctor View Sorting
    console.log("\n[5/7] Testing Doctor assigned consultations retrieval & descending ordering...");
    const docRes = await request("GET", "/api/appointments", null, doctorToken);
    assert.strictEqual(docRes.status, 200);
    const docList = docRes.data.appointments;

    const filteredDoc = docList.filter((a) => createdApptIds.some((id) => id.toString() === a._id.toString()));
    assert.strictEqual(filteredDoc.length, sampleFixtures.length);

    console.log("Retrieved Doctor Consultations in order:");
    filteredDoc.forEach((a, i) => {
      const dateStr = new Date(a.appointmentDate).toISOString().substring(0, 10);
      console.log(`  ${i + 1}. [${dateStr}] ${a.timeSlot} — ${a.status} (Patient: ${a.patientName})`);
    });

    expectedPatDatesAndTimes.forEach((exp, idx) => {
      const act = filteredDoc[idx];
      const actDate = new Date(act.appointmentDate).toISOString().substring(0, 10);
      assert.strictEqual(actDate, exp.date);
      assert.strictEqual(act.timeSlot, exp.slot);
      assert.strictEqual(act.status, exp.status);
    });
    console.log("✔ Doctor assigned consultations strictly adhere to identical descending date and time ordering!");

    // 7. Dynamic Actions: booking, cancellation, confirmation, completion
    console.log("\n[6/7] Testing sorting consistency after booking, cancellation, and status transitions...");
    // Book brand new latest appointment on 2026-10-19 at 09:00 AM
    const newBookRes = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: doctor._id.toString(),
        appointmentDate: "2026-10-19",
        timeSlot: "09:00 AM - 09:30 AM",
        consultationType: "In-Person",
        reason: "New latest appointment check",
      },
      patientToken
    );
    assert.strictEqual(newBookRes.status, 201);
    const newApptId = newBookRes.data.appointment._id;
    createdApptIds.push(newApptId);

    // Refresh patient list -> New latest appointment MUST be index 0
    const refreshedPat = await request("GET", "/api/appointments", null, patientToken);
    const postBookApps = refreshedPat.data.appointments.filter((a) => createdApptIds.some((id) => id.toString() === a._id.toString()));
    assert.strictEqual(postBookApps[0]._id.toString(), newApptId.toString(), "New latest appointment on 2026-10-19 must be at top (index 0)");
    console.log(`✔ After booking, 2026-10-19 09:00 AM appears at top (index 0).`);

    // Cancel this new appointment
    const cancelRes = await request(
      "PUT",
      `/api/appointments/${newApptId}`,
      { status: "Cancelled", cancellationReason: "Testing dynamic sort stability" },
      patientToken
    );
    assert.strictEqual(cancelRes.status, 200);

    // Refresh list -> Cancelled appointment MUST still be at top (index 0) because date is latest
    const postCancelPat = await request("GET", "/api/appointments", null, patientToken);
    const postCancelApps = postCancelPat.data.appointments.filter((a) => createdApptIds.some((id) => id.toString() === a._id.toString()));
    assert.strictEqual(postCancelApps[0]._id.toString(), newApptId.toString());
    assert.strictEqual(postCancelApps[0].status, "Cancelled");
    console.log("✔ After cancellation, status updated to 'Cancelled' and sorting position remained stable at top.");

    // Complete the 2026-10-18 appointment
    const oct18Appt = seededDocs.find((d) => d.timeSlot === "10:00 AM - 10:30 AM");
    const completeRes = await request(
      "PUT",
      `/api/appointments/${oct18Appt._id}`,
      { status: "Completed" },
      doctorToken
    );
    assert.strictEqual(completeRes.status, 200);

    // Verify ordering remained intact
    const finalPat = await request("GET", "/api/appointments", null, patientToken);
    const finalApps = finalPat.data.appointments.filter((a) => createdApptIds.some((id) => id.toString() === a._id.toString()));
    assert.strictEqual(finalApps[1]._id.toString(), oct18Appt._id.toString());
    assert.strictEqual(finalApps[1].status, "Completed");
    console.log("✔ After completion, status updated to 'Completed' and sorting position remained completely stable.");

    console.log("\n[7/7] Cleaning up test fixtures in MongoDB Atlas...");
    await Appointment.deleteMany({ _id: { $in: createdApptIds } });
    console.log(`✔ Removed ${createdApptIds.length} test records from Atlas.`);

    console.log("\n==========================================================================");
    console.log("   ALL APPOINTMENT DESCENDING SORTING E2E CHECKS PASSED (100% SUCCESS)!  ");
    console.log("==========================================================================");
  } finally {
    if (server) {
      server.close();
    }
    if (createdApptIds.length > 0) {
      await Appointment.deleteMany({ _id: { $in: createdApptIds } });
    }
    await mongoose.connection.close();
    console.log("✔ Connection closed cleanly.");
  }
};

runSortingVerificationE2E().catch((err) => {
  console.error("❌ SORTING E2E VERIFICATION FAILED:", err);
  process.exit(1);
});
