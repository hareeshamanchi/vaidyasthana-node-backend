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

const getDateStringOffset = (daysOffset) => {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

// Simulation of frontend helper
const checkIsPastFrontend = (appointmentDate, timeSlot) => {
  if (!appointmentDate) return false;
  const d = new Date(appointmentDate);
  if (isNaN(d.getTime())) return false;

  const now = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();

  const apptLocalMidnight = new Date(y, m, day, 0, 0, 0, 0).getTime();
  const todayLocalMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();

  if (apptLocalMidnight < todayLocalMidnight) {
    return true;
  }

  if (apptLocalMidnight === todayLocalMidnight && timeSlot) {
    const slotStartStr = String(timeSlot).split("-")[0]?.trim();
    const match = slotStartStr?.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (match) {
      let hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2], 10);
      const modifier = match[3].toUpperCase();
      if (modifier === "PM" && hours < 12) hours += 12;
      if (modifier === "AM" && hours === 12) hours = 0;
      const slotTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
      if (slotTime.getTime() <= now.getTime()) {
        return true;
      }
    }
  }

  return false;
};

const isAppointmentCancellableFrontend = (app) => {
  if (!app) return false;
  const status = String(app.status || "").trim().toUpperCase();
  if (status !== "SCHEDULED" && status !== "CONFIRMED") {
    return false;
  }
  if (checkIsPastFrontend(app.appointmentDate, app.timeSlot)) {
    return false;
  }
  return true;
};

const runCancellationRulesVerification = async () => {
  console.log("==========================================================================");
  console.log("  Vaidyasthana: Global Appointment Cancellation Rules E2E Verification    ");
  console.log("==========================================================================\n");

  // Step 1: Connect to Atlas
  console.log("[1/6] Connecting to MongoDB Atlas...");
  const conn = await connectDB();
  assert(conn, "Database connection must succeed");
  console.log(`✔ Connected to Atlas host: ${conn.connection.host}`);
  console.log(`✔ Database: ${conn.connection.name}`);
  assert.strictEqual(conn.connection.name, "vaidyasthana", "Database must be vaidyasthana");

  // Step 2: Spin up test HTTP server
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`✔ Test HTTP server active on ${baseUrl}\n`);
      resolve();
    });
  });

  const ts = Date.now();
  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash("Password123!", salt);

  const createdUserIds = [];
  const createdAppointmentIds = [];

  try {
    // Step 3: Create Dynamic Test Accounts
    console.log("[2/6] Creating test accounts in MongoDB Atlas...");

    const doctorUser = await User.create({
      name: `Dr. CancelTest Doc ${ts}`,
      email: `cancel_doc_${ts}@hospital.test`,
      password: hashedPassword,
      role: "doctor",
      specialization: "General Medicine",
      hospitalAffiliation: "City Hospital",
      verificationStatus: "verified",
      availableSlots: ["09:00 AM - 09:30 AM", "10:00 AM - 10:30 AM", "11:00 AM - 11:30 AM", "02:00 PM - 02:30 PM", "03:00 PM - 03:30 PM", "04:00 PM - 04:30 PM"],
    });
    createdUserIds.push(doctorUser._id);

    const patientOwner = await User.create({
      name: `Patient Owner ${ts}`,
      email: `pat_owner_${ts}@patient.test`,
      password: hashedPassword,
      role: "patient",
      phoneNumber: `+9198701${String(ts).slice(-5)}`,
      address: "101 Main Boulevard",
    });
    createdUserIds.push(patientOwner._id);

    const patientStranger = await User.create({
      name: `Patient Stranger ${ts}`,
      email: `pat_stranger_${ts}@patient.test`,
      password: hashedPassword,
      role: "patient",
      phoneNumber: `+9198702${String(ts).slice(-5)}`,
      address: "202 Side Street",
    });
    createdUserIds.push(patientStranger._id);

    const doctorStranger = await User.create({
      name: `Dr. Stranger Doc ${ts}`,
      email: `dr_stranger_${ts}@hospital.test`,
      password: hashedPassword,
      role: "doctor",
      specialization: "Pediatrics",
      hospitalAffiliation: "Pediatric Care Center",
      verificationStatus: "verified",
    });
    createdUserIds.push(doctorStranger._id);

    console.log(`  ✔ Doctor created:           ${doctorUser.name} (${doctorUser._id})`);
    console.log(`  ✔ Patient Owner created:    ${patientOwner.name} (${patientOwner._id})`);
    console.log(`  ✔ Patient Stranger created: ${patientStranger.name} (${patientStranger._id})`);
    console.log(`  ✔ Doctor Stranger created:  ${doctorStranger.name} (${doctorStranger._id})`);

    const doctorToken = createToken(doctorUser);
    const patientOwnerToken = createToken(patientOwner);
    const patientStrangerToken = createToken(patientStranger);
    const doctorStrangerToken = createToken(doctorStranger);

    // Step 4: Create Appointments across all lifecycle stages and dates
    console.log("\n[3/6] Setting up appointment test fixtures across all lifecycle statuses...");
    const futureDate1 = getDateStringOffset(7);
    const futureDate2 = getDateStringOffset(14);
    const pastDate = getDateStringOffset(-3);

    // 1. Completed Consultation (Future or past, already marked completed)
    const apptCompleted = await Appointment.create({
      patientId: patientOwner._id,
      doctorId: doctorUser._id,
      patientName: patientOwner.name,
      patientEmail: patientOwner.email,
      doctorName: doctorUser.name,
      appointmentDate: new Date(futureDate1),
      timeSlot: "09:00 AM - 09:30 AM",
      status: "Completed",
      reason: "Post-surgery evaluation completed",
    });
    createdAppointmentIds.push(apptCompleted._id);

    // 2. Already Cancelled Consultation
    const apptCancelled = await Appointment.create({
      patientId: patientOwner._id,
      doctorId: doctorUser._id,
      patientName: patientOwner.name,
      patientEmail: patientOwner.email,
      doctorName: doctorUser.name,
      appointmentDate: new Date(futureDate1),
      timeSlot: "10:00 AM - 10:30 AM",
      status: "Cancelled",
      cancellationReason: "Previous patient cancellation",
      reason: "General consultation",
    });
    createdAppointmentIds.push(apptCancelled._id);

    // 3. Rejected Consultation
    const apptRejected = await Appointment.create({
      patientId: patientOwner._id,
      doctorId: doctorUser._id,
      patientName: patientOwner.name,
      patientEmail: patientOwner.email,
      doctorName: doctorUser.name,
      appointmentDate: new Date(futureDate1),
      timeSlot: "11:00 AM - 11:30 AM",
      status: "Rejected",
      rejectionReason: "Doctor out of station on emergency",
      reason: "Follow-up consultation",
    });
    createdAppointmentIds.push(apptRejected._id);

    // 4. Past Appointment (Date in the past, status still Scheduled)
    const apptPast = await Appointment.create({
      patientId: patientOwner._id,
      doctorId: doctorUser._id,
      patientName: patientOwner.name,
      patientEmail: patientOwner.email,
      doctorName: doctorUser.name,
      appointmentDate: new Date(pastDate),
      timeSlot: "02:00 PM - 02:30 PM",
      status: "Scheduled",
      reason: "Lapsed checkup",
    });
    createdAppointmentIds.push(apptPast._id);

    // 5. Eligible Future Scheduled Appointment
    const apptScheduled = await Appointment.create({
      patientId: patientOwner._id,
      doctorId: doctorUser._id,
      patientName: patientOwner.name,
      patientEmail: patientOwner.email,
      doctorName: doctorUser.name,
      appointmentDate: new Date(futureDate2),
      timeSlot: "03:00 PM - 03:30 PM",
      status: "Scheduled",
      reason: "Future checkup candidate for cancellation",
    });
    createdAppointmentIds.push(apptScheduled._id);

    // 6. Eligible Future Confirmed Appointment
    const apptConfirmed = await Appointment.create({
      patientId: patientOwner._id,
      doctorId: doctorUser._id,
      patientName: patientOwner.name,
      patientEmail: patientOwner.email,
      doctorName: doctorUser.name,
      appointmentDate: new Date(futureDate2),
      timeSlot: "04:00 PM - 04:30 PM",
      status: "Confirmed",
      reason: "Confirmed future consultation candidate for cancellation",
    });
    createdAppointmentIds.push(apptConfirmed._id);

    console.log("  ✔ Appt 1 [COMPLETED]: " + apptCompleted._id);
    console.log("  ✔ Appt 2 [CANCELLED]: " + apptCancelled._id);
    console.log("  ✔ Appt 3 [REJECTED]:  " + apptRejected._id);
    console.log("  ✔ Appt 4 [PAST]:      " + apptPast._id + " (" + pastDate + ")");
    console.log("  ✔ Appt 5 [SCHEDULED]: " + apptScheduled._id + " (" + futureDate2 + ")");
    console.log("  ✔ Appt 6 [CONFIRMED]: " + apptConfirmed._id + " (" + futureDate2 + ")");

    // =========================================================================
    // TEST SECTION 1: Backend Cancellation Rejections for Ineligible Consultations
    // =========================================================================
    console.log("\n[4/6] Testing Backend Cancellation API Validation & Rejections...");

    // 1.1 Completed appointment rejection (PUT /api/appointments/:id)
    const cancelCompletedPut = await request(
      "PUT",
      `/api/appointments/${apptCompleted._id}`,
      { status: "Cancelled" },
      patientOwnerToken
    );
    assert.strictEqual(cancelCompletedPut.status, 400, "Cancelling a COMPLETED appointment via PUT must return 400 Bad Request");
    assert.strictEqual(cancelCompletedPut.data.success, false);
    assert.ok(cancelCompletedPut.data.message.includes("completed"));
    console.log("  ✔ Patient PUT cancel on COMPLETED appointment rejected with 400 Bad Request: " + cancelCompletedPut.data.message);

    // 1.2 Completed appointment rejection (DELETE /api/appointments/:id)
    const cancelCompletedDel = await request(
      "DELETE",
      `/api/appointments/${apptCompleted._id}`,
      null,
      patientOwnerToken
    );
    assert.strictEqual(cancelCompletedDel.status, 400, "Cancelling a COMPLETED appointment via DELETE must return 400 Bad Request");
    assert.strictEqual(cancelCompletedDel.data.success, false);
    console.log("  ✔ Patient DELETE cancel on COMPLETED appointment rejected with 400 Bad Request");

    // 1.3 Cancelled appointment rejection (PUT & DELETE)
    const cancelCancelledPut = await request(
      "PUT",
      `/api/appointments/${apptCancelled._id}`,
      { status: "Cancelled" },
      patientOwnerToken
    );
    assert.strictEqual(cancelCancelledPut.status, 400);
    assert.ok(cancelCancelledPut.data.message.includes("already cancelled"));
    console.log("  ✔ Patient PUT cancel on already CANCELLED appointment rejected with 400: " + cancelCancelledPut.data.message);

    const cancelCancelledDel = await request(
      "DELETE",
      `/api/appointments/${apptCancelled._id}`,
      null,
      patientOwnerToken
    );
    assert.strictEqual(cancelCancelledDel.status, 400);
    console.log("  ✔ Patient DELETE cancel on already CANCELLED appointment rejected with 400");

    // 1.4 Rejected appointment rejection (PUT & DELETE)
    const cancelRejectedPut = await request(
      "PUT",
      `/api/appointments/${apptRejected._id}`,
      { status: "Cancelled" },
      patientOwnerToken
    );
    assert.strictEqual(cancelRejectedPut.status, 400);
    assert.ok(cancelRejectedPut.data.message.includes("rejected"));
    console.log("  ✔ Patient PUT cancel on REJECTED appointment rejected with 400: " + cancelRejectedPut.data.message);

    const cancelRejectedDel = await request(
      "DELETE",
      `/api/appointments/${apptRejected._id}`,
      null,
      patientOwnerToken
    );
    assert.strictEqual(cancelRejectedDel.status, 400);
    console.log("  ✔ Patient DELETE cancel on REJECTED appointment rejected with 400");

    // 1.5 Past appointment rejection (PUT & DELETE)
    const cancelPastPut = await request(
      "PUT",
      `/api/appointments/${apptPast._id}`,
      { status: "Cancelled" },
      patientOwnerToken
    );
    assert.strictEqual(cancelPastPut.status, 400, "Cancelling a PAST appointment via PUT must return 400 Bad Request");
    assert.ok(cancelPastPut.data.message.includes("past"));
    console.log("  ✔ Patient PUT cancel on PAST appointment rejected with 400: " + cancelPastPut.data.message);

    const cancelPastDel = await request(
      "DELETE",
      `/api/appointments/${apptPast._id}`,
      null,
      patientOwnerToken
    );
    assert.strictEqual(cancelPastDel.status, 400, "Cancelling a PAST appointment via DELETE must return 400 Bad Request");
    console.log("  ✔ Patient DELETE cancel on PAST appointment rejected with 400: " + cancelPastDel.data.message);

    // =========================================================================
    // TEST SECTION 2: Role Authorization & Boundary Enforcements
    // =========================================================================
    console.log("\n[5/6] Testing Ownership & Role-based Boundary Enforcement...");

    // 2.1 Stranger Patient attempting to cancel Patient Owner's appointment -> 403 Forbidden
    const strangerCancelPut = await request(
      "PUT",
      `/api/appointments/${apptScheduled._id}`,
      { status: "Cancelled" },
      patientStrangerToken
    );
    assert.strictEqual(strangerCancelPut.status, 403, "Stranger patient cannot cancel another patient's appointment");
    console.log("  ✔ Stranger patient PUT cancel rejected with 403 Forbidden");

    const strangerCancelDel = await request(
      "DELETE",
      `/api/appointments/${apptScheduled._id}`,
      null,
      patientStrangerToken
    );
    assert.strictEqual(strangerCancelDel.status, 403, "Stranger patient cannot DELETE another patient's appointment");
    console.log("  ✔ Stranger patient DELETE cancel rejected with 403 Forbidden");

    // 2.2 Unassigned Doctor attempting to cancel -> 403 Forbidden
    const strangerDocCancel = await request(
      "PUT",
      `/api/appointments/${apptScheduled._id}`,
      { status: "Cancelled" },
      doctorStrangerToken
    );
    assert.strictEqual(strangerDocCancel.status, 403, "Doctor not assigned to appointment cannot cancel");
    console.log("  ✔ Unassigned doctor cancel rejected with 403 Forbidden");

    // 2.3 Doctor attempting to cancel/reject a COMPLETED consultation -> 400 Bad Request
    const doctorCancelCompleted = await request(
      "PUT",
      `/api/appointments/${apptCompleted._id}`,
      { status: "Cancelled" },
      doctorToken
    );
    assert.strictEqual(doctorCancelCompleted.status, 400);
    assert.ok(doctorCancelCompleted.data.message.includes("completed"));
    console.log("  ✔ Doctor attempt to cancel COMPLETED appointment rejected with 400: " + doctorCancelCompleted.data.message);

    const doctorRejectCompleted = await request(
      "PUT",
      `/api/appointments/${apptCompleted._id}`,
      { status: "Rejected" },
      doctorToken
    );
    assert.strictEqual(doctorRejectCompleted.status, 400);
    console.log("  ✔ Doctor attempt to reject COMPLETED appointment rejected with 400: " + doctorRejectCompleted.data.message);

    // =========================================================================
    // TEST SECTION 3: Successful Cancellation of Eligible Future Appointments
    // =========================================================================
    console.log("\n[6/6] Testing Eligible Future Cancellations & Frontend Logic Verification...");

    // 3.1 Cancel eligible future SCHEDULED appointment
    const validCancelScheduled = await request(
      "PUT",
      `/api/appointments/${apptScheduled._id}`,
      { status: "Cancelled", cancellationReason: "Patient travel schedule change" },
      patientOwnerToken
    );
    assert.strictEqual(validCancelScheduled.status, 200, "Eligible scheduled appointment must cancel with 200 OK");
    assert.strictEqual(validCancelScheduled.data.success, true);
    assert.strictEqual(validCancelScheduled.data.appointment.status, "Cancelled");
    console.log("  ✔ Patient successfully cancelled future SCHEDULED appointment (200 OK)");

    // Verify in Atlas database
    const dbApptScheduled = await Appointment.findById(apptScheduled._id);
    assert.strictEqual(dbApptScheduled.status, "Cancelled");
    assert.strictEqual(dbApptScheduled.cancellationReason, "Patient travel schedule change");
    console.log("  ✔ Verified in MongoDB Atlas: Status = 'Cancelled', Reason saved.");

    // Attempting to cancel it a second time is now rejected with 400
    const cancelAgain = await request(
      "PUT",
      `/api/appointments/${apptScheduled._id}`,
      { status: "Cancelled" },
      patientOwnerToken
    );
    assert.strictEqual(cancelAgain.status, 400);
    assert.ok(cancelAgain.data.message.includes("already cancelled"));
    console.log("  ✔ Re-cancelling previously cancelled appointment rejected with 400");

    // 3.2 Cancel eligible future CONFIRMED appointment
    const validCancelConfirmed = await request(
      "PUT",
      `/api/appointments/${apptConfirmed._id}`,
      { status: "Cancelled", cancellationReason: "Personal emergency" },
      patientOwnerToken
    );
    assert.strictEqual(validCancelConfirmed.status, 200, "Eligible confirmed appointment must cancel with 200 OK");
    assert.strictEqual(validCancelConfirmed.data.success, true);
    assert.strictEqual(validCancelConfirmed.data.appointment.status, "Cancelled");
    console.log("  ✔ Patient successfully cancelled future CONFIRMED appointment (200 OK)");

    const dbApptConfirmed = await Appointment.findById(apptConfirmed._id);
    assert.strictEqual(dbApptConfirmed.status, "Cancelled");
    console.log("  ✔ Verified in MongoDB Atlas: Status = 'Cancelled'");

    // 3.3 Verify Frontend Helper Logic Across All Test Consultations
    console.log("\n  --- Verifying Frontend isAppointmentCancellable Logic ---");
    assert.strictEqual(
      isAppointmentCancellableFrontend(apptCompleted),
      false,
      "Completed appointment must NOT be cancellable on frontend (button hidden)"
    );
    console.log("  ✔ Frontend check: COMPLETED appointment -> isCancellable = false (Button Hidden)");

    assert.strictEqual(
      isAppointmentCancellableFrontend(apptCancelled),
      false,
      "Cancelled appointment must NOT be cancellable on frontend (button hidden)"
    );
    console.log("  ✔ Frontend check: CANCELLED appointment -> isCancellable = false (Button Hidden)");

    assert.strictEqual(
      isAppointmentCancellableFrontend(apptRejected),
      false,
      "Rejected appointment must NOT be cancellable on frontend (button hidden)"
    );
    console.log("  ✔ Frontend check: REJECTED appointment  -> isCancellable = false (Button Hidden)");

    assert.strictEqual(
      isAppointmentCancellableFrontend(apptPast),
      false,
      "Past appointment must NOT be cancellable on frontend (button hidden)"
    );
    console.log("  ✔ Frontend check: PAST appointment      -> isCancellable = false (Button Hidden)");

    assert.strictEqual(
      isAppointmentCancellableFrontend(dbApptScheduled),
      false,
      "Now-cancelled appointment must NOT be cancellable on frontend after refresh"
    );
    console.log("  ✔ Frontend check: Now-cancelled appt   -> isCancellable = false (Button Hidden on refresh)");

    const futureScheduledFresh = {
      appointmentDate: new Date(getDateStringOffset(10)),
      timeSlot: "10:00 AM - 10:30 AM",
      status: "Scheduled",
    };
    assert.strictEqual(
      isAppointmentCancellableFrontend(futureScheduledFresh),
      true,
      "Future scheduled appointment MUST be cancellable on frontend (button displayed)"
    );
    console.log("  ✔ Frontend check: Future SCHEDULED appt -> isCancellable = true (Button Displayed)");

    const futureConfirmedFresh = {
      appointmentDate: new Date(getDateStringOffset(10)),
      timeSlot: "11:00 AM - 11:30 AM",
      status: "Confirmed",
    };
    assert.strictEqual(
      isAppointmentCancellableFrontend(futureConfirmedFresh),
      true,
      "Future confirmed appointment MUST be cancellable on frontend (button displayed)"
    );
    console.log("  ✔ Frontend check: Future CONFIRMED appt -> isCancellable = true (Button Displayed)");

    console.log("\n==========================================================================");
    console.log("  ALL TESTS PASSED: CANCELLATION RULES & ENFORCEMENT 100% VERIFIED!       ");
    console.log("==========================================================================");
  } finally {
    console.log("\n[Clean Up] Cleaning up dynamic test fixtures in MongoDB Atlas...");
    try {
      if (createdAppointmentIds.length > 0) {
        const appRes = await Appointment.deleteMany({ _id: { $in: createdAppointmentIds } });
        console.log(`  ✔ Deleted ${appRes.deletedCount} temporary test appointment(s).`);
      }
      if (createdUserIds.length > 0) {
        const userRes = await User.deleteMany({ _id: { $in: createdUserIds } });
        console.log(`  ✔ Deleted ${userRes.deletedCount} temporary test user(s).`);
      }
    } catch (cleanupErr) {
      console.warn("⚠️ Warning during test fixture cleanup:", cleanupErr);
    }

    if (server) {
      await new Promise((resolve) => server.close(resolve));
      console.log("✔ Test server closed.");
    }
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
      console.log("✔ Disconnected cleanly from MongoDB Atlas.");
    }
  }
};

runCancellationRulesVerification()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ Verification Failed:", err);
    process.exit(1);
  });
