const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const app = require("../src/app");
const { inMemoryReports } = require("../src/controllers/uploadController");

let server;
let baseUrl;

const doctorId = "60c72b2f9b1d8b2bad0000d1";
const patientAId = "60c72b2f9b1d8b2bad0000a1";
const patientBId = "60c72b2f9b1d8b2bad0000b2";

let doctorToken;
let patientAToken;
let patientBToken;

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

test.before(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_key_minimum_32_chars";

  doctorToken = jwt.sign(
    { id: doctorId, role: "doctor", name: "Dr. Sharma", email: "drsharma@hospital.com" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  patientAToken = jwt.sign(
    { id: patientAId, role: "patient", name: "Ramesh Kumar", email: "ramesh@example.com" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  patientBToken = jwt.sign(
    { id: patientBId, role: "patient", name: "Sita Devi", email: "sita@example.com" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
});

test("Test 1: Doctor uploads report with patientId -> Saved with Patient A as owner (userId) and Doctor as uploader", async () => {
  const boundary = `----DocBoundary${Date.now()}`;
  const pdfBuffer = Buffer.from("%PDF-1.4 sample clinical report text", "utf-8");

  const payload = createMultipartBody(
    boundary,
    pdfBuffer,
    "patientA_lipid_profile.pdf",
    "application/pdf",
    {
      patientId: patientAId,
      category: "Laboratory",
      notes: "Post-prandial lipid profile requested by cardiology",
    }
  );

  const res = await fetch(`${baseUrl}/upload?sync=true`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${doctorToken}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: payload,
  });

  const data = await res.json();
  assert.strictEqual(res.status, 201);
  assert.strictEqual(data.success, true);
  assert.strictEqual(data.patientId, patientAId);
  assert.strictEqual(data.uploadedBy, doctorId);
  assert.strictEqual(data.uploadedByRole, "doctor");

  const report = data.reports[0];
  assert.strictEqual(report.userId.toString(), patientAId);
  assert.strictEqual(report.uploadedBy.toString(), doctorId);
  assert.strictEqual(report.uploadedByRole, "doctor");
  assert.strictEqual(report.uploaderName, "Dr. Sharma");
});

test("Test 2: Patient A retrieves their reports -> Doctor-uploaded report appears in Patient A's vault", async () => {
  const res = await fetch(`${baseUrl}/upload/all`, {
    headers: { Authorization: `Bearer ${patientAToken}` },
  });

  const reports = await res.json();
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(reports));
  const found = reports.find((r) => r.originalName === "patientA_lipid_profile.pdf");
  assert.ok(found, "Patient A must see the doctor-uploaded report in their records vault");
  assert.strictEqual(found.userId.toString(), patientAId);
  assert.strictEqual(found.uploadedByRole, "doctor");
  assert.strictEqual(found.uploaderName, "Dr. Sharma");
});

test("Test 3: Doctor portal fetches Patient A reports, and Doctor's personal files are NOT polluted", async () => {
  // Doctor checks Patient A's records
  const patientReportsRes = await fetch(`${baseUrl}/doctor/patient-reports/${patientAId}`, {
    headers: { Authorization: `Bearer ${doctorToken}` },
  });
  const patientReports = await patientReportsRes.json();
  assert.strictEqual(patientReportsRes.status, 200);
  assert.ok(Array.isArray(patientReports));
  const foundInPatient = patientReports.find((r) => r.originalName === "patientA_lipid_profile.pdf");
  assert.ok(foundInPatient, "Doctor must see the report when querying Patient A's records");

  // Doctor checks their own personal vault (GET /upload/all)
  const docPersonalRes = await fetch(`${baseUrl}/upload/all`, {
    headers: { Authorization: `Bearer ${doctorToken}` },
  });
  const docPersonalReports = await docPersonalRes.json();
  assert.strictEqual(docPersonalRes.status, 200);
  const foundInDoc = docPersonalReports.find((r) => r.originalName === "patientA_lipid_profile.pdf");
  assert.strictEqual(foundInDoc, undefined, "Doctor personal vault should NOT contain patient reports");
});

test("Test 4: Patient uploads own report -> Report saved with Patient as both owner and uploader", async () => {
  const boundary = `----PatBoundary${Date.now()}`;
  const pdfBuffer = Buffer.from("%PDF-1.4 self uploaded blood sugar test", "utf-8");

  const payload = createMultipartBody(
    boundary,
    pdfBuffer,
    "self_glucose_tracker.pdf",
    "application/pdf",
    {
      category: "Blood Sugar",
      notes: "Fasting morning test",
    }
  );

  const res = await fetch(`${baseUrl}/upload?sync=true`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${patientBToken}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: payload,
  });

  const data = await res.json();
  assert.strictEqual(res.status, 201);
  const report = data.reports[0];
  assert.strictEqual(report.userId.toString(), patientBId);
  assert.strictEqual(report.uploadedBy.toString(), patientBId);
  assert.strictEqual(report.uploadedByRole, "patient");
});

test("Test 5: Doctor upload fails if patientId is missing or points to non-existent patient", async () => {
  const boundary = `----DocBoundaryErr${Date.now()}`;
  const pdfBuffer = Buffer.from("%PDF-1.4 error check", "utf-8");

  // Case A: Missing patientId
  const missingIdPayload = createMultipartBody(
    boundary,
    pdfBuffer,
    "missing_patient.pdf",
    "application/pdf",
    {}
  );
  const resMissing = await fetch(`${baseUrl}/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${doctorToken}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: missingIdPayload,
  });
  const dataMissing = await resMissing.json();
  assert.strictEqual(resMissing.status, 400);
  assert.strictEqual(dataMissing.success, false);
  assert.ok(dataMissing.message.includes("Patient ID is required"));

  // Case B: Non-existent patientId
  const boundary2 = `----DocBoundaryErr2${Date.now()}`;
  const notFoundPayload = createMultipartBody(
    boundary2,
    pdfBuffer,
    "not_found_patient.pdf",
    "application/pdf",
    { patientId: "000000000000000000000000" }
  );
  const resNotFound = await fetch(`${baseUrl}/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${doctorToken}`,
      "Content-Type": `multipart/form-data; boundary=${boundary2}`,
    },
    body: notFoundPayload,
  });
  const dataNotFound = await resNotFound.json();
  assert.strictEqual(resNotFound.status, 404);
  assert.strictEqual(dataNotFound.success, false);
  assert.ok(dataNotFound.message.includes("Target patient not found"));
});

test("Test 6: Non-doctor cannot upload on behalf of another patient", async () => {
  const boundary = `----PatientForgeBoundary${Date.now()}`;
  const pdfBuffer = Buffer.from("%PDF-1.4 forged document", "utf-8");

  const payload = createMultipartBody(
    boundary,
    pdfBuffer,
    "forged_report.pdf",
    "application/pdf",
    {
      patientId: patientAId, // Patient B tries to upload for Patient A
    }
  );

  const res = await fetch(`${baseUrl}/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${patientBToken}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: payload,
  });

  const data = await res.json();
  assert.strictEqual(res.status, 403);
  assert.strictEqual(data.success, false);
  assert.ok(data.message.includes("Only verified healthcare professionals"));
});

test("Test 7: Doctor audit and report reassignment", async () => {
  // Doctor audit endpoint
  const auditRes = await fetch(`${baseUrl}/doctor/audit-reports`, {
    headers: { Authorization: `Bearer ${doctorToken}` },
  });
  const auditData = await auditRes.json();
  assert.strictEqual(auditRes.status, 200);
  assert.strictEqual(auditData.success, true);
  assert.strictEqual(auditData.doctorId, doctorId);
  assert.ok(auditData.summary.patientAssignedCount >= 1);

  // Patient detail endpoint
  const patientDetailRes = await fetch(`${baseUrl}/doctor/patient/${patientAId}`, {
    headers: { Authorization: `Bearer ${doctorToken}` },
  });
  const patientDetailData = await patientDetailRes.json();
  assert.strictEqual(patientDetailRes.status, 200);
  assert.strictEqual(patientDetailData.success, true);
  assert.strictEqual(patientDetailData.patient._id, patientAId);
});
