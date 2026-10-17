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

const getFutureDateString = (daysAhead = 10) => {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

// Mirror frontend isAppointmentCancellable helper logic
const isAppointmentCancellable = (app) => {
  if (!app) return false;
  const status = String(app.status || "").trim().toUpperCase();
  if (status !== "SCHEDULED" && status !== "CONFIRMED") {
    return false;
  }
  return true;
};

const runComprehensiveE2E = async () => {
  console.log("======================================================================");
  console.log("   Vaidyasthana: Comprehensive Role Separation & Workflow E2E Test   ");
  console.log("======================================================================");

  // 1. Connect to Atlas
  console.log("\n[1/9] Connecting to MongoDB Atlas...");
  await connectDB();
  assert.ok(mongoose.connection.readyState === 1, "Must be connected to Atlas");
  console.log("✔ Connected to Atlas successfully.");

  // 2. Start HTTP Server
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`✔ Test server listening on ${baseUrl}`);

  let testPatient;
  let testDoctorHema;
  let testDoctorEmpty;
  let bookedAppointmentId;

  try {
    // 3. Locate or create test accounts in MongoDB Atlas
    console.log("\n[2/9] Setting up verified accounts in Atlas...");
    const hashedPassword = await bcrypt.hash("TestPass@123", 10);

    // Patient
    testPatient = await User.findOne({ email: "sai@vaidyasthana.com" });
    if (!testPatient) {
      testPatient = await User.create({
        name: "Sai Patient",
        email: "sai@vaidyasthana.com",
        password: hashedPassword,
        phoneNumber: "+919876543210",
        address: "42 MG Road, Bengaluru",
        role: "patient",
      });
    } else {
      testPatient.phoneNumber = "+919876543210";
      testPatient.address = "42 MG Road, Bengaluru";
      await testPatient.save();
    }
    console.log(`✔ Patient: ${testPatient.name} (${testPatient._id})`);

    // Doctor Hema (verified)
    testDoctorHema = await User.findOne({ email: "hema@vaidyasthana.com" });
    if (!testDoctorHema) {
      testDoctorHema = await User.create({
        name: "Dr. Hema",
        email: "hema@vaidyasthana.com",
        password: hashedPassword,
        phoneNumber: "+919876543211",
        address: "Hospital Road, Bengaluru",
        role: "doctor",
        specialization: "Cardiology",
        medicalRegistrationNumber: "MCI-CARD-HEMA-101",
        verificationStatus: "verified",
      });
    } else {
      testDoctorHema.role = "doctor";
      testDoctorHema.verificationStatus = "verified";
      testDoctorHema.specialization = testDoctorHema.specialization || "Cardiology";
      await testDoctorHema.save();
    }
    console.log(`✔ Doctor 1 (Dr. Hema): ${testDoctorHema.name} (${testDoctorHema._id})`);

    // Doctor Empty (verified, zero appointments)
    testDoctorEmpty = await User.findOne({ email: "dr_empty_isolated@vaidyasthana.com" });
    if (!testDoctorEmpty) {
      testDoctorEmpty = await User.create({
        name: "Dr. Empty Schedule",
        email: "dr_empty_isolated@vaidyasthana.com",
        password: hashedPassword,
        phoneNumber: "+919876543299",
        address: "Apollo Clinic, Bengaluru",
        role: "doctor",
        specialization: "Dermatology",
        medicalRegistrationNumber: "MCI-DERM-EMPTY-999",
        verificationStatus: "verified",
      });
    } else {
      testDoctorEmpty.role = "doctor";
      testDoctorEmpty.verificationStatus = "verified";
      await testDoctorEmpty.save();
    }
    // Clean any accidental appointments for Doctor Empty
    await Appointment.deleteMany({ doctorId: testDoctorEmpty._id });
    console.log(`✔ Doctor 2 (Empty): ${testDoctorEmpty.name} (${testDoctorEmpty._id})`);

    const patientToken = createToken(testPatient);
    const doctorHemaToken = createToken(testDoctorHema);
    const doctorEmptyToken = createToken(testDoctorEmpty);

    // Clean previous appointments between patient and Dr. Hema for pristine test run
    await Appointment.deleteMany({
      patientId: testPatient._id,
      doctorId: testDoctorHema._id,
    });

    // 4. Step 1: Patient books appointment with Dr. Hema
    console.log("\n[3/9] Step 1: Patient books appointment with Dr. Hema...");
    const targetDate = getFutureDateString(10);
    const bookRes = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: testDoctorHema._id.toString(),
        appointmentDate: targetDate,
        timeSlot: "11:30 AM - 12:00 PM",
        consultationType: "In-Person",
        reason: "Cardiac health follow-up and clinical checkup",
      },
      patientToken
    );

    assert.strictEqual(bookRes.status, 201, `Booking should succeed with 201: ${JSON.stringify(bookRes.data)}`);
    assert.strictEqual(bookRes.data.appointment.status, "Scheduled");
    bookedAppointmentId = bookRes.data.appointment._id;
    console.log(`✔ Appointment created with status: "Scheduled" (ID: ${bookedAppointmentId})`);

    // Patient views appointments list
    const patientAppsRes = await request("GET", "/api/appointments", null, patientToken);
    assert.strictEqual(patientAppsRes.status, 200);
    const patientApp = patientAppsRes.data.appointments.find((a) => a._id.toString() === bookedAppointmentId.toString());
    assert.ok(patientApp, "Booked appointment must appear in patient's list");
    assert.strictEqual(patientApp.status, "Scheduled");
    assert.strictEqual(isAppointmentCancellable(patientApp), true, "Scheduled appointment MUST be cancellable in patient UI");
    console.log("✔ Patient list shows appointment as 'Scheduled' with cancellation button active.");

    // 5. Step 2: Doctor login (Dr. Hema) sees assigned appointment, NO booking button
    console.log("\n[4/9] Step 2: Dr. Hema retrieves consultations & verifies doctor isolation...");
    const doctorAppsRes = await request("GET", "/api/appointments", null, doctorHemaToken);
    assert.strictEqual(doctorAppsRes.status, 200);
    const doctorApp = doctorAppsRes.data.appointments.find((a) => a._id.toString() === bookedAppointmentId.toString());
    assert.ok(doctorApp, "Appointment must appear in Dr. Hema's assigned consultations");
    assert.strictEqual(doctorApp.patientName, testPatient.name);
    assert.strictEqual(doctorApp.status, "Scheduled");
    console.log(`✔ Dr. Hema sees assigned consultation for patient '${doctorApp.patientName}' with action: 'Confirm'`);

    // Verify doctor cannot self-book or book appointments
    const doctorSelfBookRes = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: testDoctorHema._id.toString(),
        appointmentDate: targetDate,
        timeSlot: "02:00 PM - 02:30 PM",
      },
      doctorHemaToken
    );
    assert.strictEqual(doctorSelfBookRes.status, 403, "Doctor role must be forbidden from booking appointments");
    console.log("✔ Backend enforces role guard: Doctor cannot book appointments (403 Forbidden).");

    // 6. Step 3: Doctor confirms appointment
    console.log("\n[5/9] Step 3: Dr. Hema confirms the appointment...");
    const confirmRes = await request(
      "PUT",
      `/api/appointments/${bookedAppointmentId}`,
      { status: "Confirmed" },
      doctorHemaToken
    );
    assert.strictEqual(confirmRes.status, 200);
    assert.strictEqual(confirmRes.data.appointment.status, "Confirmed");
    console.log("✔ Appointment status updated to 'Confirmed'.");

    // 7. Step 4: Doctor starts visit ('In Progress') and completes visit ('Completed')
    console.log("\n[6/9] Step 4: Dr. Hema starts and completes clinical consultation...");
    const inProgressRes = await request(
      "PUT",
      `/api/appointments/${bookedAppointmentId}`,
      { status: "In Progress" },
      doctorHemaToken
    );
    assert.strictEqual(inProgressRes.status, 200);
    assert.strictEqual(inProgressRes.data.appointment.status, "In Progress");

    const completeRes = await request(
      "PUT",
      `/api/appointments/${bookedAppointmentId}`,
      { status: "Completed" },
      doctorHemaToken
    );
    assert.strictEqual(completeRes.status, 200);
    assert.strictEqual(completeRes.data.appointment.status, "Completed");
    console.log("✔ Appointment status updated to 'Completed' in MongoDB Atlas.");

    // 8. Step 5: Patient refreshes / views appointment -> Completed & Cancellation GONE
    console.log("\n[7/9] Step 5: Patient views appointment -> status Completed & cancellation GONE...");
    const patientRefreshedRes = await request("GET", "/api/appointments", null, patientToken);
    const refreshedApp = patientRefreshedRes.data.appointments.find((a) => a._id.toString() === bookedAppointmentId.toString());
    assert.ok(refreshedApp);
    assert.strictEqual(refreshedApp.status, "Completed");
    assert.strictEqual(isAppointmentCancellable(refreshedApp), false, "Completed appointment MUST NOT be cancellable");
    console.log("✔ Patient view confirms: status is 'Completed' and 'Cancel Appointment' button is GONE.");

    // 9. Step 6: Patient attempts direct API cancellation -> Rejected with 400 Bad Request
    console.log("\n[8/9] Step 6: Direct API cancellation attempt on Completed appointment...");
    const cancelPutRes = await request(
      "PUT",
      `/api/appointments/${bookedAppointmentId}`,
      { status: "Cancelled", cancellationReason: "I don't need this anymore" },
      patientToken
    );
    assert.strictEqual(cancelPutRes.status, 400, "PUT cancellation of Completed appointment must return 400 Bad Request");
    console.log(`✔ PUT /api/appointments/:id rejected with 400: "${cancelPutRes.data.message}"`);

    const cancelDeleteRes = await request(
      "DELETE",
      `/api/appointments/${bookedAppointmentId}`,
      null,
      patientToken
    );
    assert.strictEqual(cancelDeleteRes.status, 400, "DELETE cancellation of Completed appointment must return 400 Bad Request");
    console.log(`✔ DELETE /api/appointments/:id rejected with 400: "${cancelDeleteRes.data.message}"`);

    // 10. Step 7: Doctor dashboard Quick Patient Selector shows the patient with actual MongoDB _id
    console.log("\n[9/9] Step 7 & 8: Doctor Patient Selector and isolation verification...");
    const docHemaPatientsRes = await request("GET", "/api/doctor/patients", null, doctorHemaToken);
    assert.strictEqual(docHemaPatientsRes.status, 200);
    const associatedPat = docHemaPatientsRes.data.patients.find((p) => p._id.toString() === testPatient._id.toString());
    assert.ok(associatedPat, "Dr. Hema's patient list must include the associated patient");
    assert.strictEqual(associatedPat.name, testPatient.name);
    assert.strictEqual(associatedPat._id, testPatient._id.toString());
    console.log(`✔ Dr. Hema's Quick Patient Selector correctly includes: '${associatedPat.name}' (ID: ${associatedPat._id})`);

    // Step 8: Log in as Doctor Empty (no appointments)
    const docEmptyAppsRes = await request("GET", "/api/appointments", null, doctorEmptyToken);
    assert.strictEqual(docEmptyAppsRes.status, 200);
    assert.strictEqual(docEmptyAppsRes.data.appointments.length, 0, "Doctor with no appointments must see empty consultations");

    const docEmptyPatientsRes = await request("GET", "/api/doctor/patients", null, doctorEmptyToken);
    assert.strictEqual(docEmptyPatientsRes.status, 200);
    assert.strictEqual(docEmptyPatientsRes.data.patients.length, 0, "Doctor with no appointments must see empty patient selector");
    console.log("✔ Doctor with no appointments sees empty consultations ([]) and empty patient selector ([]).");

    console.log("\n======================================================================");
    console.log("   ALL 8 END-TO-END VERIFICATION STEPS PASSED WITH 100% SUCCESS!     ");
    console.log("======================================================================");
  } finally {
    if (server) {
      server.close();
    }
    if (bookedAppointmentId) {
      // Clean up test appointment
      await Appointment.deleteOne({ _id: bookedAppointmentId });
    }
    await mongoose.connection.close();
    console.log("✔ Test cleaned up and database connection closed cleanly.");
  }
};

runComprehensiveE2E().catch((err) => {
  console.error("❌ E2E VERIFICATION FAILED:", err);
  process.exit(1);
});
