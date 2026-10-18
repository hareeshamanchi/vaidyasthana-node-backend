const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const app = require("../src/app");
const User = require("../src/models/User");
const Appointment = require("../src/models/Appointment");
const Medication = require("../src/models/Medication");
const DoseEvent = require("../src/models/DoseEvent");
const Notification = require("../src/models/Notification");
const jwt = require("jsonwebtoken");
const {
  evaluateMissedDoses,
  formatDateInTimezone,
} = require("../src/services/medicationReminderService");

const JWT_SECRET = process.env.JWT_SECRET || "vaidyasthana_development_jwt_secret_key_32bytes";

const request = (server, method, reqPath, body = null, token = null) => {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const serialized = body ? JSON.stringify(body) : null;
    const headers = {
      ...(serialized
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(serialized),
          }
        : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: reqPath,
        headers,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (serialized) req.write(serialized);
    req.end();
  });
};

describe("Vaidyasthana Medication Reminders & Dose Tracking Suite", () => {
  let server;
  let testPatient;
  let testDoctor;
  let unauthorizedDoctor;
  let patientToken;
  let doctorToken;
  let unauthorizedDoctorToken;
  const suffix = Date.now();
  let createdMedicationId = null;
  let createdDoseId = null;

  before(async () => {
    await connectDB();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));

    testPatient = await User.create({
      name: `Med Patient ${suffix}`,
      email: `med_pat_${suffix}@example.com`,
      password: "HashedPassword123!",
      role: "patient",
      phoneNumber: "+919876543311",
      address: "45 Health Road, Bangalore",
    });

    testDoctor = await User.create({
      name: `Med Doctor ${suffix}`,
      email: `med_doc_${suffix}@example.com`,
      password: "HashedPassword123!",
      role: "doctor",
      specialization: "Internal Medicine",
      verificationStatus: "verified",
      phoneNumber: "+919876543322",
      address: "100 Medical Plaza, Bangalore",
    });

    unauthorizedDoctor = await User.create({
      name: `Med Stranger Doc ${suffix}`,
      email: `med_stranger_${suffix}@example.com`,
      password: "HashedPassword123!",
      role: "doctor",
      specialization: "Dermatology",
      verificationStatus: "verified",
      phoneNumber: "+919876543333",
      address: "200 Unrelated Clinic, Bangalore",
    });

    // Create clinical relationship between testDoctor and testPatient
    await Appointment.create({
      doctorId: testDoctor._id,
      doctorName: testDoctor.name,
      patientId: testPatient._id,
      patientName: testPatient.name,
      patientEmail: testPatient.email,
      appointmentDate: new Date(),
      startTime: "10:00 AM",
      timeSlot: "10:00 AM - 10:30 AM",
      consultationType: "Video / Online",
      status: "Confirmed",
    });

    patientToken = jwt.sign(
      { id: testPatient._id.toString(), role: "patient", email: testPatient.email, name: testPatient.name },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    doctorToken = jwt.sign(
      { id: testDoctor._id.toString(), role: "doctor", email: testDoctor.email, name: testDoctor.name },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    unauthorizedDoctorToken = jwt.sign(
      {
        id: unauthorizedDoctor._id.toString(),
        role: "doctor",
        email: unauthorizedDoctor.email,
        name: unauthorizedDoctor.name,
      },
      JWT_SECRET,
      { expiresIn: "1h" }
    );
  });

  after(async () => {
    await Appointment.deleteMany({ patientId: testPatient._id });
    await DoseEvent.deleteMany({ patientId: testPatient._id });
    await Medication.deleteMany({ patientId: testPatient._id });
    await Notification.deleteMany({ userId: testPatient._id });
    await User.deleteMany({
      _id: { $in: [testPatient._id, testDoctor._id, unauthorizedDoctor._id] },
    });
    server.close();
    await mongoose.disconnect();
  });

  test("1. GET /api/medications requires authentication", async () => {
    const res = await request(server, "GET", "/api/medications");
    assert.strictEqual(res.status, 401);
  });

  test("2. POST /api/medications validates required fields", async () => {
    const res = await request(
      server,
      "POST",
      "/api/medications",
      { name: "" },
      patientToken
    );
    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /Medication name is required/i);
  });

  test("3. Patient can create a medication schedule (marked strictly as patient_entered)", async () => {
    const res = await request(
      server,
      "POST",
      "/api/medications",
      {
        name: "Metformin 500",
        dosage: "500",
        dosageUnit: "mg",
        frequency: "twice_daily",
        reminderTimes: ["08:00", "20:00"],
        foodTiming: "after_food",
        instructions: "Take with a glass of water after meals",
        startDate: new Date().toISOString(),
      },
      patientToken
    );

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.medication.name, "Metformin 500");
    assert.strictEqual(res.body.medication.source, "patient_entered");
    assert.strictEqual(res.body.medication.status, "active");
    createdMedicationId = res.body.medication._id;
  });

  test("4. GET /api/medications/doses generates and lists daily doses with duplicate prevention", async () => {
    const todayStr = formatDateInTimezone(new Date(), "Asia/Kolkata");
    const res1 = await request(
      server,
      "GET",
      `/api/medications/doses?date=${todayStr}`,
      null,
      patientToken
    );

    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res1.body.success, true);
    assert.ok(Array.isArray(res1.body.doses));
    assert.strictEqual(res1.body.doses.length, 2); // 08:00 and 20:00
    assert.strictEqual(res1.body.summary.total, 2);

    createdDoseId = res1.body.doses[0]._id;

    // Second call to verify idempotency and zero duplicate creation
    const res2 = await request(
      server,
      "GET",
      `/api/medications/doses?date=${todayStr}`,
      null,
      patientToken
    );

    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.body.doses.length, 2);
  });

  test("5. Patient records dose status as Taken", async () => {
    assert.ok(createdDoseId);
    const res = await request(
      server,
      "PATCH",
      `/api/medications/doses/${createdDoseId}`,
      { status: "Taken", notes: "Taken after breakfast" },
      patientToken
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.dose.status, "Taken");
    assert.ok(res.body.dose.actionTime);
    assert.strictEqual(res.body.dose.notes, "Taken after breakfast");
  });

  test("6. Patient snoozes upcoming dose without marking it completed", async () => {
    const todayStr = formatDateInTimezone(new Date(), "Asia/Kolkata");
    const dosesRes = await request(
      server,
      "GET",
      `/api/medications/doses?date=${todayStr}`,
      null,
      patientToken
    );

    const secondDose = dosesRes.body.doses.find((d) => d.status === "Scheduled");
    assert.ok(secondDose);

    const snoozeRes = await request(
      server,
      "PATCH",
      `/api/medications/doses/${secondDose._id}`,
      { action: "snooze", snoozeMinutes: 30 },
      patientToken
    );

    assert.strictEqual(snoozeRes.status, 200);
    assert.strictEqual(snoozeRes.body.success, true);
    assert.strictEqual(snoozeRes.body.dose.status, "Scheduled");
    assert.ok(snoozeRes.body.dose.snoozeUntil);
    assert.strictEqual(snoozeRes.body.dose.reminderSent, false);
  });

  test("7. Missed dose evaluation marks overdue doses as Missed and sends clinical notification", async () => {
    // Create an artificial past scheduled dose
    const pastDose = await DoseEvent.create({
      patientId: testPatient._id,
      medicationId: createdMedicationId,
      medicationName: "Metformin 500",
      dosage: "500",
      dosageUnit: "mg",
      foodTiming: "after_food",
      scheduledDate: "2026-01-01",
      reminderTime: "08:00",
      scheduledTime: new Date(Date.now() - 4 * 60 * 60 * 1000), // 4 hours ago (past 2h grace period)
      status: "Scheduled",
      reminderSent: true,
      missedEvaluated: false,
    });

    const missed = await evaluateMissedDoses({ patientId: testPatient._id, now: Date.now() });
    const isTargetMissed = missed.some((d) => d._id.toString() === pastDose._id.toString());
    assert.strictEqual(isTargetMissed, true);

    const reloadedDose = await DoseEvent.findById(pastDose._id);
    assert.strictEqual(reloadedDose.status, "Missed");
    assert.strictEqual(reloadedDose.missedEvaluated, true);

    // Verify clinical notification was emitted
    const notif = await Notification.findOne({
      userId: testPatient._id,
      type: "medication_missed",
    });
    assert.ok(notif);
    assert.match(notif.message, /Do not double up/i);
  });

  test("8. Adherence statistics calculate transparently without penalizing future doses", async () => {
    const res = await request(
      server,
      "GET",
      "/api/medications/adherence?days=30",
      null,
      patientToken
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    const { stats } = res.body;
    assert.ok(typeof stats.adherenceRate === "number");
    assert.ok(stats.totalEvaluated >= 2); // 1 Taken + 1 Missed from previous tests
    assert.strictEqual(stats.takenCount >= 1, true);
    assert.strictEqual(stats.missedCount >= 1, true);
  });

  test("9. Unauthorized doctor cannot access patient medications", async () => {
    const res = await request(
      server,
      "GET",
      `/api/medications?patientId=${testPatient._id}`,
      null,
      unauthorizedDoctorToken
    );

    assert.strictEqual(res.status, 403);
    assert.match(res.body.message, /not clinically authorized/i);
  });

  test("10. Clinically authorized doctor can view patient's medications", async () => {
    const res = await request(
      server,
      "GET",
      `/api/medications?patientId=${testPatient._id}`,
      null,
      doctorToken
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.medications.length >= 1);
  });

  test("11. Pause and resume medication schedule", async () => {
    const pauseRes = await request(
      server,
      "PATCH",
      `/api/medications/${createdMedicationId}/status`,
      { status: "paused" },
      patientToken
    );
    assert.strictEqual(pauseRes.status, 200);
    assert.strictEqual(pauseRes.body.medication.status, "paused");

    const resumeRes = await request(
      server,
      "PATCH",
      `/api/medications/${createdMedicationId}/status`,
      { status: "active" },
      patientToken
    );
    assert.strictEqual(resumeRes.status, 200);
    assert.strictEqual(resumeRes.body.medication.status, "active");
  });
});
