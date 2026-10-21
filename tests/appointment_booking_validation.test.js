const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
require("dotenv").config();

const User = require("../src/models/User");
const Appointment = require("../src/models/Appointment");
const { validateBookingAvailability } = require("../src/services/doctorAvailabilityService");
const { createAppointment } = require("../src/controllers/appointmentController");

test("Appointment Booking Validation & Slot Parameter Fix Verification", async (t) => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI);
  }

  // Find a verified doctor (e.g. Jeshu or Suresh or Hareesh)
  const doctor = await User.findOne({ role: "doctor", status: "active", verificationStatus: "verified" });
  assert.ok(doctor, "Verified active doctor must exist in database");

  // Find a patient
  const patient = await User.findOne({ role: "patient", phoneNumber: { $ne: "" }, address: { $ne: "" } });
  assert.ok(patient, "Patient with profile details must exist");

  const futureMonday = "2026-10-26"; // Future Monday

  await t.test("1. validateBookingAvailability works with both appointmentDate and date keys", async () => {
    // Calling with appointmentDate
    const res1 = await validateBookingAvailability({
      doctorId: doctor._id,
      appointmentDate: futureMonday,
      timeSlot: "07:00 PM",
      timezone: "Asia/Kolkata",
    });
    assert.equal(res1.isValid, true, `Expected valid with appointmentDate but got: ${res1.message}`);

    // Calling with date (regression test for previous bug)
    const res2 = await validateBookingAvailability({
      doctorId: doctor._id,
      date: new Date(futureMonday + "T00:00:00Z"),
      timeSlot: "07:00 PM",
      timezone: "Asia/Kolkata",
    });
    assert.equal(res2.isValid, true, `Expected valid with date but got: ${res2.message}`);
  });

  await t.test("2. validateBookingAvailability accepts single-digit hour format e.g. 7:00 PM", async () => {
    const res = await validateBookingAvailability({
      doctorId: doctor._id,
      appointmentDate: futureMonday,
      timeSlot: "7:00 PM",
      timezone: "Asia/Kolkata",
    });
    assert.equal(res.isValid, true, `Expected 7:00 PM to be valid but got: ${res.message}`);
    assert.equal(res.cleanTimeSlot, "07:00 PM");
  });

  await t.test("3. Missing date or slot properly returns required error", async () => {
    const resMissingSlot = await validateBookingAvailability({
      doctorId: doctor._id,
      appointmentDate: futureMonday,
      timeSlot: "",
      timezone: "Asia/Kolkata",
    });
    assert.equal(resMissingSlot.isValid, false);
    assert.equal(resMissingSlot.statusCode, 400);
    assert.equal(resMissingSlot.message, "Appointment date and a valid time slot are required.");

    const resMissingDate = await validateBookingAvailability({
      doctorId: doctor._id,
      appointmentDate: "",
      timeSlot: "07:00 PM",
      timezone: "Asia/Kolkata",
    });
    assert.equal(resMissingDate.isValid, false);
    assert.equal(resMissingDate.statusCode, 400);
    assert.equal(resMissingDate.message, "Appointment date and a valid time slot are required.");
  });

  await t.test("4. createAppointment controller handles booking and normalizes 7:00 PM to 07:00 PM", async () => {
    let statusCode = 200;
    let resJson = null;

    const mockRes = {
      status: (code) => {
        statusCode = code;
        return {
          json: (data) => {
            resJson = data;
          },
        };
      },
      json: (data) => {
        resJson = data;
      },
    };

    // Clean up any existing test appointment for this slot
    await Appointment.deleteMany({
      doctorId: doctor._id,
      appointmentDate: new Date(futureMonday + "T00:00:00Z"),
      timeSlot: { $in: ["7:00 PM", "07:00 PM"] },
      reason: "Automated Verification Test Booking",
    });

    const mockReq = {
      user: patient,
      body: {
        doctorId: doctor._id.toString(),
        appointmentDate: futureMonday,
        timeSlot: "7:00 PM",
        consultationType: "In-Person",
        reason: "Automated Verification Test Booking",
        timezone: "Asia/Kolkata",
      },
    };

    await createAppointment(mockReq, mockRes);
    assert.equal(statusCode, 201, `Booking failed: ${resJson?.message}`);
    assert.ok(resJson.success);
    assert.ok(resJson.appointment);
    assert.equal(resJson.appointment.timeSlot, "07:00 PM");

    // Clean up created test appointment
    await Appointment.findByIdAndDelete(resJson.appointment._id);
  });

  await mongoose.disconnect();
});
