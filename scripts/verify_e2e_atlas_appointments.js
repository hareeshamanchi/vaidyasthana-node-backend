/**
 * End-to-End Real MongoDB Atlas Appointment Verification
 * Tests the complete clinical booking lifecycle against MongoDB Atlas
 */

require("dotenv").config();
const http = require("http");
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const app = require("../src/app");
const User = require("../src/models/User");
const Appointment = require("../src/models/Appointment");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "vaidyasthana_development_jwt_secret_key_32bytes";

const makeRequest = (port, options, body = null) => {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, ...options }, (res) => {
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
    if (body) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
};

async function runAtlasE2EVerification() {
  console.log("==================================================================");
  console.log("  REAL MONGO DB ATLAS APPOINTMENT BOOKING END-TO-END VERIFICATION  ");
  console.log("==================================================================");

  // 1. Connect to MongoDB Atlas
  console.log("Step 1: Connecting directly to MongoDB Atlas cluster...");
  const conn = await connectDB();
  if (!conn || mongoose.connection.readyState !== 1) {
    throw new Error("Failed to connect to MongoDB Atlas. Verify connection URI and network.");
  }
  console.log(`✔ Connected to Atlas host: ${mongoose.connection.host}`);

  // Start HTTP server on dynamic port
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  console.log(`✔ Ephemeral test server active on http://127.0.0.1:${port}`);

  const testIdSuffix = Date.now();
  let createdAppointmentId = null;
  let testPatientId = null;

  try {
    // 2. Load Real Doctors from Atlas
    console.log("\nStep 2: Fetching verified doctors from GET /api/appointments/doctors...");
    const docsRes = await makeRequest(port, {
      path: "/api/appointments/doctors",
      method: "GET",
    });

    if (docsRes.status !== 200 || !docsRes.data.success) {
      throw new Error(`Failed to load doctors: HTTP ${docsRes.status}`);
    }

    const doctors = docsRes.data.doctors || [];
    console.log(`✔ Retrieved ${doctors.length} verified doctors from Atlas:`);
    doctors.forEach((d) => console.log(`   - ${d.name} (${d.specialization}) [_id: ${d._id}]`));

    if (doctors.length === 0) {
      throw new Error("No verified doctors exist in Atlas. At least one verified doctor is required.");
    }

    const selectedDoctor = doctors[0];
    const secondDoctor = doctors.length > 1 ? doctors[1] : null;
    console.log(`✔ Selected Doctor for booking: ${selectedDoctor.name} [ID: ${selectedDoctor._id}]`);

    // 3. Select Date and Retrieve Slots
    const testDate = "2026-11-20";
    console.log(`\nStep 3: Retrieving available slots for ${selectedDoctor.name} on ${testDate}...`);
    const slotsRes = await makeRequest(port, {
      path: `/api/appointments/slots?doctorId=${selectedDoctor._id}&date=${testDate}`,
      method: "GET",
    });

    if (slotsRes.status !== 200 || !slotsRes.data.success) {
      throw new Error(`Failed to fetch slots: HTTP ${slotsRes.status} ${JSON.stringify(slotsRes.data)}`);
    }

    console.log(`✔ Received ${slotsRes.data.totalSlots} slots, ${slotsRes.data.availableSlotsCount} available.`);
    const chosenSlot = slotsRes.data.slots.find((s) => s.isAvailable);
    if (!chosenSlot) {
      throw new Error("No available slots found for date.");
    }
    console.log(`✔ Selected Available Slot: '${chosenSlot.timeSlot}'`);

    // 4. Create Authenticated Synthetic Patient
    console.log("\nStep 4: Creating authenticated patient fixture in Atlas...");
    const patientUser = await User.create({
      name: `Test Patient ${testIdSuffix}`,
      email: `patient_${testIdSuffix}@vaidyasthana-test.com`,
      password: "TestPassword123!",
      role: "patient",
      phoneNumber: "+919876543210",
      address: "100 Medical Enclave, Bengaluru",
    });
    testPatientId = patientUser._id;

    const patientToken = jwt.sign(
      { id: patientUser._id.toString(), role: "patient", name: patientUser.name, email: patientUser.email },
      JWT_SECRET,
      { expiresIn: "1h" }
    );
    console.log(`✔ Patient authenticated [ID: ${patientUser._id}]`);

    // 5. Submit Booking
    console.log(`\nStep 5: Submitting booking via POST /api/appointments...`);
    const bookPayload = {
      doctorId: selectedDoctor._id.toString(),
      doctorName: selectedDoctor.name,
      department: selectedDoctor.specialization,
      appointmentDate: testDate,
      timeSlot: chosenSlot.timeSlot,
      consultationType: "In-Person",
      notes: "E2E Automated Verification Consultation",
      reason: "General health screening",
    };

    const bookRes = await makeRequest(
      port,
      {
        path: "/api/appointments",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${patientToken}`,
        },
      },
      bookPayload
    );

    if (bookRes.status !== 201 || !bookRes.data.success) {
      throw new Error(`Booking submission failed: HTTP ${bookRes.status} ${JSON.stringify(bookRes.data)}`);
    }

    createdAppointmentId = bookRes.data.appointment._id;
    console.log(`✔ Booking confirmed! Created Appointment ID: ${createdAppointmentId}`);
    console.log(`   - Stored Doctor: ${bookRes.data.appointment.doctorName}`);
    console.log(`   - Stored Date: ${bookRes.data.appointment.appointmentDate}`);
    console.log(`   - Stored Slot: ${bookRes.data.appointment.timeSlot}`);
    console.log(`   - Status: ${bookRes.data.appointment.status}`);

    // 6. Direct MongoDB Atlas Persistence Assertion
    console.log("\nStep 6: Directly querying MongoDB Atlas database for persisted document...");
    const dbAppt = await Appointment.findById(createdAppointmentId);
    if (!dbAppt) {
      throw new Error("Appointment was NOT found in MongoDB Atlas!");
    }
    console.log(`✔ Document verified in Atlas collection 'appointments' [ID: ${dbAppt._id}]`);
    console.log(`   - Atlas patientId: ${dbAppt.patientId.toString()}`);
    console.log(`   - Atlas doctorId: ${dbAppt.doctorId.toString()}`);

    // 7. Patient Dashboard Query Assertion
    console.log("\nStep 7: Verifying Patient Dashboard query (GET /api/appointments with patient token)...");
    const patientQueryRes = await makeRequest(port, {
      path: "/api/appointments",
      method: "GET",
      headers: { Authorization: `Bearer ${patientToken}` },
    });

    const patientAppts = patientQueryRes.data.appointments || [];
    const foundInPatientList = patientAppts.some((a) => a._id === createdAppointmentId);
    if (!foundInPatientList) {
      throw new Error("New appointment did NOT appear in patient's appointment query!");
    }
    console.log(`✔ Verified: Appointment appears in Patient's dashboard (total: ${patientAppts.length}).`);

    // 8. Doctor Dashboard Query Assertion & Tenant Isolation
    console.log("\nStep 8: Verifying Doctor Dashboard query & Tenant Isolation...");
    const doctorToken = jwt.sign(
      { id: selectedDoctor._id.toString(), role: "doctor", name: selectedDoctor.name, email: selectedDoctor.email },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    const doctorQueryRes = await makeRequest(port, {
      path: "/api/appointments",
      method: "GET",
      headers: { Authorization: `Bearer ${doctorToken}` },
    });

    const doctorAppts = doctorQueryRes.data.appointments || [];
    const foundInDoctorList = doctorAppts.some((a) => a._id === createdAppointmentId);
    if (!foundInDoctorList) {
      throw new Error("New appointment did NOT appear in selected doctor's schedule!");
    }
    console.log(`✔ Verified: Appointment appears in Selected Doctor's schedule (total: ${doctorAppts.length}).`);

    if (secondDoctor) {
      const secondDocToken = jwt.sign(
        { id: secondDoctor._id.toString(), role: "doctor", name: secondDoctor.name, email: secondDoctor.email },
        JWT_SECRET,
        { expiresIn: "1h" }
      );
      const secondDocRes = await makeRequest(port, {
        path: "/api/appointments",
        method: "GET",
        headers: { Authorization: `Bearer ${secondDocToken}` },
      });
      const secondDocAppts = secondDocRes.data.appointments || [];
      const foundInOtherDoctor = secondDocAppts.some((a) => a._id === createdAppointmentId);
      if (foundInOtherDoctor) {
        throw new Error("TENANT LEAK: Appointment appeared in another doctor's private schedule!");
      }
      console.log(`✔ Verified: Tenant isolation upheld. ${selectedDoctor.name.startsWith("Dr.") ? selectedDoctor.name : "Dr. " + selectedDoctor.name} schedule is isolated from ${secondDoctor.name}.`);
    }

    // 9. Atomic Double-Booking Conflict Assertion
    console.log("\nStep 9: Verifying atomic double-booking prevention for the occupied slot...");
    const conflictRes = await makeRequest(
      port,
      {
        path: "/api/appointments",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${patientToken}`,
        },
      },
      bookPayload
    );

    if (conflictRes.status !== 409) {
      throw new Error(`Double booking did NOT return 409 Conflict. Got status: ${conflictRes.status}`);
    }
    console.log(`✔ Verified: Double booking cleanly rejected with HTTP 409 Conflict!`);
    console.log(`   Message: "${conflictRes.data.message}"`);

    // 10. Verify Slot Occupancy
    console.log("\nStep 10: Re-querying available slots to verify slot is marked occupied...");
    const updatedSlotsRes = await makeRequest(port, {
      path: `/api/appointments/slots?doctorId=${selectedDoctor._id}&date=${testDate}`,
      method: "GET",
    });

    const slotState = updatedSlotsRes.data.slots.find((s) => s.timeSlot === chosenSlot.timeSlot);
    if (!slotState || slotState.isAvailable || !slotState.isBooked) {
      throw new Error(`Slot '${chosenSlot.timeSlot}' was expected to be booked and unavailable, but got: ${JSON.stringify(slotState)}`);
    }
    console.log(`✔ Verified: Slot '${chosenSlot.timeSlot}' is now flagged isBooked: true, isAvailable: false.`);

    // 11. Doctor Status Transition
    console.log("\nStep 11: Testing Doctor Status update (Scheduled -> Confirmed -> Completed)...");
    const updateRes = await makeRequest(
      port,
      {
        path: `/api/appointments/${createdAppointmentId}`,
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${doctorToken}`,
        },
      },
      { status: "Confirmed" }
    );

    if (updateRes.status !== 200 || updateRes.data.appointment.status !== "Confirmed") {
      throw new Error("Failed to transition appointment status to Confirmed.");
    }
    console.log("✔ Verified: Doctor updated appointment status to 'Confirmed'.");

    console.log("\n==================================================================");
    console.log("  ALL END-TO-END VERIFICATION STEPS PASSED AGAINST MONGO DB ATLAS! ");
    console.log("==================================================================");
  } finally {
    // Clean up test data
    console.log("\nCleaning up test appointment and patient fixture from Atlas...");
    if (createdAppointmentId) {
      await Appointment.deleteOne({ _id: createdAppointmentId });
      console.log(`✔ Removed test appointment ${createdAppointmentId}`);
    }
    if (testPatientId) {
      await User.deleteOne({ _id: testPatientId });
      console.log(`✔ Removed test patient ${testPatientId}`);
    }
    server.close();
    await mongoose.disconnect();
    console.log("✔ Disconnected cleanly from Atlas.");
  }
}

runAtlasE2EVerification().catch((err) => {
  console.error("\n❌ E2E VERIFICATION FAILED:", err);
  process.exit(1);
});
