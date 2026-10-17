const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const app = require("../src/app");
const { inMemoryReports } = require("../src/controllers/uploadController");
const { inMemoryAppointments } = require("../src/controllers/timelineController");
const { grantInMemoryAccess } = require("../src/services/clinicalAuthorizationService");

let server;
let baseUrl;

const doctorId = "60c72b2f9b1d8b2bad0000d1";
const patientAId = "60c72b2f9b1d8b2bad0000a1";
const patientBId = "60c72b2f9b1d8b2bad0000b2";
const unauthorizedDoctorId = "60c72b2f9b1d8b2bad0000d9";

let doctorToken;
let patientAToken;
let patientBToken;
let unauthorizedDoctorToken;

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

  unauthorizedDoctorToken = jwt.sign(
    { id: unauthorizedDoctorId, role: "doctor", name: "Dr. Stranger", email: "stranger@hospital.com" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  // Grant clinical authorization between doctorId and patientAId
  grantInMemoryAccess(doctorId, patientAId);

  // Populate in-memory test data for Patient A
  // 1. Report with abnormal biomarkers uploaded by Patient
  const report1 = {
    _id: "60c72b2f9b1d8b2bad000101",
    userId: patientAId,
    uploadedBy: patientAId,
    uploadedByRole: "patient",
    uploaderName: "Ramesh Kumar",
    fileName: "Complete_Blood_Count.pdf",
    originalName: "Complete_Blood_Count.pdf",
    blobUrl: "https://vaidyasthana.blob.core.windows.net/reports/cbc.pdf",
    blobPath: "reports/cbc.pdf",
    fileType: "application/pdf",
    fileSize: 125000,
    category: "Blood Report",
    notes: "Fasting lipid and complete blood profile",
    analysisStatus: "Completed",
    aiAnalysis: {
      summary: "Patient displays elevated serum cholesterol and fasting glucose levels.",
      severity: "Medium",
      abnormalParameters: [
        {
          parameter: "Total Cholesterol",
          value: "245 mg/dL",
          normalRange: "125 - 200 mg/dL",
          status: "High",
          reason: "Mild hypercholesterolemia observed.",
        },
        {
          parameter: "Fasting Blood Sugar",
          value: "135 mg/dL",
          normalRange: "70 - 100 mg/dL",
          status: "High",
          reason: "Impaired fasting glucose requiring lifestyle and dietary monitoring.",
        },
      ],
      possibleDiseases: ["Hyperlipidemia", "Prediabetes"],
      recommendations: ["Low glycemic diet", "Daily 30-minute aerobic exercise"],
    },
    createdAt: new Date("2026-10-01T08:00:00Z"),
    uploadedAt: new Date("2026-10-01T08:00:00Z"),
  };

  // 2. Report uploaded by Doctor for Patient A
  const report2 = {
    _id: "60c72b2f9b1d8b2bad000102",
    userId: patientAId,
    uploadedBy: doctorId,
    uploadedByRole: "doctor",
    uploaderName: "Dr. Sharma",
    fileName: "Cardiac_ECG_Analysis.pdf",
    originalName: "Cardiac_ECG_Analysis.pdf",
    blobUrl: "https://vaidyasthana.blob.core.windows.net/reports/ecg.pdf",
    blobPath: "reports/ecg.pdf",
    fileType: "application/pdf",
    fileSize: 98000,
    category: "Cardiology",
    notes: "Normal sinus rhythm confirmed during clinical review.",
    analysisStatus: "Completed",
    aiAnalysis: {
      summary: "Resting 12-lead ECG is within normal physiological limits.",
      severity: "Low",
      abnormalParameters: [],
      possibleDiseases: [],
      recommendations: ["Regular annual cardiac screening"],
    },
    createdAt: new Date("2026-10-10T14:30:00Z"),
    uploadedAt: new Date("2026-10-10T14:30:00Z"),
  };

  // 3. Appointment 1: Completed consultation
  const appt1 = {
    _id: "60c72b2f9b1d8b2bad000201",
    patientId: patientAId,
    doctorId: doctorId,
    doctorName: "Dr. Sharma",
    patientName: "Ramesh Kumar",
    department: "Cardiology",
    appointmentDate: new Date("2026-09-15T10:00:00Z"),
    timeSlot: "10:00 AM",
    status: "Completed",
    consultationType: "In-Person",
    reason: "Chest discomfort during exertion",
    notes: "Advised lipid profile and follow-up in 4 weeks.",
    createdAt: new Date("2026-09-10T09:00:00Z"),
  };

  // 4. Appointment 2: Scheduled upcoming video consultation
  const appt2 = {
    _id: "60c72b2f9b1d8b2bad000202",
    patientId: patientAId,
    doctorId: doctorId,
    doctorName: "Dr. Sharma",
    patientName: "Ramesh Kumar",
    department: "Cardiology",
    appointmentDate: new Date("2026-11-05T11:30:00Z"),
    timeSlot: "11:30 AM",
    status: "Scheduled",
    consultationType: "Video / Online",
    reason: "Review blood report results and cholesterol management",
    meetingRoomId: "vaidya-room-test-99",
    createdAt: new Date("2026-10-12T10:00:00Z"),
  };

  inMemoryReports.set(report1._id, report1);
  inMemoryReports.set(report2._id, report2);
  inMemoryAppointments.set(appt1._id, appt1);
  inMemoryAppointments.set(appt2._id, appt2);

  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
});

test("1. GET /api/timeline requires authentication (401)", async () => {
  const res = await fetch(`${baseUrl}/api/timeline`);
  assert.strictEqual(res.status, 401);
  const data = await res.json();
  assert.strictEqual(data.success, false);
});

test("2. Patient can retrieve their own chronological health timeline (200)", async () => {
  const res = await fetch(`${baseUrl}/api/timeline`, {
    headers: { Authorization: `Bearer ${patientAToken}` },
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.ok(data.timeline);
  assert.ok(data.timeline.length >= 4);

  // Check metrics
  assert.strictEqual(data.metrics.totalReports, 2);
  assert.strictEqual(data.metrics.totalAppointments, 2);
  assert.strictEqual(data.metrics.abnormalBiomarkersCount, 2);
  assert.ok(data.metrics.upcomingAppointmentsCount >= 1);

  // Chronological order: first item should be most recent (2026-11-05 or 2026-10-10)
  const dates = data.timeline.map((e) => new Date(e.date).getTime());
  for (let i = 0; i < dates.length - 1; i++) {
    assert.ok(dates[i] >= dates[i + 1], `Events should be sorted descending: ${dates[i]} >= ${dates[i + 1]}`);
  }
});

test("3. Patient cannot access another patient's timeline (403)", async () => {
  const res = await fetch(`${baseUrl}/api/timeline?patientId=${patientBId}`, {
    headers: { Authorization: `Bearer ${patientAToken}` },
  });
  assert.strictEqual(res.status, 403);
  const data = await res.json();
  assert.strictEqual(data.success, false);
  assert.match(data.message, /only view their own/i);
});

test("4. Doctor requesting timeline without patientId is rejected (400)", async () => {
  const res = await fetch(`${baseUrl}/api/timeline`, {
    headers: { Authorization: `Bearer ${doctorToken}` },
  });
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.strictEqual(data.success, false);
  assert.match(data.message, /patient id is required/i);
});

test("5. Clinically authorized doctor can retrieve patient's timeline (200)", async () => {
  const res = await fetch(`${baseUrl}/api/timeline?patientId=${patientAId}`, {
    headers: { Authorization: `Bearer ${doctorToken}` },
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.strictEqual(data.patient._id, patientAId);
  assert.ok(data.timeline.length >= 4);

  // Verify attribution is preserved
  const docUploadedReport = data.timeline.find((t) => t.id === "60c72b2f9b1d8b2bad000102");
  assert.ok(docUploadedReport);
  assert.strictEqual(docUploadedReport.uploadedByRole, "doctor");
  assert.strictEqual(docUploadedReport.uploaderName, "Dr. Sharma");

  const patUploadedReport = data.timeline.find((t) => t.id === "60c72b2f9b1d8b2bad000101");
  assert.ok(patUploadedReport);
  assert.strictEqual(patUploadedReport.uploadedByRole, "patient");
});

test("6. Doctor without clinical relationship is strictly blocked (403)", async () => {
  const res = await fetch(`${baseUrl}/api/timeline?patientId=${patientAId}`, {
    headers: { Authorization: `Bearer ${unauthorizedDoctorToken}` },
  });
  assert.strictEqual(res.status, 403);
  const data = await res.json();
  assert.strictEqual(data.success, false);
  assert.match(data.message, /clinical relationship/i);
});

test("7. Filter by type=reports returns only medical diagnostic records", async () => {
  const res = await fetch(`${baseUrl}/api/timeline?type=reports`, {
    headers: { Authorization: `Bearer ${patientAToken}` },
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.ok(data.timeline.length > 0);
  data.timeline.forEach((item) => {
    assert.strictEqual(item.recordType, "report");
  });
});

test("8. Filter by type=appointments returns only consultations", async () => {
  const res = await fetch(`${baseUrl}/api/timeline?type=appointments`, {
    headers: { Authorization: `Bearer ${patientAToken}` },
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.ok(data.timeline.length > 0);
  data.timeline.forEach((item) => {
    assert.strictEqual(item.recordType, "appointment");
  });
});

test("9. Filter by type=biomarkers returns only reports with abnormal parameters", async () => {
  const res = await fetch(`${baseUrl}/api/timeline?type=biomarkers`, {
    headers: { Authorization: `Bearer ${patientAToken}` },
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.strictEqual(data.timeline.length, 1);
  assert.strictEqual(data.timeline[0].id, "60c72b2f9b1d8b2bad000101");
  assert.strictEqual(data.timeline[0].hasBiomarkers, true);
});

test("10. Milestones group events chronologically into Month/Year sections", async () => {
  const res = await fetch(`${baseUrl}/api/timeline`, {
    headers: { Authorization: `Bearer ${patientAToken}` },
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.ok(data.milestones);
  assert.ok(data.milestones.length >= 2);
  const periods = data.milestones.map((m) => m.period);
  assert.ok(periods.includes("October 2026") || periods.includes("November 2026"));
});
