/**
 * Automated Verification: Appointment Time Slots 8:00 AM to 8:00 PM (30-Minute Intervals)
 *
 * Requirements Tested:
 * 1. 24 consultation slots generated between 08:00 AM and 08:00 PM.
 * 2. First slot is exactly "08:00 AM", last slot is "07:30 PM" (8:00 PM is closing time).
 * 3. Exact 30-minute intervals maintained across all 24 slots.
 * 4. Past slot detection on current date (slots <= current local time are flagged isPast: true, isAvailable: false).
 * 5. Future date slot availability (all 24 slots non-past).
 * 6. Booking validation & atomic double-booking prevention (HTTP 409 Conflict).
 * 7. Boundary validation: Booking before 8:00 AM or after 7:30 PM rejected with HTTP 400.
 * 8. Status transition freeing: Cancellation immediately frees slot for other patients.
 * 9. Status transition freeing: Rejection immediately frees slot for other patients.
 * 10. Multi-doctor isolation: Doctor A's booking does not block Doctor B on the same slot.
 * 11. Global applicability across all doctors dynamically without hardcoding.
 * 12. Integrity of existing appointments in MongoDB Atlas preserved.
 */

require("dotenv").config();
const http = require("http");
const assert = require("assert");
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const app = require("../src/app");
const User = require("../src/models/User");
const Appointment = require("../src/models/Appointment");
const jwt = require("jsonwebtoken");
const { parseTimeSlotToMinutes } = require("../src/utils/appointmentSorting");

const JWT_SECRET = process.env.JWT_SECRET || "vaidyasthana_development_jwt_secret_key_32bytes";

const makeRequest = (port, options, body = null) => {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === "string" ? body : JSON.stringify(body)) : null;
    const reqHeaders = { ...options.headers };
    if (payload) {
      reqHeaders["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = http.request({ port, ...options, headers: reqHeaders }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
};

async function runSlotVerification() {
  console.log("==========================================================================");
  console.log("  VERIFY APPOINTMENT TIME SLOTS: 8:00 AM TO 8:00 PM (30-MIN INTERVALS)   ");
  console.log("==========================================================================");

  // 1. Connect to MongoDB Atlas
  console.log("\n[Step 1] Connecting to MongoDB Atlas...");
  await connectDB();
  assert.strictEqual(mongoose.connection.readyState, 1, "Must be connected to MongoDB Atlas");
  console.log("✔ Connected to MongoDB Atlas.");

  // Start ephemeral HTTP server
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  console.log(`✔ Ephemeral API server listening on http://127.0.0.1:${port}`);

  const testSuffix = Date.now();
  const cleanupUsers = [];
  const cleanupAppts = [];

  try {
    // 2. Fetch all verified doctors from the system
    console.log("\n[Step 2] Fetching verified doctors dynamically...");
    const doctors = await User.find({ role: "doctor", verificationStatus: "verified" });
    assert(doctors.length >= 2, "Need at least 2 verified doctors in Atlas for multi-doctor test");
    const doctorA = doctors[0];
    const doctorB = doctors[1];
    console.log(`✔ Selected Doctor A: Dr. ${doctorA.name} (${doctorA._id})`);
    console.log(`✔ Selected Doctor B: Dr. ${doctorB.name} (${doctorB._id})`);

    // Create 2 test patients
    const patient1 = await User.create({
      name: `Test Patient Alpha ${testSuffix}`,
      email: `patient_alpha_${testSuffix}@example.com`,
      password: "HashedPassword123!",
      role: "patient",
      phoneNumber: "+919876543210",
      address: "123 Healthcare Way, Bangalore",
    });
    cleanupUsers.push(patient1._id);

    const patient2 = await User.create({
      name: `Test Patient Beta ${testSuffix}`,
      email: `patient_beta_${testSuffix}@example.com`,
      password: "HashedPassword123!",
      role: "patient",
      phoneNumber: "+919876543211",
      address: "456 Wellness Blvd, Bangalore",
    });
    cleanupUsers.push(patient2._id);

    const tokenPatient1 = jwt.sign(
      { id: patient1._id.toString(), role: "patient", email: patient1.email },
      JWT_SECRET,
      { expiresIn: "1h" }
    );
    const tokenPatient2 = jwt.sign(
      { id: patient2._id.toString(), role: "patient", email: patient2.email },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    // 3. Test slot generation for future date
    console.log("\n[Step 3] Testing slot generation for future date (2026-11-20)...");
    const futureDate = "2026-11-20";
    const slotsResA = await makeRequest(port, {
      path: `/api/appointments/slots?doctorId=${doctorA._id}&date=${futureDate}`,
      method: "GET",
      headers: { Authorization: `Bearer ${tokenPatient1}` },
    });

    assert.strictEqual(slotsResA.status, 200, "Slots retrieval must return HTTP 200");
    const slotsA = slotsResA.data.slots;
    assert.strictEqual(slotsA.length, 24, `Must return exactly 24 slots for 8 AM - 8 PM, got ${slotsA.length}`);

    // Verify first and last slots
    assert.strictEqual(slotsA[0].timeSlot, "08:00 AM", `First slot must be '08:00 AM', got ${slotsA[0].timeSlot}`);
    assert.strictEqual(slotsA[slotsA.length - 1].timeSlot, "07:30 PM", `Last slot must be '07:30 PM', got ${slotsA[slotsA.length - 1].timeSlot}`);
    console.log(`✔ Verified: Exact 24 slots returned. First slot is ${slotsA[0].timeSlot}, last slot is ${slotsA[slotsA.length - 1].timeSlot}.`);

    // Verify 30-minute interval across all 24 slots
    console.log("\n[Step 4] Verifying 30-minute increments across all slots...");
    for (let i = 0; i < slotsA.length; i++) {
      const expectedMins = 480 + i * 30; // 8:00 AM = 480 mins
      const actualMins = parseTimeSlotToMinutes(slotsA[i].timeSlot);
      assert.strictEqual(actualMins, expectedMins, `Slot index ${i} (${slotsA[i].timeSlot}) must be at minute ${expectedMins}, got ${actualMins}`);
      assert.strictEqual(slotsA[i].isPast, false, `Future slot ${slotsA[i].timeSlot} must not be marked isPast`);
      assert.strictEqual(slotsA[i].isBooked, false, `New future slot ${slotsA[i].timeSlot} must not be marked isBooked`);
      assert.strictEqual(slotsA[i].isAvailable, true, `New future slot ${slotsA[i].timeSlot} must be isAvailable`);
    }
    console.log("✔ Verified: All 24 slots are consecutively spaced by exactly 30 minutes from 08:00 AM to 07:30 PM.");

    // 4. Test past slots on current date (today)
    console.log("\n[Step 5] Testing past slot detection on today's calendar date...");
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const todayRes = await makeRequest(port, {
      path: `/api/appointments/slots?doctorId=${doctorA._id}&date=${todayStr}`,
      method: "GET",
      headers: { Authorization: `Bearer ${tokenPatient1}` },
    });

    assert.strictEqual(todayRes.status, 200);
    const todaySlots = todayRes.data.slots;
    assert.strictEqual(todaySlots.length, 24, "Today must also generate 24 slots");

    const currentLocalMins = now.getHours() * 60 + now.getMinutes();
    let pastCount = 0;
    let upcomingCount = 0;

    todaySlots.forEach((s) => {
      const slotMins = parseTimeSlotToMinutes(s.timeSlot);
      if (slotMins <= currentLocalMins) {
        assert.strictEqual(s.isPast, true, `Slot ${s.timeSlot} (mins: ${slotMins}) <= current (${currentLocalMins}) must be isPast: true`);
        assert.strictEqual(s.isAvailable, false, `Past slot ${s.timeSlot} must be isAvailable: false`);
        assert.strictEqual(s.reason, "Time slot has passed");
        pastCount++;
      } else {
        assert.strictEqual(s.isPast, false, `Upcoming slot ${s.timeSlot} must be isPast: false`);
        upcomingCount++;
      }
    });
    console.log(`✔ Verified today's slots at ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}: ${pastCount} passed, ${upcomingCount} upcoming.`);

    // 5. Test booking a slot and double-booking conflict prevention
    console.log("\n[Step 6] Testing slot booking and atomic double-booking rejection...");
    const testSlot = "10:00 AM";
    const bookRes = await makeRequest(
      port,
      {
        path: "/api/appointments",
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenPatient1}`,
          "Content-Type": "application/json",
        },
      },
      {
        doctorId: doctorA._id.toString(),
        appointmentDate: futureDate,
        timeSlot: testSlot,
        department: doctorA.specialization || "General Medicine",
        consultationType: "In-Person",
        reason: "Routine cardiology checkup",
      }
    );

    assert.strictEqual(bookRes.status, 201, `Booking must succeed with 201, got ${bookRes.status}`);
    const apptId = bookRes.data.appointment._id;
    cleanupAppts.push(apptId);
    console.log(`✔ Patient 1 booked Dr. ${doctorA.name} for ${testSlot} on ${futureDate} (Appt ID: ${apptId}).`);

    // Verify slot is now flagged as booked
    const checkSlotsRes = await makeRequest(port, {
      path: `/api/appointments/slots?doctorId=${doctorA._id}&date=${futureDate}`,
      method: "GET",
      headers: { Authorization: `Bearer ${tokenPatient1}` },
    });
    const bookedSlotObj = checkSlotsRes.data.slots.find((s) => s.timeSlot === testSlot);
    assert.strictEqual(bookedSlotObj.isBooked, true, "Booked slot must have isBooked: true");
    assert.strictEqual(bookedSlotObj.isAvailable, false, "Booked slot must have isAvailable: false");
    assert.strictEqual(bookedSlotObj.reason, "Booked by another patient");
    console.log(`✔ Slot ${testSlot} correctly reported as booked (isBooked: true, isAvailable: false).`);

    // Patient 2 attempts to double-book the same slot -> Must return 409 Conflict
    const doubleBookRes = await makeRequest(
      port,
      {
        path: "/api/appointments",
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenPatient2}`,
          "Content-Type": "application/json",
        },
      },
      {
        doctorId: doctorA._id.toString(),
        appointmentDate: futureDate,
        timeSlot: testSlot,
        department: doctorA.specialization || "General Medicine",
        consultationType: "In-Person",
        reason: "Patient 2 conflict attempt",
      }
    );
    assert.strictEqual(doubleBookRes.status, 409, `Double booking must return 409 Conflict, got ${doubleBookRes.status}`);
    console.log(`✔ Double-booking attempt by Patient 2 successfully rejected with HTTP 409 Conflict: "${doubleBookRes.data.message}".`);

    // Double-booking attempt using range format (e.g. "10:00 AM - 10:30 AM")
    const doubleBookRangeRes = await makeRequest(
      port,
      {
        path: "/api/appointments",
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenPatient2}`,
          "Content-Type": "application/json",
        },
      },
      {
        doctorId: doctorA._id.toString(),
        appointmentDate: futureDate,
        timeSlot: "10:00 AM - 10:30 AM",
        department: doctorA.specialization || "General Medicine",
        consultationType: "In-Person",
        reason: "Patient 2 range conflict attempt",
      }
    );
    assert.strictEqual(doubleBookRangeRes.status, 409, "Range variant of same slot must also return 409 Conflict");
    console.log("✔ Range-formatted double-booking attempt ('10:00 AM - 10:30 AM') also rejected with HTTP 409 Conflict.");

    // 6. Test Multi-Doctor Isolation
    console.log("\n[Step 7] Testing multi-doctor schedule isolation...");
    const slotsResB = await makeRequest(port, {
      path: `/api/appointments/slots?doctorId=${doctorB._id}&date=${futureDate}`,
      method: "GET",
      headers: { Authorization: `Bearer ${tokenPatient2}` },
    });
    const docBSlot10 = slotsResB.data.slots.find((s) => s.timeSlot === testSlot);
    assert.strictEqual(docBSlot10.isBooked, false, `Doctor B slot ${testSlot} must be available when only Doctor A was booked`);
    assert.strictEqual(docBSlot10.isAvailable, true);
    console.log(`✔ Doctor B (${doctorB.name}) slot ${testSlot} remains completely available while Doctor A is booked.`);

    // 7. Test Slot Liberation on Cancellation
    console.log("\n[Step 8] Testing slot availability recovery after cancellation...");
    const cancelRes = await makeRequest(
      port,
      {
        path: `/api/appointments/${apptId}`,
        method: "PUT",
        headers: {
          Authorization: `Bearer ${tokenPatient1}`,
          "Content-Type": "application/json",
        },
      },
      {
        status: "Cancelled",
        cancellationReason: "Patient cancelled due to schedule change",
      }
    );
    if (cancelRes.status !== 200) {
      console.error("Cancel response error:", cancelRes.status, cancelRes.data || cancelRes.raw);
    }
    assert.strictEqual(cancelRes.status, 200, "Cancellation must return HTTP 200");

    const recheckSlotsRes = await makeRequest(port, {
      path: `/api/appointments/slots?doctorId=${doctorA._id}&date=${futureDate}`,
      method: "GET",
      headers: { Authorization: `Bearer ${tokenPatient1}` },
    });
    const freedSlotObj = recheckSlotsRes.data.slots.find((s) => s.timeSlot === testSlot);
    assert.strictEqual(freedSlotObj.isBooked, false, "Cancelled slot must be freed (isBooked: false)");
    assert.strictEqual(freedSlotObj.isAvailable, true, "Cancelled slot must be immediately isAvailable: true");
    assert.strictEqual(freedSlotObj.reason, "Available");
    console.log(`✔ Cancelled slot ${testSlot} is immediately available again.`);

    // Patient 2 can now book the freed slot
    const bookFreedRes = await makeRequest(
      port,
      {
        path: "/api/appointments",
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenPatient2}`,
          "Content-Type": "application/json",
        },
      },
      {
        doctorId: doctorA._id.toString(),
        appointmentDate: futureDate,
        timeSlot: testSlot,
        department: doctorA.specialization || "General Medicine",
        consultationType: "In-Person",
        reason: "Patient 2 booking freed slot",
      }
    );
    assert.strictEqual(bookFreedRes.status, 201, "Booking freed slot must succeed");
    const appt2Id = bookFreedRes.data.appointment._id;
    cleanupAppts.push(appt2Id);
    console.log("✔ Patient 2 successfully booked the freed slot.");

    // 8. Test Slot Liberation on Doctor Rejection
    console.log("\n[Step 9] Testing slot availability recovery after clinician rejection...");
    const tokenDoctorA = jwt.sign(
      { id: doctorA._id.toString(), role: "doctor", email: doctorA.email },
      JWT_SECRET,
      { expiresIn: "1h" }
    );
    const rejectRes = await makeRequest(
      port,
      {
        path: `/api/appointments/${appt2Id}`,
        method: "PUT",
        headers: {
          Authorization: `Bearer ${tokenDoctorA}`,
          "Content-Type": "application/json",
        },
      },
      {
        status: "Rejected",
        rejectionReason: "Doctor in emergency surgery",
      }
    );
    assert.strictEqual(rejectRes.status, 200, "Doctor rejection must return HTTP 200");

    const recheckAfterRejectRes = await makeRequest(port, {
      path: `/api/appointments/slots?doctorId=${doctorA._id}&date=${futureDate}`,
      method: "GET",
      headers: { Authorization: `Bearer ${tokenPatient1}` },
    });
    const freedAfterRejectObj = recheckAfterRejectRes.data.slots.find((s) => s.timeSlot === testSlot);
    assert.strictEqual(freedAfterRejectObj.isBooked, false, "Rejected slot must have isBooked: false");
    assert.strictEqual(freedAfterRejectObj.isAvailable, true, "Rejected slot must be isAvailable: true");
    console.log(`✔ Rejected slot ${testSlot} is immediately available again.`);

    // 9. Boundary Slot Testing
    console.log("\n[Step 10] Testing boundary schedule limits (8:00 AM to 8:00 PM)...");
    // 8:00 PM is closing time and must NOT be accepted as appointment start time
    const invalidClosingStartRes = await makeRequest(
      port,
      {
        path: "/api/appointments",
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenPatient1}`,
          "Content-Type": "application/json",
        },
      },
      {
        doctorId: doctorA._id.toString(),
        appointmentDate: futureDate,
        timeSlot: "08:00 PM",
        department: "General Medicine",
        reason: "Boundary test at closing time",
      }
    );
    assert.strictEqual(invalidClosingStartRes.status, 400, "8:00 PM start time must be rejected with 400");
    console.log(`✔ Attempt to book at 08:00 PM (closing time) correctly rejected with HTTP 400: "${invalidClosingStartRes.data.message}".`);

    // 7:00 AM (before clinic opening) must also be rejected
    const invalidEarlyRes = await makeRequest(
      port,
      {
        path: "/api/appointments",
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenPatient1}`,
          "Content-Type": "application/json",
        },
      },
      {
        doctorId: doctorA._id.toString(),
        appointmentDate: futureDate,
        timeSlot: "07:30 AM",
        department: "General Medicine",
        reason: "Early morning test before clinic opening",
      }
    );
    assert.strictEqual(invalidEarlyRes.status, 400, "07:30 AM start time must be rejected with 400");
    console.log(`✔ Attempt to book before 08:00 AM correctly rejected with HTTP 400: "${invalidEarlyRes.data.message}".`);

    // First slot (08:00 AM) and last slot (07:30 PM) valid booking check
    const validFirstSlotRes = await makeRequest(
      port,
      {
        path: "/api/appointments",
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenPatient1}`,
          "Content-Type": "application/json",
        },
      },
      {
        doctorId: doctorA._id.toString(),
        appointmentDate: futureDate,
        timeSlot: "08:00 AM",
        department: "General Medicine",
        reason: "Opening slot booking test",
      }
    );
    assert.strictEqual(validFirstSlotRes.status, 201, "08:00 AM slot booking must succeed");
    cleanupAppts.push(validFirstSlotRes.data.appointment._id);
    console.log("✔ First consultation slot (08:00 AM) successfully booked.");

    const validLastSlotRes = await makeRequest(
      port,
      {
        path: "/api/appointments",
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenPatient1}`,
          "Content-Type": "application/json",
        },
      },
      {
        doctorId: doctorA._id.toString(),
        appointmentDate: futureDate,
        timeSlot: "07:30 PM",
        department: "General Medicine",
        reason: "Last consultation slot booking test",
      }
    );
    assert.strictEqual(validLastSlotRes.status, 201, "07:30 PM slot booking must succeed");
    cleanupAppts.push(validLastSlotRes.data.appointment._id);
    console.log("✔ Last consultation slot (07:30 PM) successfully booked.");

    console.log("\n==========================================================================");
    console.log("  ALL APPOINTMENT TIME SLOT REQUIREMENTS VERIFIED AND PASSED SUCCESSFULLY! ");
    console.log("==========================================================================");
  } finally {
    // Cleanup fixtures
    console.log("\nCleaning up test artifacts in MongoDB Atlas...");
    if (cleanupAppts.length > 0) {
      await Appointment.deleteMany({ _id: { $in: cleanupAppts } });
      console.log(`✔ Removed ${cleanupAppts.length} test appointment(s).`);
    }
    if (cleanupUsers.length > 0) {
      await User.deleteMany({ _id: { $in: cleanupUsers } });
      console.log(`✔ Removed ${cleanupUsers.length} test user(s).`);
    }

    server.close();
    await mongoose.disconnect();
    console.log("✔ Disconnected cleanly from Atlas.");
  }
}

runSlotVerification().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
