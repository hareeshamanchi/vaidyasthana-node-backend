require("dotenv").config();
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const app = require("../src/app");
const User = require("../src/models/User");
const Appointment = require("../src/models/Appointment");
const {
  getConsultationWindowState,
  getAppointmentStartAndDeadline,
  isAppointmentExpired,
} = require("../src/utils/consultationWindow");
const {
  isAppointmentUpcoming,
  sortUpcomingAppointments,
  sortPastAppointments,
  partitionAppointments,
  compareAppointmentsAsc,
  compareAppointmentsDesc,
} = require("../src/utils/appointmentSorting");
const { expireStaleAppointments } = require("../src/services/appointmentExpiryService");

let server;
let baseUrl;

let testDoctor;
let testDoctorToken;
let testPatient;
let testPatientToken;
let otherDoctor;
let otherDoctorToken;
let otherPatient;
let otherPatientToken;

const request = async (method, path, body = null, token = null) => {
  const url = `${baseUrl}${path}`;
  const headers = {};

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let reqBody = null;
  if (body) {
    headers["Content-Type"] = "application/json";
    reqBody = JSON.stringify(body);
  }

  const res = await fetch(url, {
    method,
    headers,
    body: reqBody,
  });

  const text = await res.text();
  let parsed;
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

describe("Automatic Appointment Status Updates & Consultation Expiry Suite", () => {
  before(async () => {
    const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/vaidyasthana";
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(mongoUri, { dbName: "vaidyasthana" });
    }

    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    const jwtSecret = process.env.JWT_SECRET || "vaidyasthana_development_jwt_secret_key_32bytes";
    const ts = Date.now();

    testDoctor = await User.create({
      name: "Dr. Lifecycle Specialist",
      email: `dr_lifecycle_${ts}@hospital.test`,
      password: "HashedPassword123!",
      phoneNumber: "+91 9876540001",
      role: "doctor",
      specialization: "Neurology",
      verificationStatus: "verified",
    });
    testDoctorToken = jwt.sign(
      { id: testDoctor._id.toString(), role: "doctor", name: testDoctor.name, email: testDoctor.email },
      jwtSecret,
      { expiresIn: "1h" }
    );

    otherDoctor = await User.create({
      name: "Dr. Another Clinician",
      email: `dr_other_${ts}@hospital.test`,
      password: "HashedPassword123!",
      phoneNumber: "+91 9876540002",
      role: "doctor",
      specialization: "Orthopedics",
      verificationStatus: "verified",
    });
    otherDoctorToken = jwt.sign(
      { id: otherDoctor._id.toString(), role: "doctor", name: otherDoctor.name, email: otherDoctor.email },
      jwtSecret,
      { expiresIn: "1h" }
    );

    testPatient = await User.create({
      name: "Patient Main",
      email: `patient_main_${ts}@test.org`,
      password: "HashedPassword123!",
      phoneNumber: "+91 9123450001",
      role: "patient",
      verificationStatus: "verified",
    });
    testPatientToken = jwt.sign(
      { id: testPatient._id.toString(), role: "patient", name: testPatient.name, email: testPatient.email },
      jwtSecret,
      { expiresIn: "1h" }
    );

    otherPatient = await User.create({
      name: "Patient Intruder",
      email: `patient_intruder_${ts}@test.org`,
      password: "HashedPassword123!",
      phoneNumber: "+91 9123450002",
      role: "patient",
      verificationStatus: "verified",
    });
    otherPatientToken = jwt.sign(
      { id: otherPatient._id.toString(), role: "patient", name: otherPatient.name, email: otherPatient.email },
      jwtSecret,
      { expiresIn: "1h" }
    );
  });

  after(async () => {
    if (testDoctor) await User.deleteOne({ _id: testDoctor._id });
    if (otherDoctor) await User.deleteOne({ _id: otherDoctor._id });
    if (testPatient) await User.deleteOne({ _id: testPatient._id });
    if (otherPatient) await User.deleteOne({ _id: otherPatient._id });

    await Appointment.deleteMany({
      $or: [
        { doctorId: testDoctor?._id },
        { doctorId: otherDoctor?._id },
        { patientId: testPatient?._id },
        { patientId: otherPatient?._id },
      ],
    });

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  // =========================================================================
  // SECTION 1: Deterministic Fake Clock Window & Boundary Verification
  // =========================================================================
  it("1. Controllable clock: Appointment scheduled in the future disables join and shows 'Consultation starts at [time]'", () => {
    const appointmentDate = "2026-10-20";
    const timeSlot = "03:00 PM";
    const timing = getAppointmentStartAndDeadline(appointmentDate, timeSlot);
    assert.ok(timing);

    // Controllable clock: 1 hour BEFORE start
    const fakeNow = timing.startTimeMs - 60 * 60 * 1000;
    const state = getConsultationWindowState(
      {
        appointmentDate,
        timeSlot,
        consultationType: "Video / Online",
        status: "Scheduled",
      },
      fakeNow
    );

    assert.strictEqual(state.status, "BEFORE_START");
    assert.strictEqual(state.canJoin, false);
    assert.strictEqual(state.buttonText, "Consultation starts at 03:00 PM");
    assert.strictEqual(state.badgeText, "Upcoming");
  });

  it("2. Controllable clock: Appointment at scheduled start time enables 'Join Video Consultation'", () => {
    const appointmentDate = "2026-10-20";
    const timeSlot = "03:00 PM";
    const timing = getAppointmentStartAndDeadline(appointmentDate, timeSlot);
    assert.ok(timing);

    // Controllable clock: EXACTLY AT start time (T_now = T_start)
    const fakeNow = timing.startTimeMs;
    const state = getConsultationWindowState(
      {
        appointmentDate,
        timeSlot,
        consultationType: "Video / Online",
        status: "Scheduled",
      },
      fakeNow
    );

    assert.strictEqual(state.status, "JOINABLE");
    assert.strictEqual(state.canJoin, true);
    assert.strictEqual(state.buttonText, "Join Video Consultation");
    assert.strictEqual(state.badgeText, "Available to Join");
  });

  it("3. Controllable clock: Appointment within 30-minute grace period permits joining", () => {
    const appointmentDate = "2026-10-20";
    const timeSlot = "03:00 PM";
    const timing = getAppointmentStartAndDeadline(appointmentDate, timeSlot);
    assert.ok(timing);

    // Controllable clock: 15 minutes into consultation
    const fakeNow = timing.startTimeMs + 15 * 60 * 1000;
    const state = getConsultationWindowState(
      {
        appointmentDate,
        timeSlot,
        consultationType: "Video / Online",
        status: "Scheduled",
      },
      fakeNow
    );

    assert.strictEqual(state.status, "JOINABLE");
    assert.strictEqual(state.canJoin, true);
    assert.strictEqual(state.buttonText, "Join Video Consultation");
  });

  it("4. Controllable clock: Appointment exactly at 30-minute boundary permits joining", () => {
    const appointmentDate = "2026-10-20";
    const timeSlot = "03:00 PM";
    const timing = getAppointmentStartAndDeadline(appointmentDate, timeSlot);
    assert.ok(timing);

    // Controllable clock: EXACTLY AT 30:00 boundary (T_now = T_start + 30m)
    const fakeNow = timing.deadlineMs;
    const state = getConsultationWindowState(
      {
        appointmentDate,
        timeSlot,
        consultationType: "Video / Online",
        status: "Scheduled",
      },
      fakeNow
    );

    assert.strictEqual(state.status, "JOINABLE");
    assert.strictEqual(state.canJoin, true);
  });

  it("5. Controllable clock: Appointment after 30-minute grace period disables button and displays 'Consultation Time Exceeded'", () => {
    const appointmentDate = "2026-10-20";
    const timeSlot = "03:00 PM";
    const timing = getAppointmentStartAndDeadline(appointmentDate, timeSlot);
    assert.ok(timing);

    // Controllable clock: 1 second past deadline (T_now = T_deadline + 1s)
    const fakeNow = timing.deadlineMs + 1000;
    const state = getConsultationWindowState(
      {
        appointmentDate,
        timeSlot,
        consultationType: "Video / Online",
        status: "Scheduled",
      },
      fakeNow
    );

    assert.strictEqual(state.status, "EXPIRED");
    assert.strictEqual(state.canJoin, false);
    assert.strictEqual(state.buttonText, "Consultation Time Exceeded");
    assert.strictEqual(state.badgeText, "Expired");
  });

  it("6. Controllable clock: Cancelled, rejected, and completed appointments cannot be joined even within window", () => {
    const appointmentDate = "2026-10-20";
    const timeSlot = "03:00 PM";
    const timing = getAppointmentStartAndDeadline(appointmentDate, timeSlot);
    const fakeNow = timing.startTimeMs + 10 * 60 * 1000; // Within window

    const cancelledState = getConsultationWindowState(
      { appointmentDate, timeSlot, consultationType: "Video / Online", status: "Cancelled" },
      fakeNow
    );
    assert.strictEqual(cancelledState.canJoin, false);
    assert.strictEqual(cancelledState.buttonText, "Consultation Cancelled");

    const rejectedState = getConsultationWindowState(
      { appointmentDate, timeSlot, consultationType: "Video / Online", status: "Rejected" },
      fakeNow
    );
    assert.strictEqual(rejectedState.canJoin, false);
    assert.strictEqual(rejectedState.buttonText, "Consultation Rejected");

    const completedState = getConsultationWindowState(
      { appointmentDate, timeSlot, consultationType: "Video / Online", status: "Completed" },
      fakeNow
    );
    assert.strictEqual(completedState.canJoin, false);
    assert.strictEqual(completedState.buttonText, "Consultation Completed");
  });

  it("7. Active 'In Progress' consultation is NOT marked expired even after 30-minute joining window", () => {
    const appointmentDate = "2026-10-20";
    const timeSlot = "03:00 PM";
    const timing = getAppointmentStartAndDeadline(appointmentDate, timeSlot);
    const fakeNow = timing.deadlineMs + 45 * 60 * 1000; // 75 minutes after start

    const inProgressState = getConsultationWindowState(
      { appointmentDate, timeSlot, consultationType: "Video / Online", status: "In Progress" },
      fakeNow
    );
    assert.strictEqual(inProgressState.canJoin, true);
    assert.strictEqual(inProgressState.buttonText, "Join Video Consultation");
    assert.strictEqual(inProgressState.badgeText, "In Progress");

    // Also verify isAppointmentExpired returns false
    const expired = isAppointmentExpired(
      { appointmentDate, timeSlot, consultationType: "Video / Online", status: "In Progress" },
      fakeNow
    );
    assert.strictEqual(expired, false);
  });

  // =========================================================================
  // SECTION 2: Sorting and Partitioning Logic
  // =========================================================================
  it("8. Upcoming appointments sorted nearest first (ascending); Past sorted most recent first (descending)", () => {
    const fakeNow = new Date("2026-10-20T12:00:00Z").getTime();

    const sampleAppointments = [
      { _id: "1", appointmentDate: "2026-10-20", timeSlot: "09:00 AM", status: "Completed" }, // Past completed
      { _id: "2", appointmentDate: "2026-10-20", timeSlot: "10:00 AM", status: "Expired" },   // Past expired
      { _id: "3", appointmentDate: "2026-10-21", timeSlot: "02:00 PM", status: "Scheduled" }, // Upcoming later
      { _id: "4", appointmentDate: "2026-10-21", timeSlot: "10:00 AM", status: "Scheduled" }, // Upcoming earlier
      { _id: "5", appointmentDate: "2026-10-22", timeSlot: "09:00 AM", status: "Scheduled" }, // Upcoming latest
      { _id: "6", appointmentDate: "2026-10-19", timeSlot: "04:00 PM", status: "Cancelled" }, // Past cancelled
    ];

    const partitioned = partitionAppointments(sampleAppointments, fakeNow);

    // Upcoming must strictly be ordered by nearest scheduled date/time first: #4 (Oct 21 10am) -> #3 (Oct 21 2pm) -> #5 (Oct 22 9am)
    assert.strictEqual(partitioned.upcoming.length, 3);
    assert.strictEqual(partitioned.upcoming[0]._id, "4");
    assert.strictEqual(partitioned.upcoming[1]._id, "3");
    assert.strictEqual(partitioned.upcoming[2]._id, "5");

    // Past appointments must strictly NOT contain upcoming, and be sorted most recent first:
    // Oct 20 10:00 AM (#2) -> Oct 20 09:00 AM (#1) -> Oct 19 04:00 PM (#6)
    assert.strictEqual(partitioned.past.length, 3);
    assert.strictEqual(partitioned.past[0]._id, "2");
    assert.strictEqual(partitioned.past[1]._id, "1");
    assert.strictEqual(partitioned.past[2]._id, "6");

    // Ensure cancelled and expired never appear in upcoming
    for (const app of partitioned.upcoming) {
      assert.ok(!["Cancelled", "Rejected", "Completed", "Expired"].includes(app.status));
    }
  });

  // =========================================================================
  // SECTION 3: Backend Authorization & Video Access Enforcement
  // =========================================================================
  it("9. Patient cannot access another patient's appointment (403 Forbidden)", async () => {
    const appt = await Appointment.create({
      patientId: testPatient._id,
      doctorId: testDoctor._id,
      doctorName: testDoctor.name,
      patientName: testPatient.name,
      appointmentDate: new Date(),
      timeSlot: "10:00 AM",
      consultationType: "Video / Online",
      status: "Scheduled",
    });

    const res = await request("GET", `/api/appointments/${appt._id}/video-access`, null, otherPatientToken);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.success, false);
    assert.ok(res.body.message.includes("Access denied"));

    await Appointment.deleteOne({ _id: appt._id });
  });

  it("10. Doctor cannot access an appointment assigned to another doctor (403 Forbidden)", async () => {
    const appt = await Appointment.create({
      patientId: testPatient._id,
      doctorId: testDoctor._id,
      doctorName: testDoctor.name,
      patientName: testPatient.name,
      appointmentDate: new Date(),
      timeSlot: "10:00 AM",
      consultationType: "Video / Online",
      status: "Scheduled",
    });

    const res = await request("GET", `/api/appointments/${appt._id}/video-access`, null, otherDoctorToken);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.success, false);
    assert.ok(res.body.message.includes("Access denied"));

    await Appointment.deleteOne({ _id: appt._id });
  });

  // =========================================================================
  // SECTION 4: Automatic Expiry Evaluation & Server Restart Simulation
  // =========================================================================
  it("11. Automatic Expiry: Stale scheduled video appointment is transitioned to 'Expired' in database", async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const staleAppt = await Appointment.create({
      patientId: testPatient._id,
      doctorId: testDoctor._id,
      doctorName: testDoctor.name,
      patientName: testPatient.name,
      appointmentDate: yesterday,
      timeSlot: "09:00 AM",
      consultationType: "Video / Online",
      status: "Scheduled",
    });

    // Run expiration service
    const expiredIds = await expireStaleAppointments({ patientId: testPatient._id });
    assert.ok(expiredIds.includes(String(staleAppt._id)));

    const freshDoc = await Appointment.findById(staleAppt._id);
    assert.strictEqual(freshDoc.status, "Expired");

    await Appointment.deleteOne({ _id: staleAppt._id });
  });

  it("12. Expiry handling after backend restart: querying appointments automatically evaluates and persists expired status", async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const staleAppt = await Appointment.create({
      patientId: testPatient._id,
      doctorId: testDoctor._id,
      doctorName: testDoctor.name,
      patientName: testPatient.name,
      appointmentDate: twoDaysAgo,
      timeSlot: "10:00 AM",
      consultationType: "Video / Online",
      status: "Scheduled", // Not yet marked expired in DB
    });

    // Simulate backend restart / lazy evaluation on GET /api/appointments
    const res = await request("GET", "/api/appointments", null, testPatientToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);

    // Verify it is now marked "Expired" in database
    const freshAppt = await Appointment.findById(staleAppt._id);
    assert.strictEqual(freshAppt.status, "Expired");

    // Verify it is returned in pastAppointments, NOT upcomingAppointments
    assert.ok(Array.isArray(res.body.upcomingAppointments));
    assert.ok(Array.isArray(res.body.pastAppointments));
    const isUpcoming = res.body.upcomingAppointments.some((a) => String(a._id) === String(staleAppt._id));
    const isPast = res.body.pastAppointments.some((a) => String(a._id) === String(staleAppt._id));
    assert.strictEqual(isUpcoming, false);
    assert.strictEqual(isPast, true);

    await Appointment.deleteOne({ _id: staleAppt._id });
  });

  it("13. Expiration service does NOT overwrite Completed, Cancelled, or Rejected appointments", async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const completed = await Appointment.create({
      patientId: testPatient._id,
      doctorId: testDoctor._id,
      doctorName: testDoctor.name,
      patientName: testPatient.name,
      appointmentDate: yesterday,
      timeSlot: "09:00 AM",
      consultationType: "Video / Online",
      status: "Completed",
    });

    const cancelled = await Appointment.create({
      patientId: testPatient._id,
      doctorId: testDoctor._id,
      doctorName: testDoctor.name,
      patientName: testPatient.name,
      appointmentDate: yesterday,
      timeSlot: "10:00 AM",
      consultationType: "Video / Online",
      status: "Cancelled",
    });

    const rejected = await Appointment.create({
      patientId: testPatient._id,
      doctorId: testDoctor._id,
      doctorName: testDoctor.name,
      patientName: testPatient.name,
      appointmentDate: yesterday,
      timeSlot: "11:00 AM",
      consultationType: "Video / Online",
      status: "Rejected",
    });

    // Run expiration service
    await expireStaleAppointments({ patientId: testPatient._id });

    const freshComp = await Appointment.findById(completed._id);
    const freshCanc = await Appointment.findById(cancelled._id);
    const freshRej = await Appointment.findById(rejected._id);

    assert.strictEqual(freshComp.status, "Completed");
    assert.strictEqual(freshCanc.status, "Cancelled");
    assert.strictEqual(freshRej.status, "Rejected");

    await Appointment.deleteOne({ _id: completed._id });
    await Appointment.deleteOne({ _id: cancelled._id });
    await Appointment.deleteOne({ _id: rejected._id });
  });
});
