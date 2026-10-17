const assert = require("node:assert");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
require("dotenv").config({ path: __dirname + "/../.env" });

const app = require("../src/app");
const User = require("../src/models/User");
const Appointment = require("../src/models/Appointment");
const Report = require("../src/models/Report");
const connectDB = require("../src/config/db");

let server;
let baseUrl;

const request = async (method, path, body = null, token = null) => {
  const url = `${baseUrl}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: res.status, data };
};

const createToken = (user) => {
  const secret = process.env.JWT_SECRET || "vaidyasthana_development_jwt_secret_key_32bytes";
  return jwt.sign(
    {
      id: user._id.toString(),
      role: user.role,
      name: user.name,
      email: user.email,
    },
    secret,
    { expiresIn: "7d" }
  );
};

const createMultipartBody = (boundary, fileBuffer, fileName, mimeType, fields = {}) => {
  const crlf = "\r\n";
  let body = "";

  for (const [k, v] of Object.entries(fields)) {
    body += `--${boundary}${crlf}`;
    body += `Content-Disposition: form-data; name="${k}"${crlf}${crlf}`;
    body += `${v}${crlf}`;
  }

  body += `--${boundary}${crlf}`;
  body += `Content-Disposition: form-data; name="file"; filename="${fileName}"${crlf}`;
  body += `Content-Type: ${mimeType}${crlf}${crlf}`;

  const headBuf = Buffer.from(body, "utf-8");
  const tailBuf = Buffer.from(`${crlf}--${boundary}--${crlf}`, "utf-8");
  return Buffer.concat([headBuf, fileBuffer, tailBuf]);
};

const getFutureDateString = (daysAhead = 14) => {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const runGlobalAccessVerification = async () => {
  console.log("==========================================================================");
  console.log("  Vaidyasthana: Global Doctor–Patient Assignment & Vault Access Test      ");
  console.log("==========================================================================\n");

  // Step 1: Connect to Atlas
  console.log("[1/7] Connecting to MongoDB Atlas...");
  const conn = await connectDB();
  assert(conn, "Database connection must succeed");
  console.log(`✔ Connected to Atlas host: ${conn.connection.host}`);
  console.log(`✔ Database: ${conn.connection.name}`);
  assert.strictEqual(conn.connection.name, "vaidyasthana", "Database must be vaidyasthana");

  // Step 2: Spin up test HTTP server
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`✔ Test HTTP server active on ${baseUrl}\n`);
      resolve();
    });
  });

  const ts = Date.now();
  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash("Password123!", salt);

  // Entities to clean up at end
  const createdUserIds = [];
  const createdAppointmentIds = [];
  const createdReportIds = [];

  try {
    // Step 3: Create Dynamic Test Entities in Atlas (No hardcoded IDs or names)
    console.log("[2/7] Creating dynamic test accounts in MongoDB Atlas...");

    // Doctor A: Will have appointments with Patient 1 and Patient 2
    const docA = await User.create({
      name: `Dr. Alpha Dynamic ${ts}`,
      email: `dr_alpha_${ts}@hospital.test`,
      password: hashedPassword,
      role: "doctor",
      specialization: "Cardiology",
      hospitalAffiliation: "Metro Heart Institute",
      verificationStatus: "verified",
      yearsOfExperience: 12,
      consultationFee: 750,
      availableSlots: ["09:00 AM - 09:30 AM", "10:00 AM - 10:30 AM", "11:00 AM - 11:30 AM"],
    });
    createdUserIds.push(docA._id);

    // Doctor B: Will have appointment only with Patient 3
    const docB = await User.create({
      name: `Dr. Beta Dynamic ${ts}`,
      email: `dr_beta_${ts}@hospital.test`,
      password: hashedPassword,
      role: "doctor",
      specialization: "Neurology",
      hospitalAffiliation: "Apex Neuro Care",
      verificationStatus: "verified",
      yearsOfExperience: 9,
      consultationFee: 800,
      availableSlots: ["02:00 PM - 02:30 PM", "03:00 PM - 03:30 PM"],
    });
    createdUserIds.push(docB._id);

    // Doctor C: Will have NO appointments (Empty state test)
    const docC = await User.create({
      name: `Dr. Gamma Dynamic ${ts}`,
      email: `dr_gamma_${ts}@hospital.test`,
      password: hashedPassword,
      role: "doctor",
      specialization: "Dermatology",
      hospitalAffiliation: "Skin Health Clinic",
      verificationStatus: "verified",
      yearsOfExperience: 6,
      consultationFee: 600,
      availableSlots: ["04:00 PM - 04:30 PM"],
    });
    createdUserIds.push(docC._id);

    // Doctor D: Will have ONLY Cancelled / Rejected appointments with Patient 4
    const docD = await User.create({
      name: `Dr. Delta Dynamic ${ts}`,
      email: `dr_delta_${ts}@hospital.test`,
      password: hashedPassword,
      role: "doctor",
      specialization: "Pediatrics",
      hospitalAffiliation: "Children Health Center",
      verificationStatus: "verified",
      yearsOfExperience: 8,
      consultationFee: 500,
      availableSlots: ["05:00 PM - 05:30 PM"],
    });
    createdUserIds.push(docD._id);

    // Patient 1
    const pat1 = await User.create({
      name: `Patient One ${ts}`,
      email: `pat1_${ts}@patient.test`,
      password: hashedPassword,
      role: "patient",
      phoneNumber: `+9198765${String(ts).slice(-5)}`,
      address: "124 Park Avenue, South District",
    });
    createdUserIds.push(pat1._id);

    // Patient 2
    const pat2 = await User.create({
      name: `Patient Two ${ts}`,
      email: `pat2_${ts}@patient.test`,
      password: hashedPassword,
      role: "patient",
      phoneNumber: `+9198766${String(ts).slice(-5)}`,
      address: "45 Lake View Road, East District",
    });
    createdUserIds.push(pat2._id);

    // Patient 3
    const pat3 = await User.create({
      name: `Patient Three ${ts}`,
      email: `pat3_${ts}@patient.test`,
      password: hashedPassword,
      role: "patient",
      phoneNumber: `+9198767${String(ts).slice(-5)}`,
      address: "88 Hill Road, North District",
    });
    createdUserIds.push(pat3._id);

    // Patient 4 (Cancelled / Rejected appointment only with Doctor Delta)
    const pat4 = await User.create({
      name: `Patient Four ${ts}`,
      email: `pat4_${ts}@patient.test`,
      password: hashedPassword,
      role: "patient",
      phoneNumber: `+9198768${String(ts).slice(-5)}`,
      address: "12 Pine Court, West District",
    });
    createdUserIds.push(pat4._id);

    console.log(`  ✔ Doctor Alpha created: ${docA.name} (${docA._id})`);
    console.log(`  ✔ Doctor Beta created:  ${docB.name} (${docB._id})`);
    console.log(`  ✔ Doctor Gamma created: ${docC.name} (${docC._id}) [No appointments scheduled]`);
    console.log(`  ✔ Doctor Delta created: ${docD.name} (${docD._id}) [Only Cancelled/Rejected appts]`);
    console.log(`  ✔ Patient 1 created:    ${pat1.name} (${pat1._id})`);
    console.log(`  ✔ Patient 2 created:    ${pat2.name} (${pat2._id})`);
    console.log(`  ✔ Patient 3 created:    ${pat3.name} (${pat3._id})`);
    console.log(`  ✔ Patient 4 created:    ${pat4.name} (${pat4._id})`);

    const docAToken = createToken(docA);
    const docBToken = createToken(docB);
    const docCToken = createToken(docC);
    const docDToken = createToken(docD);
    const pat1Token = createToken(pat1);
    const pat2Token = createToken(pat2);
    const pat3Token = createToken(pat3);
    const pat4Token = createToken(pat4);

    // Step 4: Schedule appointments
    console.log("\n[3/7] Scheduling appointments across doctors and patients...");
    const apptDate1 = getFutureDateString(7);
    const apptDate2 = getFutureDateString(14);

    // Doctor Alpha with Patient 1 - Appointment 1
    const apptA1 = await Appointment.create({
      patientId: pat1._id,
      doctorId: docA._id,
      patientName: pat1.name,
      patientEmail: pat1.email,
      patientPhone: pat1.phoneNumber,
      doctorName: docA.name,
      appointmentDate: new Date(apptDate1),
      timeSlot: "09:00 AM - 09:30 AM",
      consultationType: "In-Person",
      reason: "Initial cardiac evaluation and ECG review",
      status: "Scheduled",
    });
    createdAppointmentIds.push(apptA1._id);

    // Doctor Alpha with Patient 1 - Appointment 2 (Tests deduplication)
    const apptA2 = await Appointment.create({
      patientId: pat1._id,
      doctorId: docA._id,
      patientName: pat1.name,
      patientEmail: pat1.email,
      patientPhone: pat1.phoneNumber,
      doctorName: docA.name,
      appointmentDate: new Date(apptDate2),
      timeSlot: "10:00 AM - 10:30 AM",
      consultationType: "Video / Online",
      reason: "Follow-up cardiac consultation",
      status: "Confirmed",
    });
    createdAppointmentIds.push(apptA2._id);

    // Doctor Alpha with Patient 2
    const apptA3 = await Appointment.create({
      patientId: pat2._id,
      doctorId: docA._id,
      patientName: pat2.name,
      patientEmail: pat2.email,
      patientPhone: pat2.phoneNumber,
      doctorName: docA.name,
      appointmentDate: new Date(apptDate1),
      timeSlot: "11:00 AM - 11:30 AM",
      consultationType: "In-Person",
      reason: "Hypertension monitoring",
      status: "Scheduled",
    });
    createdAppointmentIds.push(apptA3._id);

    // Doctor Beta with Patient 3
    const apptB1 = await Appointment.create({
      patientId: pat3._id,
      doctorId: docB._id,
      patientName: pat3.name,
      patientEmail: pat3.email,
      patientPhone: pat3.phoneNumber,
      doctorName: docB.name,
      appointmentDate: new Date(apptDate1),
      timeSlot: "02:00 PM - 02:30 PM",
      consultationType: "In-Person",
      reason: "Neurological migraine assessment",
      status: "Scheduled",
    });
    createdAppointmentIds.push(apptB1._id);

    // Doctor Delta with Patient 4 - Cancelled appointment
    const apptD1 = await Appointment.create({
      patientId: pat4._id,
      doctorId: docD._id,
      patientName: pat4.name,
      patientEmail: pat4.email,
      patientPhone: pat4.phoneNumber,
      doctorName: docD.name,
      appointmentDate: new Date(apptDate1),
      timeSlot: "05:00 PM - 05:30 PM",
      consultationType: "In-Person",
      reason: "Paediatric checkup cancelled by patient",
      status: "Cancelled",
    });
    createdAppointmentIds.push(apptD1._id);

    // Doctor Delta with Patient 4 - Rejected appointment
    const apptD2 = await Appointment.create({
      patientId: pat4._id,
      doctorId: docD._id,
      patientName: pat4.name,
      patientEmail: pat4.email,
      patientPhone: pat4.phoneNumber,
      doctorName: docD.name,
      appointmentDate: new Date(apptDate2),
      timeSlot: "05:00 PM - 05:30 PM",
      consultationType: "In-Person",
      reason: "Paediatric consultation rejected by doctor",
      status: "Rejected",
    });
    createdAppointmentIds.push(apptD2._id);

    console.log("  ✔ Appt 1: Doctor Alpha <-> Patient 1 (Scheduled)");
    console.log("  ✔ Appt 2: Doctor Alpha <-> Patient 1 (Confirmed) [Deduplication candidate]");
    console.log("  ✔ Appt 3: Doctor Alpha <-> Patient 2 (Scheduled)");
    console.log("  ✔ Appt 4: Doctor Beta  <-> Patient 3 (Scheduled)");
    console.log("  ✔ Appt 5: Doctor Delta <-> Patient 4 (Cancelled)");
    console.log("  ✔ Appt 6: Doctor Delta <-> Patient 4 (Rejected)");
    console.log("  ✔ Doctor Gamma: 0 appointments");

    // =========================================================================
    // TEST 1: Dynamic Patient List for Every Doctor (GET /api/doctor/patients)
    // =========================================================================
    console.log("\n[4/7] Testing Dynamic Patient List (GET /api/doctor/patients)...");

    // 1.1 Doctor Alpha check
    const docAPatientsRes = await request("GET", "/api/doctor/patients", null, docAToken);
    assert.strictEqual(docAPatientsRes.status, 200, "Doctor Alpha patients request must return 200");
    assert.strictEqual(docAPatientsRes.data.success, true);
    assert.strictEqual(docAPatientsRes.data.count, 2, "Doctor Alpha must have exactly 2 eligible patients");
    const docAPatientIds = docAPatientsRes.data.patients.map((p) => p._id.toString());
    assert.ok(docAPatientIds.includes(pat1._id.toString()), "Doctor Alpha must include Patient 1");
    assert.ok(docAPatientIds.includes(pat2._id.toString()), "Doctor Alpha must include Patient 2");
    assert.ok(!docAPatientIds.includes(pat3._id.toString()), "Doctor Alpha must NOT include Patient 3");
    // Deduplication check: Patient 1 appears exactly once
    const pat1Count = docAPatientIds.filter((id) => id === pat1._id.toString()).length;
    assert.strictEqual(pat1Count, 1, "Patient 1 must be deduplicated and appear exactly once");
    console.log("  ✔ Doctor Alpha sees exactly Patient 1 & Patient 2 (Patient 1 deduplicated)");

    // 1.2 Doctor Beta check
    const docBPatientsRes = await request("GET", "/api/doctor/patients", null, docBToken);
    assert.strictEqual(docBPatientsRes.status, 200);
    assert.strictEqual(docBPatientsRes.data.count, 1, "Doctor Beta must have exactly 1 eligible patient");
    assert.strictEqual(docBPatientsRes.data.patients[0]._id.toString(), pat3._id.toString());
    console.log("  ✔ Doctor Beta sees only Patient 3");

    // 1.3 Doctor Gamma check (No appointments -> empty list)
    const docCPatientsRes = await request("GET", "/api/doctor/patients", null, docCToken);
    assert.strictEqual(docCPatientsRes.status, 200);
    assert.strictEqual(docCPatientsRes.data.count, 0, "Doctor Gamma with no appointments must have count 0");
    assert.deepStrictEqual(docCPatientsRes.data.patients, [], "Doctor Gamma must receive empty patients array");
    console.log("  ✔ Doctor Gamma receives empty patient array [] (Empty state ready)");

    // 1.4 Doctor Delta check (Only Cancelled/Rejected appointments -> empty list)
    const docDPatientsRes = await request("GET", "/api/doctor/patients", null, docDToken);
    assert.strictEqual(docDPatientsRes.status, 200);
    assert.strictEqual(docDPatientsRes.data.count, 0, "Doctor Delta with only Cancelled/Rejected appointments must have count 0");
    assert.deepStrictEqual(docDPatientsRes.data.patients, [], "Doctor Delta must receive empty patients array");
    console.log("  ✔ Doctor Delta receives empty patient array [] (Cancelled/Rejected appts excluded)");

    // =========================================================================
    // TEST 2: Patient Record Lookup Authorization
    // =========================================================================
    console.log("\n[5/7] Testing Clinical Record Lookup Authorization...");

    // 2.1 Doctor Alpha accesses Patient 1 & Patient 2 details & reports -> ALLOWED (200)
    const docALookup1 = await request("GET", `/api/doctor/patient-reports/${pat1._id}`, null, docAToken);
    assert.strictEqual(docALookup1.status, 200, "Doctor Alpha querying Patient 1 must return 200");
    const docALookup2 = await request("GET", `/api/doctor/patient/${pat2._id}`, null, docAToken);
    assert.strictEqual(docALookup2.status, 200, "Doctor Alpha querying Patient 2 details must return 200");
    console.log("  ✔ Doctor Alpha authorized for Patient 1 & Patient 2 lookups");

    // 2.2 Doctor Alpha attempts to access Patient 3 (unassigned) -> REJECTED (403 Forbidden)
    const docALookup3 = await request("GET", `/api/doctor/patient-reports/${pat3._id}`, null, docAToken);
    assert.strictEqual(docALookup3.status, 403, "Doctor Alpha querying unassigned Patient 3 must return 403 Forbidden");
    console.log("  ✔ Doctor Alpha querying unassigned Patient 3 rejected with 403 Forbidden");

    // 2.3 Doctor Alpha attempts lookup by Patient 3's email and phone -> REJECTED (403 Forbidden)
    const docALookupEmail = await request("GET", `/api/doctor/patient-reports/${encodeURIComponent(pat3.email)}`, null, docAToken);
    assert.strictEqual(docALookupEmail.status, 403, "Doctor Alpha querying Patient 3 by email must return 403 Forbidden");
    const docALookupPhone = await request("GET", `/api/doctor/patient-reports/${encodeURIComponent(pat3.phoneNumber)}`, null, docAToken);
    assert.strictEqual(docALookupPhone.status, 403, "Doctor Alpha querying Patient 3 by phone must return 403 Forbidden");
    console.log("  ✔ Doctor Alpha querying unassigned Patient 3 by email/phone rejected with 403 Forbidden");

    // 2.4 Doctor Beta accesses Patient 3 -> ALLOWED (200)
    const docBLookup3 = await request("GET", `/api/doctor/patient-reports/${pat3._id}`, null, docBToken);
    assert.strictEqual(docBLookup3.status, 200, "Doctor Beta querying Patient 3 must return 200");
    console.log("  ✔ Doctor Beta authorized for Patient 3 lookups");

    // 2.5 Doctor Beta attempts to access Patient 1 -> REJECTED (403 Forbidden)
    const docBLookup1 = await request("GET", `/api/doctor/patient-reports/${pat1._id}`, null, docBToken);
    assert.strictEqual(docBLookup1.status, 403, "Doctor Beta querying unassigned Patient 1 must return 403 Forbidden");
    console.log("  ✔ Doctor Beta querying unassigned Patient 1 rejected with 403 Forbidden");

    // 2.6 Doctor Gamma (no appointments) attempts lookups -> ALL REJECTED (403 Forbidden)
    const docCLookup1 = await request("GET", `/api/doctor/patient-reports/${pat1._id}`, null, docCToken);
    assert.strictEqual(docCLookup1.status, 403, "Doctor Gamma querying Patient 1 must return 403 Forbidden");
    const docCLookup3 = await request("GET", `/api/doctor/patient-reports/${pat3._id}`, null, docCToken);
    assert.strictEqual(docCLookup3.status, 403, "Doctor Gamma querying Patient 3 must return 403 Forbidden");
    console.log("  ✔ Doctor Gamma rejected with 403 Forbidden for all patients");

    // 2.7 Doctor Delta (only Cancelled/Rejected appointments) attempts lookups -> REJECTED (403 Forbidden)
    const docDLookup4 = await request("GET", `/api/doctor/patient-reports/${pat4._id}`, null, docDToken);
    assert.strictEqual(docDLookup4.status, 403, "Doctor Delta querying Patient 4 with cancelled appointment must return 403 Forbidden");
    const docDDetails4 = await request("GET", `/api/doctor/patient/${pat4._id}`, null, docDToken);
    assert.strictEqual(docDDetails4.status, 403, "Doctor Delta querying Patient 4 details must return 403 Forbidden");
    console.log("  ✔ Doctor Delta querying Patient 4 (cancelled appt only) rejected with 403 Forbidden");

    // =========================================================================
    // TEST 3: Medical Report Uploads Authorization & Vault Storage (POST /upload)
    // =========================================================================
    console.log("\n[6/7] Testing Medical Report Upload Authorization & Storage (POST /upload)...");

    const samplePdfBuf = Buffer.from("%PDF-1.4 sample clinical record binary buffer for vaidyasthana", "utf-8");

    // 3.1 Doctor Alpha uploads report for Patient 1 -> 201 Created
    const boundaryA1 = `----BoundaryDocA1${Date.now()}`;
    const payloadA1 = createMultipartBody(
      boundaryA1,
      samplePdfBuf,
      "cardiac_ecg_report_pat1.pdf",
      "application/pdf",
      {
        patientId: pat1._id.toString(),
        category: "Cardiology",
        notes: "Resting 12-lead ECG normal sinus rhythm",
      }
    );
    const uploadResA1 = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${docAToken}`,
        "Content-Type": `multipart/form-data; boundary=${boundaryA1}`,
      },
      body: payloadA1,
    });
    const uploadDataA1 = await uploadResA1.json();
    assert.strictEqual(uploadResA1.status, 201, "Authorized upload by Doctor Alpha for Patient 1 must return 201");
    assert.strictEqual(uploadDataA1.success, true);
    assert.strictEqual(uploadDataA1.patientId, pat1._id.toString());
    assert.strictEqual(uploadDataA1.uploadedBy, docA._id.toString());
    assert.strictEqual(uploadDataA1.uploadedByRole, "doctor");
    const repA1 = uploadDataA1.reports[0];
    createdReportIds.push(repA1._id);
    console.log(`  ✔ Doctor Alpha uploaded report for Patient 1: Report ID = ${repA1._id}`);

    // 3.2 Doctor Alpha uploads report for Patient 2 -> 201 Created
    const boundaryA2 = `----BoundaryDocA2${Date.now()}`;
    const payloadA2 = createMultipartBody(
      boundaryA2,
      samplePdfBuf,
      "blood_pressure_log_pat2.pdf",
      "application/pdf",
      {
        patientId: pat2._id.toString(),
        category: "General",
        notes: "Ambulatory blood pressure monitoring log",
      }
    );
    const uploadResA2 = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${docAToken}`,
        "Content-Type": `multipart/form-data; boundary=${boundaryA2}`,
      },
      body: payloadA2,
    });
    const uploadDataA2 = await uploadResA2.json();
    assert.strictEqual(uploadResA2.status, 201);
    const repA2 = uploadDataA2.reports[0];
    createdReportIds.push(repA2._id);
    console.log(`  ✔ Doctor Alpha uploaded report for Patient 2: Report ID = ${repA2._id}`);

    // 3.3 Doctor Alpha attempts to upload report for Patient 3 (unassigned) -> 403 Forbidden!
    const boundaryA3 = `----BoundaryDocA3${Date.now()}`;
    const payloadA3 = createMultipartBody(
      boundaryA3,
      samplePdfBuf,
      "unauthorized_report_pat3.pdf",
      "application/pdf",
      {
        patientId: pat3._id.toString(),
        category: "General",
        notes: "Should be blocked by clinical authorization",
      }
    );
    const uploadResA3 = await fetch(`${baseUrl}/upload?sync=true`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${docAToken}`,
        "Content-Type": `multipart/form-data; boundary=${boundaryA3}`,
      },
      body: payloadA3,
    });
    const uploadDataA3 = await uploadResA3.json();
    assert.strictEqual(uploadResA3.status, 403, "Doctor Alpha upload for unassigned Patient 3 must return 403 Forbidden");
    assert.ok(uploadDataA3.message.includes("Forbidden") || uploadDataA3.message.includes("authorized"));
    console.log("  ✔ Doctor Alpha upload for unassigned Patient 3 rejected with 403 Forbidden");

    // 3.4 Doctor Beta uploads report for Patient 3 -> 201 Created
    const boundaryB3 = `----BoundaryDocB3${Date.now()}`;
    const payloadB3 = createMultipartBody(
      boundaryB3,
      samplePdfBuf,
      "brain_mri_scan_pat3.pdf",
      "application/pdf",
      {
        patientId: pat3._id.toString(),
        category: "Neurology",
        notes: "Brain MRI unremarkable, no acute findings",
      }
    );
    const uploadResB3 = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${docBToken}`,
        "Content-Type": `multipart/form-data; boundary=${boundaryB3}`,
      },
      body: payloadB3,
    });
    const uploadDataB3 = await uploadResB3.json();
    assert.strictEqual(uploadResB3.status, 201);
    const repB3 = uploadDataB3.reports[0];
    createdReportIds.push(repB3._id);
    console.log(`  ✔ Doctor Beta uploaded report for Patient 3: Report ID = ${repB3._id}`);

    // 3.5 Doctor Beta attempts upload for Patient 1 -> 403 Forbidden
    const boundaryB1 = `----BoundaryDocB1${Date.now()}`;
    const payloadB1 = createMultipartBody(
      boundaryB1,
      samplePdfBuf,
      "unauthorized_pat1.pdf",
      "application/pdf",
      { patientId: pat1._id.toString() }
    );
    const uploadResB1 = await fetch(`${baseUrl}/upload?sync=true`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${docBToken}`,
        "Content-Type": `multipart/form-data; boundary=${boundaryB1}`,
      },
      body: payloadB1,
    });
    assert.strictEqual(uploadResB1.status, 403, "Doctor Beta upload for unassigned Patient 1 must return 403 Forbidden");
    console.log("  ✔ Doctor Beta upload for unassigned Patient 1 rejected with 403 Forbidden");

    // 3.6 Doctor Gamma (no appointments) attempts upload for Patient 1 -> 403 Forbidden
    const boundaryC1 = `----BoundaryDocC1${Date.now()}`;
    const payloadC1 = createMultipartBody(
      boundaryC1,
      samplePdfBuf,
      "unauthorized_c1.pdf",
      "application/pdf",
      { patientId: pat1._id.toString() }
    );
    const uploadResC1 = await fetch(`${baseUrl}/upload?sync=true`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${docCToken}`,
        "Content-Type": `multipart/form-data; boundary=${boundaryC1}`,
      },
      body: payloadC1,
    });
    assert.strictEqual(uploadResC1.status, 403, "Doctor Gamma upload for Patient 1 must return 403 Forbidden");
    console.log("  ✔ Doctor Gamma upload for Patient 1 rejected with 403 Forbidden");

    // 3.7 Doctor Delta (cancelled appt only) attempts upload for Patient 4 -> 403 Forbidden
    const boundaryD1 = `----BoundaryDocD1${Date.now()}`;
    const payloadD1 = createMultipartBody(
      boundaryD1,
      samplePdfBuf,
      "unauthorized_d1.pdf",
      "application/pdf",
      { patientId: pat4._id.toString() }
    );
    const uploadResD1 = await fetch(`${baseUrl}/upload?sync=true`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${docDToken}`,
        "Content-Type": `multipart/form-data; boundary=${boundaryD1}`,
      },
      body: payloadD1,
    });
    assert.strictEqual(uploadResD1.status, 403, "Doctor Delta upload for Patient 4 (cancelled appt) must return 403 Forbidden");
    console.log("  ✔ Doctor Delta upload for Patient 4 (cancelled appt) rejected with 403 Forbidden");

    // =========================================================================
    // TEST 4: Medical Vault Synchronization & Ownership Verification
    // =========================================================================
    console.log("\n[7/7] Testing Medical Vault Synchronization & Isolation...");

    // 4.1 Patient 1 queries their vault (GET /upload/all)
    const pat1VaultRes = await request("GET", "/upload/all", null, pat1Token);
    assert.strictEqual(pat1VaultRes.status, 200);
    const pat1Vault = pat1VaultRes.data;
    const foundInPat1 = pat1Vault.find((r) => r.originalName === "cardiac_ecg_report_pat1.pdf");
    assert.ok(foundInPat1, "Report uploaded by Doctor Alpha must appear in Patient 1's medical vault");
    assert.strictEqual(foundInPat1.userId.toString(), pat1._id.toString(), "Owner must be Patient 1");
    assert.strictEqual(foundInPat1.uploadedBy.toString(), docA._id.toString(), "Uploader must be Doctor Alpha");
    assert.strictEqual(foundInPat1.uploadedByRole, "doctor");
    assert.ok(!pat1Vault.some((r) => r.originalName === "brain_mri_scan_pat3.pdf"), "Patient 1 must NOT see Patient 3's records");
    console.log("  ✔ Patient 1 vault contains Doctor Alpha's report and excludes other patients' records");

    // 4.2 Patient 3 queries their vault (GET /upload/all)
    const pat3VaultRes = await request("GET", "/upload/all", null, pat3Token);
    assert.strictEqual(pat3VaultRes.status, 200);
    const foundInPat3 = pat3VaultRes.data.find((r) => r.originalName === "brain_mri_scan_pat3.pdf");
    assert.ok(foundInPat3, "Report uploaded by Doctor Beta must appear in Patient 3's medical vault");
    assert.strictEqual(foundInPat3.userId.toString(), pat3._id.toString());
    assert.strictEqual(foundInPat3.uploadedBy.toString(), docB._id.toString());
    console.log("  ✔ Patient 3 vault contains Doctor Beta's report");

    // 4.3 Doctor Alpha's personal files (GET /upload/all) are NOT polluted
    const docAVaultRes = await request("GET", "/upload/all", null, docAToken);
    assert.strictEqual(docAVaultRes.status, 200);
    const docAPersonal = docAVaultRes.data;
    assert.ok(
      !docAPersonal.some((r) => r.originalName === "cardiac_ecg_report_pat1.pdf"),
      "Doctor Alpha's personal vault must NOT be polluted with Patient 1's report"
    );
    console.log("  ✔ Doctor Alpha's personal vault is clean (no patient files listed as doctor's personal records)");

    // 4.4 Doctor Alpha queries Patient 1's reports via GET /api/reports?patientId=... -> 200
    const docAFilterPat1 = await request("GET", `/api/reports?patientId=${pat1._id}`, null, docAToken);
    assert.strictEqual(docAFilterPat1.status, 200);
    assert.ok(docAFilterPat1.data.some((r) => r.originalName === "cardiac_ecg_report_pat1.pdf"));

    // 4.5 Doctor Alpha queries Patient 3's reports via GET /api/reports?patientId=... -> 403 Forbidden
    const docAFilterPat3 = await request("GET", `/api/reports?patientId=${pat3._id}`, null, docAToken);
    assert.strictEqual(docAFilterPat3.status, 403);
    console.log("  ✔ Doctor querying unassigned patient via GET /api/reports?patientId=... returns 403 Forbidden");

    // 4.6 Cross-Patient direct access prevention: Patient 2 attempts GET /upload/:id for Patient 1's report
    const pat2AccessPat1 = await request("GET", `/upload/${repA1._id}`, null, pat2Token);
    assert.strictEqual(pat2AccessPat1.status, 403, "Patient 2 accessing Patient 1's report directly must return 403 Forbidden");
    const pat2ViewPat1 = await request("GET", `/upload/view/${repA1._id}`, null, pat2Token);
    assert.strictEqual(pat2ViewPat1.status, 403, "Patient 2 accessing Patient 1's report SAS view URL must return 403 Forbidden");
    console.log("  ✔ Cross-patient direct report retrieval (GET /upload/:id and /upload/view/:id) blocked with 403 Forbidden");

    // 4.7 Doctor Beta attempts direct access to Patient 1's report
    const docBAccessPat1 = await request("GET", `/upload/${repA1._id}`, null, docBToken);
    assert.strictEqual(docBAccessPat1.status, 403, "Doctor Beta accessing unassigned Patient 1's report must return 403 Forbidden");
    console.log("  ✔ Unassigned doctor direct report retrieval blocked with 403 Forbidden");

    // 4.8 Patient cannot access Doctor endpoints
    const patAccessDocRoute = await request("GET", "/api/doctor/patients", null, pat1Token);
    assert.strictEqual(patAccessDocRoute.status, 403, "Patient accessing /api/doctor/patients must return 403 Forbidden");
    console.log("  ✔ Patient accessing doctor routes blocked with 403 Forbidden");

    // 4.9 Patient cannot filter by another patient's ID
    const pat1FilterPat2 = await request("GET", `/api/reports?patientId=${pat2._id}`, null, pat1Token);
    assert.strictEqual(pat1FilterPat2.status, 403, "Patient accessing another patient's ID via query param must return 403 Forbidden");
    console.log("  ✔ Patient querying another patient's ID blocked with 403 Forbidden");

    // =========================================================================
    // TEST 5: AI Analysis, Status, and Retry Authorization
    // =========================================================================
    console.log("\n[TEST 5] Testing AI Analysis, Status, and Retry Authorization...");

    // 5.1 Doctor Alpha triggers AI analysis on Patient 1's report -> 200 OK
    const docAAnalyzePat1 = await request("POST", `/upload/analyze/${repA1._id}`, {}, docAToken);
    assert.strictEqual(docAAnalyzePat1.status, 200, "Authorized doctor triggering analysis must return 200");
    console.log("  ✔ Doctor Alpha authorized to analyze Patient 1's report");

    // 5.2 Doctor Beta attempts AI analysis on Patient 1's report -> 403 Forbidden
    const docBAnalyzePat1 = await request("POST", `/upload/analyze/${repA1._id}`, {}, docBToken);
    assert.strictEqual(docBAnalyzePat1.status, 403, "Unassigned doctor triggering analysis must return 403 Forbidden");
    console.log("  ✔ Doctor Beta analyzing Patient 1's report blocked with 403 Forbidden");

    // 5.3 Doctor Gamma (no appts) attempts AI analysis on Patient 1's report -> 403 Forbidden
    const docCAnalyzePat1 = await request("POST", `/upload/analyze/${repA1._id}`, {}, docCToken);
    assert.strictEqual(docCAnalyzePat1.status, 403, "Doctor with no appts triggering analysis must return 403 Forbidden");
    console.log("  ✔ Doctor Gamma analyzing Patient 1's report blocked with 403 Forbidden");

    // 5.4 Patient 2 attempts AI analysis on Patient 1's report -> 403 Forbidden
    const pat2AnalyzePat1 = await request("POST", `/upload/analyze/${repA1._id}`, {}, pat2Token);
    assert.strictEqual(pat2AnalyzePat1.status, 403, "Cross-patient triggering analysis must return 403 Forbidden");
    console.log("  ✔ Patient 2 analyzing Patient 1's report blocked with 403 Forbidden");

    // 5.5 Report processing status checks
    const docAStatusPat1 = await request("GET", `/upload/${repA1._id}/status`, null, docAToken);
    assert.strictEqual(docAStatusPat1.status, 200, "Doctor Alpha viewing status must return 200");
    const docBStatusPat1 = await request("GET", `/upload/${repA1._id}/status`, null, docBToken);
    assert.strictEqual(docBStatusPat1.status, 403, "Doctor Beta viewing status must return 403 Forbidden");
    console.log("  ✔ Report status check: Doctor Alpha 200 OK, Doctor Beta 403 Forbidden");

    // 5.6 Report retry checks
    const docARetryPat1 = await request("POST", `/upload/${repA1._id}/retry`, {}, docAToken);
    assert.strictEqual(docARetryPat1.status, 200, "Doctor Alpha retrying analysis must return 200");
    const docBRetryPat1 = await request("POST", `/upload/${repA1._id}/retry`, {}, docBToken);
    assert.strictEqual(docBRetryPat1.status, 403, "Doctor Beta retrying analysis must return 403 Forbidden");
    console.log("  ✔ Report retry check: Doctor Alpha 200 OK, Doctor Beta 403 Forbidden");

    // =========================================================================
    // TEST 6: Clinical Nutrition Synthesis with Report Lab Extraction
    // =========================================================================
    console.log("\n[TEST 6] Testing Clinical Nutrition AI Synthesis Authorization...");

    // 6.1 Doctor Alpha generates nutrition plan linking Patient 1's report -> Authorized (200 or 503 if Ollama daemon offline)
    const docANutrition = await request("POST", "/api/nutrition/generate", { reportId: repA1._id }, docAToken);
    assert.ok(docANutrition.status === 200 || docANutrition.status === 503, "Doctor Alpha must be authorized (status 200 or 503)");
    console.log("  ✔ Doctor Alpha authorized to synthesize nutrition with Patient 1's report");

    // 6.2 Doctor Beta attempts nutrition synthesis with Patient 1's report -> 403 Forbidden!
    const docBNutrition = await request("POST", "/api/nutrition/generate", { reportId: repA1._id }, docBToken);
    assert.strictEqual(docBNutrition.status, 403, "Unassigned Doctor Beta linking Patient 1's report must return 403 Forbidden");
    console.log("  ✔ Doctor Beta linking Patient 1's report blocked with 403 Forbidden");

    // 6.3 Patient 2 attempts nutrition synthesis with Patient 1's report -> 403 Forbidden!
    const pat2Nutrition = await request("POST", "/api/nutrition/generate", { reportId: repA1._id }, pat2Token);
    assert.strictEqual(pat2Nutrition.status, 403, "Cross-patient linking Patient 1's report must return 403 Forbidden");
    console.log("  ✔ Patient 2 linking Patient 1's report blocked with 403 Forbidden");

    // =========================================================================
    // TEST 7: Clinical Report Reassignment Authorization
    // =========================================================================
    console.log("\n[TEST 7] Testing Report Reassignment Clinical Authorization...");

    // 7.1 Doctor Alpha attempts to reassign Patient 1's report to unassigned Patient 3 -> 403 Forbidden!
    const reassignUnauthorized = await request(
      "POST",
      `/api/doctor/reassign-report/${repA1._id}`,
      { targetPatientId: pat3._id.toString() },
      docAToken
    );
    assert.strictEqual(reassignUnauthorized.status, 403, "Reassigning report to unassigned patient must return 403 Forbidden");
    console.log("  ✔ Doctor Alpha reassigning report to unassigned Patient 3 blocked with 403 Forbidden");

    console.log("\n==========================================================================");
    console.log("  ALL TESTS PASSED: GLOBAL DOCTOR-PATIENT ASSIGNMENT & VAULT SECURITY VERIFIED! ");
    console.log("==========================================================================");
  } finally {
    // Clean up created fixtures from MongoDB Atlas
    console.log("\n[Clean Up] Cleaning up dynamic test fixtures in MongoDB Atlas...");
    try {
      if (createdReportIds.length > 0) {
        const repRes = await Report.deleteMany({ _id: { $in: createdReportIds } });
        console.log(`  ✔ Deleted ${repRes.deletedCount} temporary test report(s).`);
      }
      if (createdAppointmentIds.length > 0) {
        const appRes = await Appointment.deleteMany({ _id: { $in: createdAppointmentIds } });
        console.log(`  ✔ Deleted ${appRes.deletedCount} temporary test appointment(s).`);
      }
      if (createdUserIds.length > 0) {
        const userRes = await User.deleteMany({ _id: { $in: createdUserIds } });
        console.log(`  ✔ Deleted ${userRes.deletedCount} temporary test user(s).`);
      }
    } catch (cleanupErr) {
      console.warn("⚠️ Warning during test fixture cleanup:", cleanupErr);
    }

    if (server) {
      await new Promise((resolve) => server.close(resolve));
      console.log("✔ Test server closed.");
    }
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
      console.log("✔ Disconnected cleanly from MongoDB Atlas.");
    }
  }
};

runGlobalAccessVerification()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ Verification Failed:", err);
    process.exit(1);
  });
