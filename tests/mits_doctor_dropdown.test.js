const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
require("dotenv").config();

const User = require("../src/models/User");
const Hospital = require("../src/models/Hospital");
const { getDoctorsDirectory, getAvailableSlots } = require("../src/controllers/appointmentController");

test("MITS College Hospital Doctor Dropdown & Data Isolation Verification", async (t) => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI);
  }

  const mitsHospital = await Hospital.findOne({ hospitalCode: "MITS02" });
  assert.ok(mitsHospital, "MITS College hospital (MITS02) must exist in database");
  const mitsId = mitsHospital._id.toString();

  await t.test("1. Scoped query with MITS College hospitalId returns Jeshu and preserves hospital isolation", async () => {
    let statusCode = 200;
    let resData = null;
    const mockRes = {
      status: (code) => {
        statusCode = code;
        return {
          json: (d) => {
            resData = d;
          },
        };
      },
      json: (d) => {
        resData = d;
      },
    };

    const req = {
      query: { hospitalId: mitsId },
    };

    await getDoctorsDirectory(req, mockRes);
    assert.equal(statusCode, 200);
    assert.ok(resData.success);
    assert.ok(Array.isArray(resData.doctors));

    // Must find Jeshu
    const jeshuDoc = resData.doctors.find((d) => d.email === "23691a3167@mits.ac.in");
    assert.ok(jeshuDoc, "Doctor Jeshu must be returned in MITS College doctor directory");
    assert.equal(jeshuDoc.name, "jeshu");
    assert.equal(jeshuDoc.hospitalName, mitsHospital.name);

    // Must find Hareesh
    const hareeshDoc = resData.doctors.find((d) => d.email === "hareeshamanchi@gmail.com");
    assert.ok(hareeshDoc, "Doctor Hareesh Amanchi must be returned in MITS College doctor directory");

    // Tenant Isolation: ALL returned doctors must belong ONLY to MITS College
    for (const doc of resData.doctors) {
      assert.equal(
        doc.hospitalId.toString(),
        mitsId,
        `Tenant Isolation Violation: Doctor ${doc.name} belongs to ${doc.hospitalId}, not MITS College`
      );
    }
  });

  await t.test("2. General directory excludes suspended doctors and includes verified active doctors", async () => {
    let statusCode = 200;
    let resData = null;
    const mockRes = {
      status: (code) => {
        statusCode = code;
        return {
          json: (d) => {
            resData = d;
          },
        };
      },
      json: (d) => {
        resData = d;
      },
    };

    const req = {
      query: {},
    };

    await getDoctorsDirectory(req, mockRes);
    assert.equal(statusCode, 200);
    assert.ok(resData.success);

    // Jeshu is verified active and included
    const jeshuDoc = resData.doctors.find((d) => d.email === "23691a3167@mits.ac.in");
    assert.ok(jeshuDoc, "Jeshu must appear in general verified directory");

    // Suspended doctor (harini) must be EXCLUDED
    const suspendedDoc = resData.doctors.find((d) => d.email === "harini@gmail.com");
    assert.equal(suspendedDoc, undefined, "Suspended doctor must be excluded from directory");
  });

  await t.test("3. getAvailableSlots allows Jeshu to generate consultation slots", async () => {
    const jeshuUser = await User.findOne({ email: "23691a3167@mits.ac.in" });
    assert.ok(jeshuUser, "Jeshu user record must exist");

    let statusCode = 200;
    let resData = null;
    const mockRes = {
      status: (code) => {
        statusCode = code;
        return {
          json: (d) => {
            resData = d;
          },
        };
      },
      json: (d) => {
        resData = d;
      },
    };

    // Use a future Monday to ensure it's a working day
    const futureDate = "2026-10-26";
    const req = {
      query: {
        doctorId: jeshuUser._id.toString(),
        date: futureDate,
        timezone: "Asia/Kolkata",
      },
    };

    await getAvailableSlots(req, mockRes);
    assert.equal(statusCode, 200, `Expected 200 but got ${statusCode}: ${resData?.message}`);
    assert.ok(resData.success);
    assert.ok(Array.isArray(resData.slots));
    assert.ok(resData.slots.length > 0, "Jeshu must have available time slots on working day");
  });

  await mongoose.disconnect();
});
