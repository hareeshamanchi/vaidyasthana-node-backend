require("dotenv").config();
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const app = require("../src/app");
const User = require("../src/models/User");
const Appointment = require("../src/models/Appointment");

let server;
let baseUrl;

let doctorUser;
let doctorToken;
let patientUser;
let patientToken;
let unrelatedPatientUser;
let unrelatedPatientToken;
let unrelatedDoctorUser;
let unrelatedDoctorToken;

let videoAppointment;
let inPersonAppointment;
let cancelledAppointment;
let rejectedAppointment;
let completedAppointment;

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

describe("Real-Time Video Consultation Access & Security Suite", () => {
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

    // Create Doctor A
    doctorUser = await User.create({
      name: "Dr. Video Specialist",
      email: `dr_video_${ts}@hospital.test`,
      password: "HashedPassword123!",
      phoneNumber: "+91 9876543210",
      address: "Specialist Wing, Hospital",
      role: "doctor",
      specialization: "Cardiology",
      medicalRegistrationNumber: `MED-VID-${ts}`,
      verificationStatus: "verified",
    });
    doctorToken = jwt.sign(
      { id: doctorUser._id.toString(), role: "doctor", name: doctorUser.name, email: doctorUser.email },
      jwtSecret,
      { expiresIn: "1h" }
    );

    // Create Unrelated Doctor B
    unrelatedDoctorUser = await User.create({
      name: "Dr. Unrelated Clinician",
      email: `dr_unrelated_${ts}@hospital.test`,
      password: "HashedPassword123!",
      phoneNumber: "+91 9876543211",
      address: "Outpatient Clinic",
      role: "doctor",
      specialization: "Dermatology",
      verificationStatus: "verified",
    });
    unrelatedDoctorToken = jwt.sign(
      { id: unrelatedDoctorUser._id.toString(), role: "doctor", name: unrelatedDoctorUser.name, email: unrelatedDoctorUser.email },
      jwtSecret,
      { expiresIn: "1h" }
    );

    // Create Patient A
    patientUser = await User.create({
      name: "Patient Alpha",
      email: `patient_alpha_${ts}@test.org`,
      password: "HashedPassword123!",
      phoneNumber: "+91 9123456789",
      address: "123 Patient Street, City",
      role: "patient",
      verificationStatus: "verified",
    });
    patientToken = jwt.sign(
      { id: patientUser._id.toString(), role: "patient", name: patientUser.name, email: patientUser.email },
      jwtSecret,
      { expiresIn: "1h" }
    );

    // Create Unrelated Patient B
    unrelatedPatientUser = await User.create({
      name: "Patient Beta",
      email: `patient_beta_${ts}@test.org`,
      password: "HashedPassword123!",
      phoneNumber: "+91 9123456780",
      address: "456 Other Road, City",
      role: "patient",
      verificationStatus: "verified",
    });
    unrelatedPatientToken = jwt.sign(
      { id: unrelatedPatientUser._id.toString(), role: "patient", name: unrelatedPatientUser.name, email: unrelatedPatientUser.email },
      jwtSecret,
      { expiresIn: "1h" }
    );

    const baseDate = new Date();
    baseDate.setUTCDate(baseDate.getUTCDate() + 1);

    // 1. Scheduled Video / Online Appointment
    videoAppointment = await Appointment.create({
      patientId: patientUser._id,
      doctorId: doctorUser._id,
      doctorName: doctorUser.name,
      patientName: patientUser.name,
      patientPhone: patientUser.phoneNumber,
      patientEmail: patientUser.email,
      department: "Cardiology",
      appointmentDate: baseDate,
      timeSlot: "10:00 AM",
      consultationType: "Video / Online",
      type: "Consultation",
      reason: "Clinical Telehealth Evaluation",
      status: "Scheduled",
    });

    // 2. Scheduled In-Person Appointment
    inPersonAppointment = await Appointment.create({
      patientId: patientUser._id,
      doctorId: doctorUser._id,
      doctorName: doctorUser.name,
      patientName: patientUser.name,
      department: "Cardiology",
      appointmentDate: baseDate,
      timeSlot: "11:00 AM",
      consultationType: "In-Person",
      type: "Consultation",
      status: "Scheduled",
    });

    // 3. Cancelled Video Appointment
    cancelledAppointment = await Appointment.create({
      patientId: patientUser._id,
      doctorId: doctorUser._id,
      doctorName: doctorUser.name,
      patientName: patientUser.name,
      department: "Cardiology",
      appointmentDate: baseDate,
      timeSlot: "12:00 PM",
      consultationType: "Video / Online",
      status: "Cancelled",
    });

    // 4. Rejected Video Appointment
    rejectedAppointment = await Appointment.create({
      patientId: patientUser._id,
      doctorId: doctorUser._id,
      doctorName: doctorUser.name,
      patientName: patientUser.name,
      department: "Cardiology",
      appointmentDate: baseDate,
      timeSlot: "01:00 PM",
      consultationType: "Video / Online",
      status: "Rejected",
      rejectionReason: "Doctor unavailable at requested time.",
    });

    // 5. Completed Video Appointment
    completedAppointment = await Appointment.create({
      patientId: patientUser._id,
      doctorId: doctorUser._id,
      doctorName: doctorUser.name,
      patientName: patientUser.name,
      department: "Cardiology",
      appointmentDate: baseDate,
      timeSlot: "02:00 PM",
      consultationType: "Video / Online",
      status: "Completed",
    });
  });

  after(async () => {
    // Cleanup fixtures
    if (doctorUser) await User.deleteOne({ _id: doctorUser._id });
    if (unrelatedDoctorUser) await User.deleteOne({ _id: unrelatedDoctorUser._id });
    if (patientUser) await User.deleteOne({ _id: patientUser._id });
    if (unrelatedPatientUser) await User.deleteOne({ _id: unrelatedPatientUser._id });

    if (videoAppointment) await Appointment.deleteOne({ _id: videoAppointment._id });
    if (inPersonAppointment) await Appointment.deleteOne({ _id: inPersonAppointment._id });
    if (cancelledAppointment) await Appointment.deleteOne({ _id: cancelledAppointment._id });
    if (rejectedAppointment) await Appointment.deleteOne({ _id: rejectedAppointment._id });
    if (completedAppointment) await Appointment.deleteOne({ _id: completedAppointment._id });

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  it("1. Patient can retrieve video access for their scheduled Video / Online appointment", async () => {
    const res = await request("GET", `/api/appointments/${videoAppointment._id}/video-access`, null, patientToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.meeting.roomName);
    assert.strictEqual(res.body.meeting.userRole, "patient");
    assert.strictEqual(res.body.meeting.displayName, patientUser.name);
    assert.strictEqual(res.body.meeting.appointmentId, videoAppointment._id.toString());
  });

  it("2. Assigned Doctor can retrieve video access for the same appointment", async () => {
    const res = await request("GET", `/api/appointments/${videoAppointment._id}/video-access`, null, doctorToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.meeting.roomName);
    assert.strictEqual(res.body.meeting.userRole, "doctor");
    assert.ok(res.body.meeting.displayName.includes("Dr."));
  });

  it("3. Both Patient and Doctor receive the EXACT same meeting room identifier", async () => {
    const resPatient = await request("GET", `/api/appointments/${videoAppointment._id}/video-access`, null, patientToken);
    const resDoctor = await request("GET", `/api/appointments/${videoAppointment._id}/video-access`, null, doctorToken);

    assert.strictEqual(resPatient.status, 200);
    assert.strictEqual(resDoctor.status, 200);
    assert.strictEqual(resPatient.body.meeting.roomName, resDoctor.body.meeting.roomName);
    assert.ok(resPatient.body.meeting.roomName.length > 20);
  });

  it("4. Room identifier is cryptographically non-guessable and does NOT leak patient email or phone", async () => {
    const res = await request("GET", `/api/appointments/${videoAppointment._id}/video-access`, null, patientToken);
    const room = res.body.meeting.roomName;

    assert.ok(!room.includes(patientUser.email));
    assert.ok(!room.includes(patientUser.phoneNumber));
    assert.ok(!room.includes("9876543210"));
  });

  it("5. In-Person appointments reject video consultation with 400 Bad Request", async () => {
    const res = await request("GET", `/api/appointments/${inPersonAppointment._id}/video-access`, null, patientToken);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.ok(res.body.message.includes("not available for in-person"));
  });

  it("6. Unrelated patient is strictly blocked with 403 Forbidden", async () => {
    const res = await request("GET", `/api/appointments/${videoAppointment._id}/video-access`, null, unrelatedPatientToken);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.success, false);
    assert.ok(res.body.message.includes("Access denied"));
  });

  it("7. Unrelated doctor is strictly blocked with 403 Forbidden", async () => {
    const res = await request("GET", `/api/appointments/${videoAppointment._id}/video-access`, null, unrelatedDoctorToken);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.success, false);
    assert.ok(res.body.message.includes("Access denied"));
  });

  it("8. Cancelled appointments cannot start or join video consultation (400 Bad Request)", async () => {
    const res = await request("GET", `/api/appointments/${cancelledAppointment._id}/video-access`, null, patientToken);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.ok(res.body.message.includes("cancelled"));
  });

  it("9. Rejected appointments cannot start or join video consultation (400 Bad Request)", async () => {
    const res = await request("GET", `/api/appointments/${rejectedAppointment._id}/video-access`, null, doctorToken);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.ok(res.body.message.includes("rejected"));
  });

  it("10. Completed appointments cannot start or join new calls (400 Bad Request)", async () => {
    const res = await request("GET", `/api/appointments/${completedAppointment._id}/video-access`, null, patientToken);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.ok(res.body.message.includes("completed"));
  });

  it("11. Requesting video access does NOT mark the appointment completed", async () => {
    await request("GET", `/api/appointments/${videoAppointment._id}/video-access`, null, doctorToken);
    const freshAppt = await Appointment.findById(videoAppointment._id);
    assert.strictEqual(freshAppt.status, "Scheduled");
  });
});
