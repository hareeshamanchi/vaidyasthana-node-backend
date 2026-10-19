require("dotenv").config();
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const app = require("../src/app");
const User = require("../src/models/User");
const Appointment = require("../src/models/Appointment");
const {
  getNowInTimezone,
  extractDateOnlyStr,
  getClinicTimezone,
} = require("../src/controllers/appointmentController");

let server;
let baseUrl;

let doctorUser;
let doctorToken;
let patientUser;
let patientToken;
let patient2User;
let patient2Token;

const JWT_SECRET = process.env.JWT_SECRET || "vaidyasthana_secure_jwt_secret_key_2026";

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

describe("Appointment Time Slots & Elapsed Slots Availability Suite", () => {
  before(async () => {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGODB_URI);
    }

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Create verified doctor
    const docEmail = `dr.slotstest.${Date.now()}@vaidyasthana.test`;
    doctorUser = await User.create({
      name: "Dr. Arvind Ramesh",
      email: docEmail,
      password: "TestPassword123!",
      role: "doctor",
      verificationStatus: "verified",
      specialization: "Cardiology",
      phoneNumber: "+91 9900112233",
      address: "Chennai, Tamil Nadu",
    });
    doctorToken = jwt.sign({ id: doctorUser._id, role: doctorUser.role }, JWT_SECRET, {
      expiresIn: "1h",
    });

    // Create patients with completed profile
    const patEmail1 = `pat1.slotstest.${Date.now()}@vaidyasthana.test`;
    patientUser = await User.create({
      name: "Ravi Kumar",
      email: patEmail1,
      password: "TestPassword123!",
      role: "patient",
      phoneNumber: "+91 9888877777",
      address: "123 Anna Nagar, Chennai",
    });
    patientToken = jwt.sign({ id: patientUser._id, role: patientUser.role }, JWT_SECRET, {
      expiresIn: "1h",
    });

    const patEmail2 = `pat2.slotstest.${Date.now()}@vaidyasthana.test`;
    patient2User = await User.create({
      name: "Sunita Verma",
      email: patEmail2,
      password: "TestPassword123!",
      role: "patient",
      phoneNumber: "+91 9777766666",
      address: "456 T Nagar, Chennai",
    });
    patient2Token = jwt.sign({ id: patient2User._id, role: patient2User.role }, JWT_SECRET, {
      expiresIn: "1h",
    });
  });

  after(async () => {
    if (doctorUser?._id) {
      await Appointment.deleteMany({ doctorId: doctorUser._id });
      await User.deleteOne({ _id: doctorUser._id });
    }
    if (patientUser?._id) {
      await User.deleteOne({ _id: patientUser._id });
    }
    if (patient2User?._id) {
      await User.deleteOne({ _id: patient2User._id });
    }
    if (server) {
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await mongoose.disconnect();
  });

  test("1. Timezone helpers accurately calculate clinic date and minutes in Asia/Kolkata", () => {
    const tz = getClinicTimezone("Asia/Kolkata");
    assert.strictEqual(tz, "Asia/Kolkata");

    const nowKolkata = getNowInTimezone("Asia/Kolkata");
    assert.ok(nowKolkata.dateStr.match(/^\d{4}-\d{2}-\d{2}$/));
    assert.ok(nowKolkata.currentMinutes >= 0 && nowKolkata.currentMinutes < 1440);

    const extracted = extractDateOnlyStr("2026-11-20T10:00:00.000Z", "Asia/Kolkata");
    assert.strictEqual(extracted, "2026-11-20");
  });

  test("2. GET /api/appointments/slots for a past date returns all slots disabled with 'Appointment date has passed'", async () => {
    const pastRes = await request(
      "GET",
      `/api/appointments/slots?doctorId=${doctorUser._id}&date=2020-01-01`,
      null,
      patientToken
    );

    assert.strictEqual(pastRes.status, 200);
    assert.strictEqual(pastRes.body.success, true);
    assert.strictEqual(pastRes.body.availableSlotsCount, 0);
    assert.ok(Array.isArray(pastRes.body.slots));
    assert.ok(pastRes.body.slots.length > 0);

    // Every slot must be unavailable, not booked, and marked past
    for (const slot of pastRes.body.slots) {
      assert.strictEqual(slot.isAvailable, false);
      assert.strictEqual(slot.isPast, true);
      assert.strictEqual(slot.isBooked, false);
      assert.strictEqual(slot.reason, "Appointment date has passed");
    }
  });

  test("3. GET /api/appointments/slots for a future date returns all unbooked slots as available", async () => {
    const futureDate = "2028-12-15";
    const futureRes = await request(
      "GET",
      `/api/appointments/slots?doctorId=${doctorUser._id}&date=${futureDate}`,
      null,
      patientToken
    );

    assert.strictEqual(futureRes.status, 200);
    assert.strictEqual(futureRes.body.success, true);
    assert.ok(futureRes.body.availableSlotsCount > 0);
    assert.strictEqual(futureRes.body.totalSlots, futureRes.body.slots.length);

    for (const slot of futureRes.body.slots) {
      assert.strictEqual(slot.isPast, false);
      assert.strictEqual(slot.isAvailable, true);
      assert.strictEqual(slot.isBooked, false);
      assert.strictEqual(slot.reason, "Available");
    }
  });

  test("4. GET /api/appointments/slots for today properly disables elapsed slots and preserves upcoming slots", async () => {
    const nowClinic = getNowInTimezone("Asia/Kolkata");
    const todayStr = nowClinic.dateStr;

    const todayRes = await request(
      "GET",
      `/api/appointments/slots?doctorId=${doctorUser._id}&date=${todayStr}&timezone=Asia/Kolkata`,
      null,
      patientToken
    );

    assert.strictEqual(todayRes.status, 200);
    assert.ok(Array.isArray(todayRes.body.slots));

    for (const slot of todayRes.body.slots) {
      // Slot minutes
      const match = slot.timeSlot.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      assert.ok(match, "Slot must match standard format");
      let h = parseInt(match[1], 10);
      const m = parseInt(match[2], 10);
      const mod = match[3].toUpperCase();
      if (mod === "PM" && h < 12) h += 12;
      if (mod === "AM" && h === 12) h = 0;
      const slotMins = h * 60 + m;

      if (slotMins <= nowClinic.currentMinutes) {
        assert.strictEqual(slot.isPast, true, `Slot ${slot.timeSlot} must be marked as past`);
        assert.strictEqual(slot.isAvailable, false, `Slot ${slot.timeSlot} must not be available`);
        assert.strictEqual(slot.reason, "Time slot has passed");
      }
    }
  });

  test("5. POST /api/appointments rejects booking for a past date with 400 Bad Request", async () => {
    const bookPastDateRes = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: doctorUser._id.toString(),
        appointmentDate: "2020-01-01",
        timeSlot: "10:00 AM",
        department: "Cardiology",
        consultationType: "In-Person",
        notes: "Test past date",
      },
      patientToken
    );

    assert.strictEqual(bookPastDateRes.status, 400);
    assert.strictEqual(bookPastDateRes.body.success, false);
    assert.ok(bookPastDateRes.body.message.includes("past"));
  });

  test("6. POST /api/appointments rejects booking for an elapsed slot today with 400 Bad Request", async () => {
    const nowClinic = getNowInTimezone("Asia/Kolkata");
    const todayStr = nowClinic.dateStr;

    // 08:00 AM (480 mins) is guaranteed to be in the past if current time is after 8:00 AM.
    // To ensure this test runs deterministically regardless of time of day, pick an elapsed slot or test boundary.
    if (nowClinic.currentMinutes > 480) {
      const bookElapsedSlotRes = await request(
        "POST",
        "/api/appointments",
        {
          doctorId: doctorUser._id.toString(),
          appointmentDate: todayStr,
          timeSlot: "08:00 AM",
          department: "Cardiology",
          consultationType: "In-Person",
          notes: "Testing elapsed slot",
        },
        patientToken
      );

      assert.strictEqual(bookElapsedSlotRes.status, 400);
      assert.strictEqual(bookElapsedSlotRes.body.success, false);
      assert.ok(
        bookElapsedSlotRes.body.message.includes("already passed") ||
          bookElapsedSlotRes.body.message.includes("past")
      );
    } else {
      // If run before 8:00 AM clinic time, test that invalid/out-of-hours slot is rejected with 400
      const invalidSlotRes = await request(
        "POST",
        "/api/appointments",
        {
          doctorId: doctorUser._id.toString(),
          appointmentDate: todayStr,
          timeSlot: "06:00 AM",
          department: "Cardiology",
          consultationType: "In-Person",
        },
        patientToken
      );
      assert.strictEqual(invalidSlotRes.status, 400);
    }
  });

  test("7. Booking an available future slot succeeds with 201 Created and updates slot availability", async () => {
    const targetDate = "2028-11-20";
    const targetSlot = "02:30 PM";

    const bookRes = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: doctorUser._id.toString(),
        appointmentDate: targetDate,
        timeSlot: targetSlot,
        department: "Cardiology",
        consultationType: "In-Person",
        notes: "Routine checkup",
      },
      patientToken
    );

    assert.strictEqual(bookRes.status, 201);
    assert.strictEqual(bookRes.body.success, true);
    assert.ok(bookRes.body.appointment._id);

    // Verify slot is now booked
    const checkSlotsRes = await request(
      "GET",
      `/api/appointments/slots?doctorId=${doctorUser._id}&date=${targetDate}`,
      null,
      patientToken
    );

    const bookedSlot = checkSlotsRes.body.slots.find((s) => s.timeSlot === targetSlot);
    assert.ok(bookedSlot);
    assert.strictEqual(bookedSlot.isBooked, true);
    assert.strictEqual(bookedSlot.isAvailable, false);
    assert.strictEqual(bookedSlot.reason, "Booked by another patient");
  });

  test("8. Double booking the same slot by another patient returns 409 Conflict", async () => {
    const targetDate = "2028-11-20";
    const targetSlot = "02:30 PM";

    const doubleBookRes = await request(
      "POST",
      "/api/appointments",
      {
        doctorId: doctorUser._id.toString(),
        appointmentDate: targetDate,
        timeSlot: targetSlot,
        department: "Cardiology",
        consultationType: "In-Person",
        notes: "Attempted collision",
      },
      patient2Token
    );

    assert.strictEqual(doubleBookRes.status, 409);
    assert.strictEqual(doubleBookRes.body.success, false);
    assert.ok(
      doubleBookRes.body.message.includes("already booked") ||
        doubleBookRes.body.message.includes("conflict")
    );
  });

  test("9. Cancelling an appointment immediately frees the time slot for other patients", async () => {
    const targetDate = "2028-11-20";
    const targetSlot = "02:30 PM";

    // Find the appointment created in test 7
    const appt = await Appointment.findOne({
      doctorId: doctorUser._id,
      appointmentDate: new Date(Date.UTC(2028, 10, 20, 0, 0, 0, 0)),
      timeSlot: targetSlot,
    });
    assert.ok(appt);

    // Patient cancels appointment
    const cancelRes = await request(
      "PUT",
      `/api/appointments/${appt._id}`,
      { status: "Cancelled", cancellationReason: "Schedule conflict" },
      patientToken
    );
    assert.strictEqual(cancelRes.status, 200);

    // Slots should show targetSlot as available again
    const checkSlotsRes = await request(
      "GET",
      `/api/appointments/slots?doctorId=${doctorUser._id}&date=${targetDate}`,
      null,
      patientToken
    );

    const freedSlot = checkSlotsRes.body.slots.find((s) => s.timeSlot === targetSlot);
    assert.ok(freedSlot);
    assert.strictEqual(freedSlot.isBooked, false);
    assert.strictEqual(freedSlot.isAvailable, true);
    assert.strictEqual(freedSlot.reason, "Available");
  });
});
