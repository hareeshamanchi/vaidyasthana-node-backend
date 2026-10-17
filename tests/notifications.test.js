const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const app = require("../src/app");
const User = require("../src/models/User");
const Notification = require("../src/models/Notification");
const Appointment = require("../src/models/Appointment");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "vaidyasthana_development_jwt_secret_key_32bytes";

const request = (server, method, path, body = null, token = null) => {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const serialized = body ? JSON.stringify(body) : null;
    const headers = {
      ...(serialized ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(serialized) } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
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

describe("Vaidyasthana Notification System Suite", () => {
  let server;
  let testPatient;
  let testDoctor;
  let patientToken;
  let doctorToken;
  const suffix = Date.now();
  const createdApptIds = [];

  before(async () => {
    await connectDB();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));

    testPatient = await User.create({
      name: `Notify Patient ${suffix}`,
      email: `notify_pat_${suffix}@example.com`,
      password: "HashedPassword123!",
      role: "patient",
      phoneNumber: "+919876543299",
      address: "123 Patient Lane, Bangalore",
    });

    testDoctor = await User.create({
      name: `Notify Doctor ${suffix}`,
      email: `notify_doc_${suffix}@example.com`,
      password: "HashedPassword123!",
      role: "doctor",
      specialization: "General Medicine",
      verificationStatus: "verified",
      phoneNumber: "+919876543298",
      address: "456 Doctor Clinic, Bangalore",
    });

    patientToken = jwt.sign(
      { id: testPatient._id.toString(), role: "patient", email: testPatient.email },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    doctorToken = jwt.sign(
      { id: testDoctor._id.toString(), role: "doctor", email: testDoctor.email },
      JWT_SECRET,
      { expiresIn: "1h" }
    );
  });

  after(async () => {
    if (createdApptIds.length > 0) {
      await Appointment.deleteMany({ _id: { $in: createdApptIds } });
    }
    await Notification.deleteMany({ userId: { $in: [testPatient._id, testDoctor._id] } });
    await User.deleteMany({ _id: { $in: [testPatient._id, testDoctor._id] } });
    server.close();
    await mongoose.disconnect();
  });

  test("1. GET /api/notifications requires authentication", async () => {
    const res = await request(server, "GET", "/api/notifications");
    assert.strictEqual(res.status, 401);
  });

  test("2. GET /api/notifications/unread-count returns 0 for user with no notifications", async () => {
    const res = await request(server, "GET", "/api/notifications/unread-count", null, patientToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.unreadCount, 0);
  });

  test("3. Booking appointment generates distinct notifications for Doctor and Patient", async () => {
    const bookRes = await request(
      server,
      "POST",
      "/api/appointments",
      {
        doctorId: testDoctor._id.toString(),
        appointmentDate: "2026-11-28",
        timeSlot: "11:00 AM",
        department: "General Medicine",
        reason: "Fever and cold checkup",
      },
      patientToken
    );

    assert.strictEqual(bookRes.status, 201);
    createdApptIds.push(bookRes.body.appointment._id);

    // Verify patient unread count is 1
    const patUnreadRes = await request(server, "GET", "/api/notifications/unread-count", null, patientToken);
    assert.strictEqual(patUnreadRes.status, 200);
    assert.strictEqual(patUnreadRes.body.unreadCount, 1);

    // Verify patient notification details
    const patFeedRes = await request(server, "GET", "/api/notifications", null, patientToken);
    assert.strictEqual(patFeedRes.status, 200);
    assert.strictEqual(patFeedRes.body.notifications.length, 1);
    const patNotification = patFeedRes.body.notifications[0];
    assert.strictEqual(patNotification.type, "appointment_booked");
    assert.strictEqual(patNotification.isRead, false);

    // Verify doctor unread count is 1
    const docUnreadRes = await request(server, "GET", "/api/notifications/unread-count", null, doctorToken);
    assert.strictEqual(docUnreadRes.status, 200);
    assert.strictEqual(docUnreadRes.body.unreadCount, 1);

    // Verify doctor notification details & tenant isolation
    const docFeedRes = await request(server, "GET", "/api/notifications", null, doctorToken);
    assert.strictEqual(docFeedRes.status, 200);
    assert.strictEqual(docFeedRes.body.notifications.length, 1);
    const docNotification = docFeedRes.body.notifications[0];
    assert.strictEqual(docNotification.type, "appointment_booked");
    assert.strictEqual(docNotification.userId.toString(), testDoctor._id.toString());
  });

  test("4. Marking a notification as read updates isRead and decrements unreadCount", async () => {
    const feedRes = await request(server, "GET", "/api/notifications", null, patientToken);
    const notificationId = feedRes.body.notifications[0]._id;

    // Doctor cannot mark patient's notification as read (Ownership security)
    const unauthorizedRes = await request(
      server,
      "PATCH",
      `/api/notifications/${notificationId}/read`,
      null,
      doctorToken
    );
    assert.strictEqual(unauthorizedRes.status, 404);

    // Patient marks their own notification as read
    const markRes = await request(
      server,
      "PATCH",
      `/api/notifications/${notificationId}/read`,
      null,
      patientToken
    );
    assert.strictEqual(markRes.status, 200);
    assert.strictEqual(markRes.body.notification.isRead, true);
    assert.strictEqual(markRes.body.unreadCount, 0);

    // Verify unread count is now 0
    const countRes = await request(server, "GET", "/api/notifications/unread-count", null, patientToken);
    assert.strictEqual(countRes.body.unreadCount, 0);
  });

  test("5. Status update generates appointment_confirmed notification", async () => {
    const apptId = createdApptIds[0];
    const updateRes = await request(
      server,
      "PUT",
      `/api/appointments/${apptId}`,
      { status: "Confirmed" },
      doctorToken
    );
    assert.strictEqual(updateRes.status, 200);

    // Patient now has a new unread notification
    const patUnreadRes = await request(server, "GET", "/api/notifications/unread-count", null, patientToken);
    assert.strictEqual(patUnreadRes.body.unreadCount, 1);

    const patFeedRes = await request(server, "GET", "/api/notifications", null, patientToken);
    const latestNotif = patFeedRes.body.notifications[0];
    assert.strictEqual(latestNotif.type, "appointment_confirmed");
    assert.strictEqual(latestNotif.title, "Appointment Confirmed");
  });

  test("6. PATCH /api/notifications/read-all marks all unread notifications as read", async () => {
    const readAllRes = await request(server, "PATCH", "/api/notifications/read-all", null, patientToken);
    assert.strictEqual(readAllRes.status, 200);
    assert.strictEqual(readAllRes.body.unreadCount, 0);

    const checkCount = await request(server, "GET", "/api/notifications/unread-count", null, patientToken);
    assert.strictEqual(checkCount.body.unreadCount, 0);
  });

  test("7. DELETE /api/notifications/:id deletes user's notification", async () => {
    const feed = await request(server, "GET", "/api/notifications", null, patientToken);
    assert(feed.body.notifications.length > 0);
    const targetId = feed.body.notifications[0]._id;

    const delRes = await request(server, "DELETE", `/api/notifications/${targetId}`, null, patientToken);
    assert.strictEqual(delRes.status, 200);

    const feedAfter = await request(server, "GET", "/api/notifications", null, patientToken);
    const found = feedAfter.body.notifications.find((n) => n._id === targetId);
    assert.strictEqual(found, undefined);
  });
});
