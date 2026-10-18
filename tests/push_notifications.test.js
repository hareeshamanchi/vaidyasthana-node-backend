const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const app = require("../src/app");
const User = require("../src/models/User");
const Medication = require("../src/models/Medication");
const DoseEvent = require("../src/models/DoseEvent");
const PushSubscription = require("../src/models/PushSubscription");
const jwt = require("jsonwebtoken");
const {
  getVapidPublicKey,
  saveSubscription,
  removeSubscription,
  sendPushToUser,
} = require("../src/services/pushNotificationService");
const {
  processDueReminders,
  REPEAT_ALERT_INTERVAL_MS,
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

describe("Vaidyasthana Web Push & Repeating Background Reminders Suite", () => {
  let server;
  let testPatient;
  let patientToken;
  const suffix = Date.now();
  let testMedication;

  before(async () => {
    await connectDB();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));

    testPatient = await User.create({
      name: `Push Test Patient ${suffix}`,
      email: `push_pat_${suffix}@example.com`,
      password: "HashedPassword123!",
      role: "patient",
      phoneNumber: "+919876543999",
      address: "12 Push Avenue, Bangalore",
    });

    patientToken = jwt.sign(
      { id: testPatient._id.toString(), role: "patient", email: testPatient.email, name: testPatient.name },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    testMedication = await Medication.create({
      patientId: testPatient._id,
      name: "Atorvastatin 10",
      dosage: "10",
      dosageUnit: "mg",
      frequency: "once_daily",
      reminderTimes: ["21:00"],
      foodTiming: "after_food",
      startDate: new Date(),
      status: "active",
      source: "patient_entered",
    });
  });

  after(async () => {
    await PushSubscription.deleteMany({ userId: testPatient._id });
    await DoseEvent.deleteMany({ patientId: testPatient._id });
    await Medication.deleteMany({ patientId: testPatient._id });
    await User.deleteMany({ _id: testPatient._id });
    server.close();
    await mongoose.disconnect();
  });

  test("1. GET /api/push/vapid-key returns valid VAPID public key", async () => {
    const res = await request(server, "GET", "/api/push/vapid-key");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(typeof res.body.publicKey === "string");
    assert.ok(res.body.publicKey.length > 30);
  });

  test("2. POST /api/push/subscribe requires authentication", async () => {
    const res = await request(server, "POST", "/api/push/subscribe", {
      subscription: { endpoint: "https://example.com/push/test" },
    });
    assert.strictEqual(res.status, 401);
  });

  test("3. POST /api/push/subscribe validates endpoint and encryption keys", async () => {
    const res = await request(
      server,
      "POST",
      "/api/push/subscribe",
      { subscription: { endpoint: "" } },
      patientToken
    );
    assert.strictEqual(res.status, 400);

    const resNoKeys = await request(
      server,
      "POST",
      "/api/push/subscribe",
      { subscription: { endpoint: "https://example.com/endpoint/123" } },
      patientToken
    );
    assert.strictEqual(resNoKeys.status, 500);
    assert.match(resNoKeys.body.message, /missing p256dh or auth/i);
  });

  test("4. Authenticated patient registers push subscription successfully", async () => {
    const subscriptionData = {
      endpoint: `https://fcm.googleapis.com/fcm/send/fake-device-token-${suffix}`,
      keys: {
        p256dh: "BMh3gZ91234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890==",
        auth: "authsecret123456==",
      },
    };

    const res = await request(
      server,
      "POST",
      "/api/push/subscribe",
      { subscription: subscriptionData },
      patientToken
    );

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.subscriptionId);

    const record = await PushSubscription.findOne({ endpoint: subscriptionData.endpoint });
    assert.ok(record);
    assert.strictEqual(record.userId.toString(), testPatient._id.toString());
    assert.strictEqual(record.status, "active");
  });

  test("5. Idempotent subscription registration updates existing endpoint without duplicate documents", async () => {
    const subscriptionData = {
      endpoint: `https://fcm.googleapis.com/fcm/send/fake-device-token-${suffix}`,
      keys: {
        p256dh: "BMh3gZ91234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890==",
        auth: "updated_auth_key_123==",
      },
    };

    const res = await request(
      server,
      "POST",
      "/api/push/subscribe",
      { subscription: subscriptionData },
      patientToken
    );

    assert.strictEqual(res.status, 201);
    const count = await PushSubscription.countDocuments({ endpoint: subscriptionData.endpoint });
    assert.strictEqual(count, 1);

    const updated = await PushSubscription.findOne({ endpoint: subscriptionData.endpoint });
    assert.strictEqual(updated.keys.auth, "updated_auth_key_123==");
  });

  test("6. POST /api/push/unsubscribe removes subscription cleanly", async () => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/fake-device-token-${suffix}`;
    const res = await request(
      server,
      "POST",
      "/api/push/unsubscribe",
      { endpoint },
      patientToken
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);

    const record = await PushSubscription.findOne({ endpoint });
    assert.strictEqual(record, null);
  });

  test("7. Initial due dose claims reminderSent: true and records lastAlertAt with alertCount: 1", async () => {
    const pastTime = new Date(Date.now() - 5 * 60 * 1000); // 5 mins ago
    const dose = await DoseEvent.create({
      patientId: testPatient._id,
      medicationId: testMedication._id,
      medicationName: testMedication.name,
      dosage: testMedication.dosage,
      dosageUnit: testMedication.dosageUnit,
      foodTiming: testMedication.foodTiming,
      scheduledDate: "2026-10-18",
      reminderTime: "21:00",
      scheduledTime: pastTime,
      status: "Scheduled",
      reminderSent: false,
    });

    const dispatched = await processDueReminders({
      patientId: testPatient._id,
      now: Date.now(),
    });

    const isClaimed = dispatched.some((d) => d._id.toString() === dose._id.toString());
    assert.strictEqual(isClaimed, true);

    const reloaded = await DoseEvent.findById(dose._id);
    assert.strictEqual(reloaded.reminderSent, true);
    assert.ok(reloaded.reminderSentAt);
    assert.ok(reloaded.lastAlertAt);
    assert.strictEqual(reloaded.alertCount, 1);
  });

  test("8. Repeating reminders: pending dose alerts again after 90 seconds while Scheduled", async () => {
    // Locate the claimed dose from test 7
    const dose = await DoseEvent.findOne({
      patientId: testPatient._id,
      medicationId: testMedication._id,
      status: "Scheduled",
    });
    assert.ok(dose);

    // Test immediate subsequent check (less than 90s elapsed) -> must NOT trigger repeat
    const immediateCheck = await processDueReminders({
      patientId: testPatient._id,
      now: Date.now() + 30 * 1000, // 30s later
    });
    const immediateRepeated = immediateCheck.some((d) => d._id.toString() === dose._id.toString());
    assert.strictEqual(immediateRepeated, false);

    // Test after 90s interval elapsed -> MUST trigger repeating reminder
    const ninetySecLater = Date.now() + 95 * 1000;
    const repeatCheck = await processDueReminders({
      patientId: testPatient._id,
      now: ninetySecLater,
    });

    const wasRepeated = repeatCheck.some((d) => d._id.toString() === dose._id.toString());
    assert.strictEqual(wasRepeated, true);

    const reloaded = await DoseEvent.findById(dose._id);
    assert.strictEqual(reloaded.alertCount, 2);
    assert.ok(reloaded.lastAlertAt.getTime() >= ninetySecLater - 1000);
  });

  test("9. Acknowledged dose (Taken or Skipped) immediately halts repeating reminders", async () => {
    const dose = await DoseEvent.findOne({
      patientId: testPatient._id,
      medicationId: testMedication._id,
      status: "Scheduled",
    });
    assert.ok(dose);

    // Patient marks dose as Taken
    await DoseEvent.updateOne(
      { _id: dose._id },
      { $set: { status: "Taken", actionTime: new Date() } }
    );

    // Run cycle far in the future
    const futureCheck = await processDueReminders({
      patientId: testPatient._id,
      now: Date.now() + 10 * 60 * 1000, // 10 minutes later
    });

    const triggered = futureCheck.some((d) => d._id.toString() === dose._id.toString());
    assert.strictEqual(triggered, false, "Taken dose must never trigger repeating reminder");
  });

  test("10. Snoozed dose suppresses repeating alerts until snooze duration passes", async () => {
    const pastTime = new Date(Date.now() - 2 * 60 * 1000);
    const snoozedDose = await DoseEvent.create({
      patientId: testPatient._id,
      medicationId: testMedication._id,
      medicationName: testMedication.name,
      dosage: testMedication.dosage,
      dosageUnit: testMedication.dosageUnit,
      foodTiming: testMedication.foodTiming,
      scheduledDate: "2026-10-18",
      reminderTime: "22:00",
      scheduledTime: pastTime,
      status: "Scheduled",
      reminderSent: true,
      lastAlertAt: pastTime,
      snoozeUntil: new Date(Date.now() + 20 * 60 * 1000), // Snoozed 20 minutes into the future
      alertCount: 1,
    });

    const checkDuringSnooze = await processDueReminders({
      patientId: testPatient._id,
      now: Date.now() + 5 * 60 * 1000, // 5 mins later (still snoozed)
    });

    assert.strictEqual(
      checkDuringSnooze.some((d) => d._id.toString() === snoozedDose._id.toString()),
      false
    );

    // Check after snooze has expired (25 mins later)
    const checkAfterSnooze = await processDueReminders({
      patientId: testPatient._id,
      now: Date.now() + 25 * 60 * 1000,
    });

    assert.strictEqual(
      checkAfterSnooze.some((d) => d._id.toString() === snoozedDose._id.toString()),
      true
    );
  });
});
