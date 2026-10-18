require("dotenv").config();
const assert = require("node:assert");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const app = require("../src/app");
const User = require("../src/models/User");
const Appointment = require("../src/models/Appointment");
const Report = require("../src/models/Report");
const Contact = require("../src/models/Contact");
const AuditLog = require("../src/models/AuditLog");
const { _resetRateLimits } = require("../src/controllers/authController");

let server;
let baseUrl;

let superAdminUser;
let adminUser;
let doctorUser;
let patientUser;
let targetPatient;

let superAdminToken;
let adminToken;
let doctorToken;
let patientToken;

const request = async (method, path, body = null, token = null) => {
  const url = `${baseUrl}${path}`;
  const reqHeaders = { "Content-Type": "application/json" };

  if (token) {
    reqHeaders["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method,
    headers: reqHeaders,
    body: body ? JSON.stringify(body) : null,
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

const runSuite = async () => {
  console.log("==========================================================");
  console.log("  Vaidyasthana Super Admin & Security Verification Suite  ");
  console.log("==========================================================");

  const connectDB = require("../src/config/db");
  if (mongoose.connection.readyState === 0) {
    await connectDB();
  }

  // Spin up test server
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  const timestamp = Date.now();
  const jwtSecret = process.env.JWT_SECRET || "vaidyasthana_development_jwt_secret_key_32bytes";

  // Create test fixtures
  superAdminUser = await User.create({
    name: `Super Admin ${timestamp}`,
    email: `superadmin_${timestamp}@vaidyasthana.com`,
    password: "Password123!",
    role: "superadmin",
    phoneNumber: "9999900001",
    address: "Governance Office 1",
    city: "Bengaluru",
    status: "active",
  });

  adminUser = await User.create({
    name: `Admin ${timestamp}`,
    email: `admin_${timestamp}@vaidyasthana.com`,
    password: "Password123!",
    role: "admin",
    phoneNumber: "9999900002",
    address: "Admin Office 2",
    city: "Bengaluru",
    status: "active",
  });

  doctorUser = await User.create({
    name: `Dr. Tester ${timestamp}`,
    email: `doctor_${timestamp}@vaidyasthana.com`,
    password: "Password123!",
    role: "doctor",
    phoneNumber: "9999900003",
    address: "Clinic 3",
    city: "Bengaluru",
    specialization: "General Medicine",
    verificationStatus: "pending",
    status: "active",
  });

  patientUser = await User.create({
    name: `Patient Tester ${timestamp}`,
    email: `patient_${timestamp}@vaidyasthana.com`,
    password: "Password123!",
    role: "patient",
    phoneNumber: "9999900004",
    address: "Home 4",
    city: "Bengaluru",
    status: "active",
  });

  targetPatient = await User.create({
    name: `Suspension Target ${timestamp}`,
    email: `target_${timestamp}@vaidyasthana.com`,
    password: "Password123!",
    role: "patient",
    phoneNumber: "9999900005",
    address: "Home 5",
    city: "Bengaluru",
    status: "active",
  });

  superAdminToken = jwt.sign({ id: superAdminUser._id, role: "superadmin" }, jwtSecret, { expiresIn: "1h" });
  adminToken = jwt.sign({ id: adminUser._id, role: "admin" }, jwtSecret, { expiresIn: "1h" });
  doctorToken = jwt.sign({ id: doctorUser._id, role: "doctor" }, jwtSecret, { expiresIn: "1h" });
  patientToken = jwt.sign({ id: patientUser._id, role: "patient" }, jwtSecret, { expiresIn: "1h" });

  try {
    // -------------------------------------------------------------
    // 1. Role Isolation & Protection
    // -------------------------------------------------------------
    process.stdout.write("Test 1: Unauthenticated request to /api/admin/overview receives 401... ");
    const unauth = await request("GET", "/api/admin/overview");
    assert.strictEqual(unauth.status, 401);
    console.log("✔ PASSED");

    process.stdout.write("Test 2: Patient account receives 403 Forbidden for Super Admin API... ");
    const patientForbidden = await request("GET", "/api/admin/overview", null, patientToken);
    assert.strictEqual(patientForbidden.status, 403);
    console.log("✔ PASSED");

    process.stdout.write("Test 3: Doctor account receives 403 Forbidden for Super Admin API... ");
    const docForbidden = await request("GET", "/api/admin/overview", null, doctorToken);
    assert.strictEqual(docForbidden.status, 403);
    console.log("✔ PASSED");

    process.stdout.write("Test 4: Admin and Super Admin accounts receive 200 OK for /api/admin/overview... ");
    const adminRes = await request("GET", "/api/admin/overview", null, adminToken);
    assert.strictEqual(adminRes.status, 200);
    assert.strictEqual(adminRes.body.success, true);
    assert.ok(adminRes.body.stats.users.total >= 5);

    const superAdminRes = await request("GET", "/api/admin/overview", null, superAdminToken);
    assert.strictEqual(superAdminRes.status, 200);
    assert.strictEqual(superAdminRes.body.success, true);
    console.log("✔ PASSED");

    // -------------------------------------------------------------
    // 2. Registration Privilege Escalation Prevention
    // -------------------------------------------------------------
    process.stdout.write("Test 5: Public registration cannot create an admin or superadmin account... ");
    const forgedSignup = await request("POST", "/api/auth/register", {
      name: "Attacker Trying Admin",
      email: `forged_${timestamp}@attacker.com`,
      password: "Password123!",
      phoneNumber: "9876543210",
      address: "123 Attacker Lane, Bengaluru",
      role: "admin", // attempting to self-assign admin!
    });
    assert.strictEqual(forgedSignup.status, 201);
    assert.strictEqual(forgedSignup.body.user.role, "patient"); // Must be neutralized to patient!

    const forgedSuperSignup = await request("POST", "/api/auth/register", {
      name: "Attacker Trying Superadmin",
      email: `forged_super_${timestamp}@attacker.com`,
      password: "Password123!",
      phoneNumber: "9876543210",
      address: "123 Attacker Lane, Bengaluru",
      role: "superadmin",
    });
    assert.strictEqual(forgedSuperSignup.status, 201);
    assert.strictEqual(forgedSuperSignup.body.user.role, "patient");
    console.log("✔ PASSED");

    // -------------------------------------------------------------
    // 3. User Management & Suspension Lifecycle
    // -------------------------------------------------------------
    process.stdout.write("Test 6: GET /api/admin/users returns paginated list with password hashes excluded... ");
    const usersRes = await request("GET", "/api/admin/users?page=1&limit=5", null, superAdminToken);
    assert.strictEqual(usersRes.status, 200);
    assert.ok(Array.isArray(usersRes.body.users));
    assert.ok(usersRes.body.pagination.total >= 5);
    // Verify password is never returned
    usersRes.body.users.forEach((u) => {
      assert.strictEqual(u.password, undefined);
      assert.strictEqual(u.resetPasswordToken, undefined);
    });
    console.log("✔ PASSED");

    process.stdout.write("Test 7: Self-lockout prevention: Admin cannot suspend their own account... ");
    const selfLock = await request(
      "PATCH",
      `/api/admin/users/${superAdminUser._id}/status`,
      { status: "suspended", reason: "Attempting self lockout" },
      superAdminToken
    );
    assert.strictEqual(selfLock.status, 400);
    assert.match(selfLock.body.message, /self-lockout/i);
    console.log("✔ PASSED");

    process.stdout.write("Test 8: Suspending user requires mandatory administrative reason... ");
    const noReason = await request(
      "PATCH",
      `/api/admin/users/${targetPatient._id}/status`,
      { status: "suspended", reason: "" },
      superAdminToken
    );
    assert.strictEqual(noReason.status, 400);
    assert.match(noReason.body.message, /reason/i);
    console.log("✔ PASSED");

    process.stdout.write("Test 9: Admin successfully suspends target user and records reason & history... ");
    const suspendRes = await request(
      "PATCH",
      `/api/admin/users/${targetPatient._id}/status`,
      { status: "suspended", reason: "Violated clinical policy rules" },
      superAdminToken
    );
    assert.strictEqual(suspendRes.status, 200);
    assert.strictEqual(suspendRes.body.user.status, "suspended");
    assert.strictEqual(suspendRes.body.user.suspensionHistory.length, 1);
    assert.strictEqual(suspendRes.body.user.suspensionHistory[0].action, "suspended");
    console.log("✔ PASSED");

    process.stdout.write("Test 10: Suspended user is blocked from logging in with 403 ACCOUNT_SUSPENDED... ");
    _resetRateLimits();
    const loginSuspended = await request("POST", "/api/auth/login", {
      email: targetPatient.email,
      password: "Password123!",
    });
    assert.strictEqual(loginSuspended.status, 403);
    assert.strictEqual(loginSuspended.body.code, "ACCOUNT_SUSPENDED");
    console.log("✔ PASSED");

    process.stdout.write("Test 11: Suspended user with active token is blocked from protected API endpoints... ");
    const targetToken = jwt.sign({ id: targetPatient._id, role: "patient" }, jwtSecret, { expiresIn: "1h" });
    const protectedRes = await request("GET", "/api/timeline", null, targetToken);
    assert.strictEqual(protectedRes.status, 403);
    assert.strictEqual(protectedRes.body.code, "ACCOUNT_SUSPENDED");
    console.log("✔ PASSED");

    process.stdout.write("Test 12: Admin reactivates suspended user... ");
    const reactivateRes = await request(
      "PATCH",
      `/api/admin/users/${targetPatient._id}/status`,
      { status: "active", reason: "Dispute resolved and verified" },
      superAdminToken
    );
    assert.strictEqual(reactivateRes.status, 200);
    assert.strictEqual(reactivateRes.body.user.status, "active");
    assert.strictEqual(reactivateRes.body.user.suspensionHistory.length, 2);
    console.log("✔ PASSED");

    // -------------------------------------------------------------
    // 4. Doctor Verification Workflow
    // -------------------------------------------------------------
    process.stdout.write("Test 13: Admin reviews and approves pending doctor verification... ");
    const approveDoc = await request(
      "POST",
      `/api/admin/doctors/${doctorUser._id}/verify`,
      { decision: "verified", notes: "Credentials and license confirmed with medical council." },
      superAdminToken
    );
    assert.strictEqual(approveDoc.status, 200);
    assert.strictEqual(approveDoc.body.doctor.verificationStatus, "verified");
    console.log("✔ PASSED");

    process.stdout.write("Test 14: Doctor rejection without mandatory reason is rejected with 400... ");
    const badReject = await request(
      "POST",
      `/api/admin/doctors/${doctorUser._id}/verify`,
      { decision: "rejected", rejectionReason: "" },
      superAdminToken
    );
    assert.strictEqual(badReject.status, 400);
    assert.match(badReject.body.message, /reason is mandatory/i);
    console.log("✔ PASSED");

    // -------------------------------------------------------------
    // 5. Global Appointment Administration
    // -------------------------------------------------------------
    process.stdout.write("Test 15: Admin can view and update appointment with reason... ");
    const testAppt = await Appointment.create({
      patientId: patientUser._id,
      doctorId: doctorUser._id,
      doctorName: doctorUser.name,
      patientName: patientUser.name,
      appointmentDate: new Date(),
      timeSlot: "11:00 AM - 11:30 AM",
      status: "Scheduled",
      consultationType: "Video / Online",
    });

    const apptList = await request("GET", "/api/admin/appointments", null, superAdminToken);
    assert.strictEqual(apptList.status, 200);
    assert.ok(apptList.body.appointments.length >= 1);

    const updateAppt = await request(
      "PATCH",
      `/api/admin/appointments/${testAppt._id}`,
      { status: "Completed", reason: "Admin verified patient attended consultation" },
      superAdminToken
    );
    assert.strictEqual(updateAppt.status, 200);
    assert.strictEqual(updateAppt.body.appointment.status, "Completed");
    console.log("✔ PASSED");

    // -------------------------------------------------------------
    // 6. Medical Report Operational Storage
    // -------------------------------------------------------------
    process.stdout.write("Test 16: Admin reports endpoint returns metadata without leaking clinical text... ");
    await Report.create({
      userId: patientUser._id,
      uploadedBy: doctorUser._id,
      uploadedByRole: "doctor",
      uploaderName: doctorUser.name,
      fileName: "cbc_report_test.pdf",
      originalName: "Complete Blood Count.pdf",
      blobUrl: "https://mockstorage/cbc.pdf",
      blobPath: "cbc.pdf",
      fileType: "application/pdf",
      fileSize: 1048576,
      category: "Blood Test",
      ocrText: "CONFIDENTIAL PATIENT CLINICAL DATA: Hemoglobin 11.2, Platelets 140000",
      analysisStatus: "Completed",
    });

    const reportsRes = await request("GET", "/api/admin/reports", null, superAdminToken);
    assert.strictEqual(reportsRes.status, 200);
    assert.ok(reportsRes.body.reports.length >= 1);
    reportsRes.body.reports.forEach((r) => {
      assert.strictEqual(r.ocrText, undefined);
      assert.strictEqual(r.aiAnalysis, undefined);
      assert.ok(r.fileName);
      assert.ok(r.fileSize);
    });
    console.log("✔ PASSED");

    // -------------------------------------------------------------
    // 7. Security Dashboard & Audit Logs
    // -------------------------------------------------------------
    process.stdout.write("Test 17: Security audit logs track actions and cannot be modified or deleted... ");
    const auditRes = await request("GET", "/api/admin/security/audit-logs", null, superAdminToken);
    assert.strictEqual(auditRes.status, 200);
    assert.ok(Array.isArray(auditRes.body.logs));
    assert.ok(auditRes.body.pagination.total >= 1);

    const secOverview = await request("GET", "/api/admin/security/overview", null, superAdminToken);
    assert.strictEqual(secOverview.status, 200);
    assert.ok(secOverview.body.summary.suspensions7d >= 1);

    // Verify AuditLog immutability
    const sampleLog = await AuditLog.findOne();
    if (sampleLog) {
      await assert.rejects(
        async () => {
          await AuditLog.updateOne({ _id: sampleLog._id }, { action: "Tampered Action" });
        },
        /immutable append-only/i
      );

      await assert.rejects(
        async () => {
          await AuditLog.deleteOne({ _id: sampleLog._id });
        },
        /immutable append-only/i
      );
    }
    console.log("✔ PASSED");

    // -------------------------------------------------------------
    // 8. System Health
    // -------------------------------------------------------------
    process.stdout.write("Test 18: System health endpoint returns operational states without secrets... ");
    const healthRes = await request("GET", "/api/admin/system-health", null, superAdminToken);
    assert.strictEqual(healthRes.status, 200);
    assert.strictEqual(healthRes.body.services.backend.status, "Healthy");
    assert.strictEqual(healthRes.body.services.database.status, "Healthy");
    assert.strictEqual(healthRes.body.services.appointmentExpiryWorker.status, "Active");
    console.log("✔ PASSED");

    // -------------------------------------------------------------
    // 9. Support Management
    // -------------------------------------------------------------
    process.stdout.write("Test 19: Support queries can be listed and resolved with notes... ");
    const testInquiry = await Contact.create({
      name: "Patient Inquirer",
      email: "inquiry@test.com",
      phoneNumber: "9876543210",
      query: "How do I download my historical blood report?",
      status: "New",
    });

    const inquiriesRes = await request("GET", "/api/admin/support", null, superAdminToken);
    assert.strictEqual(inquiriesRes.status, 200);
    assert.ok(inquiriesRes.body.queries.length >= 1);

    const resolveRes = await request(
      "PATCH",
      `/api/admin/support/${testInquiry._id}`,
      { status: "Resolved", resolutionNotes: "Contacted patient and provided PDF download link instructions." },
      superAdminToken
    );
    assert.strictEqual(resolveRes.status, 200);
    assert.strictEqual(resolveRes.body.inquiry.status, "Resolved");
    assert.strictEqual(resolveRes.body.inquiry.resolutionNotes, "Contacted patient and provided PDF download link instructions.");
    console.log("✔ PASSED");

    console.log("\n==========================================================");
    console.log("  ALL 19 SUPER ADMIN & SECURITY TESTS PASSED!             ");
    console.log("==========================================================\n");
  } finally {
    // Clean up test fixtures
    await User.deleteMany({ email: { $regex: String(timestamp) } });
    await User.deleteMany({ email: { $regex: "attacker.com" } });
    await Appointment.deleteMany({ patientName: patientUser.name });
    await Report.deleteMany({ fileName: "cbc_report_test.pdf" });
    await Contact.deleteMany({ email: "inquiry@test.com" });

    server.close();
    await mongoose.disconnect();
  }
};

runSuite().catch((err) => {
  console.error("Test suite failed:", err);
  if (server) server.close();
  process.exit(1);
});
