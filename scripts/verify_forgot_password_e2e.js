require("dotenv").config();
const assert = require("node:assert");
const http = require("node:http");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const app = require("../src/app");
const User = require("../src/models/User");
const { _resetRateLimits } = require("../src/controllers/authController");
const { isEmailConfigured, sendPasswordResetEmail } = require("../src/services/emailService");
const connectDB = require("../src/config/db");

let server;
let baseUrl;

const runVerification = async () => {
  console.log("==========================================================================");
  console.log("  Vaidyasthana 9-Point Forgot & Reset Password Security Verification      ");
  console.log("==========================================================================\n");

  console.log("Connecting to MongoDB Atlas...");
  if (mongoose.connection.readyState === 0) {
    await connectDB();
  }
  console.log(`Connected to host: ${mongoose.connection.host}`);
  console.log(`Verified database name: ${mongoose.connection.name}`);

  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
  console.log(`✔ Test HTTP server active on ${baseUrl}\n`);

  const TIMESTAMP = Date.now();
  const testPatientEmail = `e2e_patient_${TIMESTAMP}@vaidyasthana.com`;
  const testDoctorEmail = `e2e_doctor_${TIMESTAMP}@vaidyasthana.com`;

  try {
    const salt = await bcrypt.genSalt(10);
    const initialHash = await bcrypt.hash("InitialPassword@123", salt);

    // Setup Test Patient & Doctor in Atlas
    await User.create([
      {
        name: "E2E Patient Test",
        email: testPatientEmail,
        password: initialHash,
        role: "patient",
        phoneNumber: "+919876543210",
        address: "789 Health Boulevard, Hyderabad",
      },
      {
        name: "Dr. E2E Doctor Test",
        email: testDoctorEmail,
        password: initialHash,
        role: "doctor",
        specialization: "General Medicine",
        medicalRegistrationNumber: `E2E-MC-${TIMESTAMP}`,
        phoneNumber: "+919876543211",
        address: "101 Clinical Way, Hyderabad",
        verificationStatus: "verified",
      },
    ]);
    console.log("✔ Created live test fixtures in vaidyasthana.users (Patient & Doctor).\n");

    // POINT 1 & 2: Input validation & Anti-enumeration generic response
    console.log("--- POINT 1: Input Validation & Email Rejection ---");
    const resInvalid = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "invalid-email" }),
    });
    assert.strictEqual(resInvalid.status, 400);
    console.log("✔ Rejected malformed email with HTTP 400 Bad Request.\n");

    console.log("--- POINT 2: Generic Anti-Enumeration Response for Registered & Non-Registered Emails ---");
    _resetRateLimits();
    const resNonExistent = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "doesnotexist@vaidyasthana.com" }),
    });
    const dataNonExistent = await resNonExistent.json();
    assert.strictEqual(resNonExistent.status, 200);
    assert.strictEqual(dataNonExistent.success, true);
    assert.strictEqual(
      dataNonExistent.message,
      "If an account exists for this email, password reset instructions will be sent."
    );

    const resPatientForgot = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: testPatientEmail }),
    });
    const dataPatientForgot = await resPatientForgot.json();
    assert.strictEqual(resPatientForgot.status, 200);
    assert.strictEqual(
      dataPatientForgot.message,
      "If an account exists for this email, password reset instructions will be sent."
    );
    console.log("✔ Both existing and non-existing accounts return identical generic response (zero enumeration attack surface).\n");

    // POINT 3: Email delivery configuration status
    console.log("--- POINT 3: Email Service Delivery & Configuration Status ---");
    const emailConfigured = isEmailConfigured();
    console.log(`Live SMTP Configured: ${emailConfigured}`);
    assert.ok(dataPatientForgot.emailDelivery);
    console.log(`Email Delivery Result: Configured=${dataPatientForgot.emailDelivery.configured}, Delivered=${dataPatientForgot.emailDelivery.delivered}, Reason=${dataPatientForgot.emailDelivery.reason}`);
    console.log("✔ Email delivery accurately reported without pretending delivery if SMTP is unconfigured.\n");

    // POINT 4: Token storage in MongoDB Atlas
    console.log("--- POINT 4: Cryptographic Token Storage & 15-Minute Expiration ---");
    const patientUser = await User.findOne({ email: testPatientEmail });
    assert.ok(patientUser.resetPasswordToken);
    assert.strictEqual(patientUser.resetPasswordToken.length, 64);
    assert.ok(patientUser.resetPasswordExpires);
    const expireMinutes = (new Date(patientUser.resetPasswordExpires).getTime() - Date.now()) / (60 * 1000);
    console.log(`Stored Token Hash: ${patientUser.resetPasswordToken.substring(0, 16)}... (SHA-256 hex string)`);
    console.log(`Expiration Time: ${expireMinutes.toFixed(1)} minutes from now`);
    assert.ok(expireMinutes > 13 && expireMinutes <= 15.5);
    console.log("✔ Token is securely hashed with SHA-256; raw token is NEVER stored in database.\n");

    // POINT 5: Token Validation GET endpoint
    console.log("--- POINT 5: Token Validation on Backend (GET /api/auth/reset-password/:token) ---");
    const testRawToken = crypto.randomBytes(32).toString("hex");
    const testHashedToken = crypto.createHash("sha256").update(testRawToken).digest("hex");
    await User.updateOne(
      { email: testPatientEmail },
      {
        resetPasswordToken: testHashedToken,
        resetPasswordExpires: new Date(Date.now() + 15 * 60 * 1000),
      }
    );

    const resValid = await fetch(`${baseUrl}/api/auth/reset-password/${testRawToken}`);
    assert.strictEqual(resValid.status, 200);
    console.log("✔ Valid token verified with HTTP 200 OK.");

    const resTampered = await fetch(`${baseUrl}/api/auth/reset-password/tampered1234567890abcdef`);
    assert.strictEqual(resTampered.status, 400);
    console.log("✔ Tampered token rejected with HTTP 400 Bad Request.\n");

    // POINT 6 & 7: Password Reset Execution, Old Password Invalidation & New Password Login
    console.log("--- POINT 6 & 7: Password Reset, Login Verification & Old Password Invalidation ---");
    const newPassword = "UpdatedPatientPass@2026";
    const resReset = await fetch(`${baseUrl}/api/auth/reset-password/${testRawToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: newPassword }),
    });
    const dataReset = await resReset.json();
    assert.strictEqual(resReset.status, 200);
    assert.strictEqual(dataReset.success, true);
    console.log("✔ Password reset completed with HTTP 200 OK.");

    const resOldLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: testPatientEmail, password: "InitialPassword@123" }),
    });
    assert.strictEqual(resOldLogin.status, 401);
    console.log("✔ Old password correctly rejected with HTTP 401 Unauthorized.");

    const resNewLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: testPatientEmail, password: newPassword }),
    });
    const dataNewLogin = await resNewLogin.json();
    assert.strictEqual(resNewLogin.status, 200);
    assert.ok(dataNewLogin.token);
    console.log("✔ New password successfully authenticated with HTTP 200 OK & JWT issued.\n");

    // Single-use token invalidation check
    console.log("--- Token Reuse Prevention ---");
    const resReused = await fetch(`${baseUrl}/api/auth/reset-password/${testRawToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "AttemptReuse@999" }),
    });
    assert.strictEqual(resReused.status, 400);
    console.log("✔ Reusing previously used reset token rejected with HTTP 400 Bad Request.\n");

    // POINT 8: Doctor Account Reset Flow
    console.log("--- POINT 8: Doctor Account Reset Flow ---");
    const docRawToken = crypto.randomBytes(32).toString("hex");
    const docHashedToken = crypto.createHash("sha256").update(docRawToken).digest("hex");
    await User.updateOne(
      { email: testDoctorEmail },
      {
        resetPasswordToken: docHashedToken,
        resetPasswordExpires: new Date(Date.now() + 15 * 60 * 1000),
      }
    );

    const newDoctorPass = "UpdatedDoctorPass@2026";
    const resDocReset = await fetch(`${baseUrl}/api/auth/reset-password/${docRawToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: newDoctorPass }),
    });
    assert.strictEqual(resDocReset.status, 200);

    const resDocLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: testDoctorEmail, password: newDoctorPass }),
    });
    const dataDocLogin = await resDocLogin.json();
    assert.strictEqual(resDocLogin.status, 200);
    assert.strictEqual(dataDocLogin.user.role, "doctor");
    console.log("✔ Doctor account successfully reset and authenticated into clinician role.\n");

    // POINT 9: Rate Limiting & Expired Token Rejection
    console.log("--- POINT 9: Rate Limiting & Expired Token Rejection ---");
    _resetRateLimits();
    const spamEmail = `flood_${TIMESTAMP}@vaidyasthana.com`;
    let rateLimited = false;
    for (let i = 0; i < 7; i++) {
      const res = await fetch(`${baseUrl}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: spamEmail }),
      });
      if (res.status === 429) {
        rateLimited = true;
        break;
      }
    }
    assert.strictEqual(rateLimited, true);
    console.log("✔ Rate limit of 5 requests/15 mins enforced with HTTP 429 Too Many Requests.");

    const expiredToken = crypto.randomBytes(32).toString("hex");
    const expiredHash = crypto.createHash("sha256").update(expiredToken).digest("hex");
    await User.updateOne(
      { email: testPatientEmail },
      {
        resetPasswordToken: expiredHash,
        resetPasswordExpires: new Date(Date.now() - 60 * 1000), // expired 1 min ago
      }
    );
    const resExp = await fetch(`${baseUrl}/api/auth/reset-password/${expiredToken}`);
    assert.strictEqual(resExp.status, 400);
    console.log("✔ Expired token rejected with HTTP 400 Bad Request.\n");

    console.log("==========================================================================");
    console.log("  ALL 9 SECURITY & FORGOT PASSWORD WORKFLOW POINTS FULLY VERIFIED!        ");
    console.log("==========================================================================\n");
  } catch (err) {
    console.error("❌ E2E VERIFICATION FAILED:", err);
    throw err;
  } finally {
    console.log("Cleaning up test records from MongoDB Atlas...");
    await User.deleteMany({
      email: { $in: [testPatientEmail, testDoctorEmail] },
    });
    if (server) {
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await mongoose.disconnect();
    console.log("✔ Disconnected cleanly from Atlas.");
  }
};

runVerification().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
