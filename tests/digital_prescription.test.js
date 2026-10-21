const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { Writable } = require("stream");
require("dotenv").config();

const User = require("../src/models/User");
const Hospital = require("../src/models/Hospital");
const Prescription = require("../src/models/Prescription");
const Medication = require("../src/models/Medication");
const { generatePrescriptionPDF } = require("../src/utils/prescriptionPdfGenerator");
const {
  createPrescription,
  getPrescriptions,
  getPrescriptionById,
  createMedicationRemindersFromPrescription,
} = require("../src/controllers/prescriptionController");

test("Feature 3: Digital Prescriptions Suite", async (t) => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI);
  }

  // Find a verified doctor
  const doctor = await User.findOne({ role: "doctor", status: "active" });
  assert.ok(doctor, "Active doctor must exist in database");

  // Find a patient
  const patient = await User.findOne({ role: "patient" });
  assert.ok(patient, "Patient must exist in database");

  // Find a hospital
  const hospital = await User.findOne({ role: "hospital_admin", hospitalId: { $ne: null } })
    .then(async (admin) => {
      if (admin && admin.hospitalId) {
        return Hospital.findById(admin.hospitalId);
      }
      return Hospital.findOne();
    });

  let createdPrescriptionId = null;

  // 1. PDF Generation test with stream
  await t.test("1. generatePrescriptionPDF generates valid PDF stream", async () => {
    const mockPrescription = {
      prescriptionNumber: "TEST-20261021-9999",
      doctorName: doctor.name,
      doctorSpecialization: doctor.specialization || "General Medicine",
      doctorQualifications: doctor.qualifications || "MBBS",
      doctorRegistrationNumber: "MCI-12345",
      patientName: patient.name,
      patientAge: "30 yrs",
      patientGender: "Female",
      patientPhone: "+919876543210",
      hospitalName: hospital ? hospital.name : "Test Hospital",
      hospitalCode: hospital ? hospital.hospitalCode : "TH",
      hospitalAddress: "123 Medical Center",
      hospitalPhone: "+91-11-23456789",
      diagnosis: "Acute Bronchitis and Seasonal Pharyngitis",
      vitals: {
        bloodPressure: "120/80 mmHg",
        pulseRate: "72",
        temperature: "98.6 F",
        weight: "65 kg",
        spo2: "99",
      },
      medications: [
        {
          name: "Amoxicillin & Clavulanate",
          dosage: "625",
          dosageUnit: "mg",
          route: "Oral",
          frequency: "twice_daily",
          timing: "after_food",
          duration: "5 days",
          durationDays: 5,
          instructions: "Complete entire 5-day antibiotic course",
          reminderTimes: ["08:00", "20:00"],
        },
        {
          name: "Paracetamol",
          dosage: "650",
          dosageUnit: "mg",
          route: "Oral",
          frequency: "thrice_daily",
          timing: "after_food",
          duration: "3 days",
          durationDays: 3,
          instructions: "Take only if body temperature exceeds 99 F",
          reminderTimes: ["08:00", "14:00", "20:00"],
        },
      ],
      generalInstructions: "Rest adequately and drink warm fluids.",
      followUpDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      isSigned: true,
      signedAt: new Date(),
    };

    let totalBytes = 0;
    const testWritable = new Writable({
      write(chunk, encoding, callback) {
        totalBytes += chunk.length;
        callback();
      },
    });

    await generatePrescriptionPDF(mockPrescription, testWritable);
    assert.ok(totalBytes > 1000, `PDF should be generated with valid binary content, got ${totalBytes} bytes`);
  });

  // 2. Clinician sign-off requirement check
  await t.test("2. createPrescription rejects submission without clinician confirmation and sign-off", async () => {
    let statusCode = null;
    let jsonBody = null;

    const req = {
      user: doctor,
      body: {
        patientId: patient._id.toString(),
        diagnosis: "Upper Respiratory Tract Infection",
        medications: [
          {
            name: "Cetirizine",
            dosage: "10",
            frequency: "once_daily",
            duration: "5 days",
          },
        ],
        isSigned: false, // Requirement 8: Clinician MUST sign off
      },
    };

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        jsonBody = body;
        return this;
      },
    };

    await createPrescription(req, res);
    assert.equal(statusCode, 400);
    assert.equal(jsonBody.success, false);
    assert.match(jsonBody.message, /Clinician sign-off is mandatory/i);
  });

  // 3. Authorized doctor successfully creates a signed prescription
  await t.test("3. createPrescription creates signed prescription with medications and vitals", async () => {
    let statusCode = null;
    let jsonBody = null;

    const req = {
      user: doctor,
      body: {
        patientId: patient._id.toString(),
        diagnosis: "Hypertension & Mild Asthenia",
        vitals: {
          bloodPressure: "130/85",
          pulseRate: "76",
        },
        medications: [
          {
            name: "Telmisartan",
            dosage: "40",
            dosageUnit: "mg",
            route: "Oral",
            frequency: "once_daily",
            timing: "before_food",
            duration: "14 days",
            instructions: "Take every morning before breakfast",
          },
        ],
        generalInstructions: "Low sodium diet and mild daily walking.",
        isSigned: true,
      },
    };

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        jsonBody = body;
        return this;
      },
    };

    await createPrescription(req, res);
    assert.equal(statusCode, 201, `Failed with body: ${JSON.stringify(jsonBody)}`);
    assert.equal(jsonBody.success, true);
    assert.ok(jsonBody.prescription._id);
    assert.equal(jsonBody.prescription.medications[0].name, "Telmisartan");
    assert.equal(jsonBody.prescription.isSigned, true);

    createdPrescriptionId = jsonBody.prescription._id;
  });

  // 4. Role-based and tenant isolation for getPrescriptions
  await t.test("4. getPrescriptions enforces role-based querying", async () => {
    let statusCode = null;
    let jsonBody = null;

    // Patient querying prescriptions should only get their own
    const patientReq = {
      user: { _id: patient._id, role: "patient" },
      query: {},
    };

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        jsonBody = body;
        return this;
      },
    };

    await getPrescriptions(patientReq, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonBody.success, true);
    assert.ok(Array.isArray(jsonBody.prescriptions));
    jsonBody.prescriptions.forEach((p) => {
      const pPatientId = p.patientId?._id ? p.patientId._id.toString() : p.patientId.toString();
      assert.equal(pPatientId, patient._id.toString(), "Prescription patient must match authenticated patient");
    });
  });

  // 5. Patient integrates prescription with medication reminders
  await t.test("5. createMedicationRemindersFromPrescription schedules reminders in Medication collection", async () => {
    assert.ok(createdPrescriptionId, "Must have created prescription ID from step 3");

    let statusCode = null;
    let jsonBody = null;

    const req = {
      user: { _id: patient._id, role: "patient" },
      params: { id: createdPrescriptionId.toString() },
    };

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        jsonBody = body;
        return this;
      },
    };

    await createMedicationRemindersFromPrescription(req, res);
    assert.equal(statusCode, 200, `Failed with: ${JSON.stringify(jsonBody)}`);
    assert.equal(jsonBody.success, true);
    assert.ok(jsonBody.reminders.length >= 1);

    // Verify record in Medication collection
    const createdMed = await Medication.findOne({
      patientId: patient._id,
      prescriptionRef: createdPrescriptionId,
    });
    assert.ok(createdMed, "Medication reminder record must exist");
    assert.equal(createdMed.name, "Telmisartan");
    assert.equal(createdMed.source, "doctor_prescribed");
    assert.equal(createdMed.prescribedBy.toString(), doctor._id.toString());

    // Calling it again should be idempotent and not create duplicate records
    await createMedicationRemindersFromPrescription(req, res);
    assert.equal(statusCode, 200);
    const count = await Medication.countDocuments({
      patientId: patient._id,
      prescriptionRef: createdPrescriptionId,
    });
    assert.equal(count, 1, "Duplicate reminders must not be created");
  });

  // Cleanup created test records
  if (createdPrescriptionId) {
    await Prescription.findByIdAndDelete(createdPrescriptionId);
    await Medication.deleteMany({ prescriptionRef: createdPrescriptionId });
  }

  await mongoose.disconnect();
});
