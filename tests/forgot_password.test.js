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

const TEST_TIMESTAMP = Date.now();
const patientEmail = `reset_patient_${TEST_TIMESTAMP}@vaidyasthana.com`;
const doctorEmail = `reset_doctor_${TEST_TIMESTAMP}@vaidyasthana.com`;

const runSuite = async () => {
  console.log("=================================================");
  console.log("   Vaidyasthana Forgot & Reset Password Tests   ");
  console.log("=================================================");

  console.log("1. Connecting to MongoDB Atlas...");
  if (mongoose.connection.readyState === 0) {
    await connectDB();
  }
  console.log("✔ Connected to MongoDB Atlas.");

  // Spin up test HTTP server
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
  console.log(`✔ Test HTTP server listening on ${baseUrl}`);

  try {
    console.log("2. Setting up test fixtures in Atlas...");
    const salt = await bcrypt.genSalt(10);
    const initialPasswordHash = await bcrypt.hash("InitialPass@123", salt);

    await User.deleteMany({
      email: { $in: [patientEmail, doctorEmail] },
    });

    await User.create([
      {
        name: "Reset Test Patient",
        email: patientEmail,
        password: initialPasswordHash,
        role: "patient",
        phoneNumber: "+919876543210",
        address: "123 Patient Lane, Hyderabad",
      },
      {
        name: "Reset Test Doctor",
        email: doctorEmail,
        password: initialPasswordHash,
        role: "doctor",
        specialization: "General Medicine",
        medicalRegistrationNumber: `MC-${TEST_TIMESTAMP}`,
        phoneNumber: "+919876543211",
        address: "456 Doctor Clinic, Hyderabad",
        verificationStatus: "verified",
      },
    ]);
    console.log("✔ Test fixtures created (Patient & Doctor).");

    // Test 1: Validation
    console.log("Testing 1: Input validation on forgot-password... ");
    _resetRateLimits();
    const resEmpty = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(resEmpty.status, 400);

    const resInvalid = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "invalid-email-pattern" }),
    });
    assert.strictEqual(resInvalid.status, 400);
    console.log("✔ PASSED");

    // Test 2: Anti-enumeration
    console.log("Testing 2: Anti-enumeration generic response... ");
    _resetRateLimits();
    const resNonExistent = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nonexistent_999@vaidyasthana.com" }),
    });
    const dataNonExistent = await resNonExistent.json();
    assert.strictEqual(resNonExistent.status, 200);
    assert.strictEqual(dataNonExistent.success, true);
    assert.strictEqual(
      dataNonExistent.message,
      "If an account exists for this email, password reset instructions will be sent."
    );
    assert.strictEqual(dataNonExistent.devResetUrl, undefined);
    console.log("✔ PASSED");

    // Test 3: Rate limiting
    console.log("Testing 3: Rate limiting guard (5 requests/15 mins)... ");
    _resetRateLimits();
    const spamEmail = `spam_${TEST_TIMESTAMP}@vaidyasthana.com`;
    let hitLimit = false;
    for (let i = 0; i < 7; i++) {
      const res = await fetch(`${baseUrl}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: spamEmail }),
      });
      if (res.status === 429) {
        hitLimit = true;
        break;
      }
    }
    assert.strictEqual(hitLimit, true);
    _resetRateLimits();
    console.log("✔ PASSED");

    // Test 4: Token generation and hashing in Atlas
    console.log("Testing 4: Cryptographic SHA-256 token storage & 15m expiry... ");
    const resForgot = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: patientEmail }),
    });
    const dataForgot = await resForgot.json();
    assert.strictEqual(resForgot.status, 200);
    assert.strictEqual(dataForgot.success, true);
    assert.ok(dataForgot.emailDelivery);

    const patientInDb = await User.findOne({ email: patientEmail });
    assert.ok(patientInDb.resetPasswordToken);
    assert.strictEqual(patientInDb.resetPasswordToken.length, 64);
    assert.ok(patientInDb.resetPasswordExpires);
    const diffMins = (new Date(patientInDb.resetPasswordExpires).getTime() - Date.now()) / (60 * 1000);
    assert.ok(diffMins > 13 && diffMins <= 15.5);
    console.log("✔ PASSED");

    // Test 5: Token validation GET endpoint
    console.log("Testing 5: GET /api/auth/reset-password/:token validation... ");
    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    await User.updateOne(
      { email: patientEmail },
      {
        resetPasswordToken: hashedToken,
        resetPasswordExpires: new Date(Date.now() + 15 * 60 * 1000),
      }
    );

    const resValidToken = await fetch(`${baseUrl}/api/auth/reset-password/${rawToken}`);
    assert.strictEqual(resValidToken.status, 200);

    const resInvalidToken = await fetch(`${baseUrl}/api/auth/reset-password/00000000000000000000000000000000`);
    assert.strictEqual(resInvalidToken.status, 400);
    console.log("✔ PASSED");

    // Test 6: Patient password reset and login verification
    console.log("Testing 6: Patient password reset & login verification... ");
    const newPatientPass = "NewPatientSecure@2026";
    const resResetShort = await fetch(`${baseUrl}/api/auth/reset-password/${rawToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "123" }),
    });
    assert.strictEqual(resResetShort.status, 400);

    const resResetOk = await fetch(`${baseUrl}/api/auth/reset-password/${rawToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: newPatientPass }),
    });
    assert.strictEqual(resResetOk.status, 200);

    // Old pass fails
    const resOldLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: patientEmail, password: "InitialPass@123" }),
    });
    assert.strictEqual(resOldLogin.status, 401);

    // New pass succeeds
    const resNewLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: patientEmail, password: newPatientPass }),
    });
    assert.strictEqual(resNewLogin.status, 200);
    console.log("✔ PASSED");

    // Test 7: Token reuse prevention
    console.log("Testing 7: Token reuse prevention (single-use enforcement)... ");
    const resReused = await fetch(`${baseUrl}/api/auth/reset-password/${rawToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "AnotherPass@999" }),
    });
    assert.strictEqual(resReused.status, 400);
    console.log("✔ PASSED");

    // Test 8: Doctor account password reset
    console.log("Testing 8: Doctor account password reset flow... ");
    const docRawToken = crypto.randomBytes(32).toString("hex");
    const docHashedToken = crypto.createHash("sha256").update(docRawToken).digest("hex");
    await User.updateOne(
      { email: doctorEmail },
      {
        resetPasswordToken: docHashedToken,
        resetPasswordExpires: new Date(Date.now() + 15 * 60 * 1000),
      }
    );

    const newDocPass = "NewDoctorSecure@2026";
    const resDocReset = await fetch(`${baseUrl}/api/auth/reset-password/${docRawToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: newDocPass }),
    });
    assert.strictEqual(resDocReset.status, 200);

    const resDocLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: doctorEmail, password: newDocPass }),
    });
    const dataDocLogin = await resDocLogin.json();
    assert.strictEqual(resDocLogin.status, 200);
    assert.strictEqual(dataDocLogin.user.role, "doctor");
    console.log("✔ PASSED");

    // Test 9: Expired token rejection
    console.log("Testing 9: Rejection of expired tokens... ");
    const expRawToken = crypto.randomBytes(32).toString("hex");
    const expHashedToken = crypto.createHash("sha256").update(expRawToken).digest("hex");
    await User.updateOne(
      { email: patientEmail },
      {
        resetPasswordToken: expHashedToken,
        resetPasswordExpires: new Date(Date.now() - 5 * 60 * 1000), // expired 5 mins ago
      }
    );

    const resValidateExp = await fetch(`${baseUrl}/api/auth/reset-password/${expRawToken}`);
    assert.strictEqual(resValidateExp.status, 400);

    const resResetExp = await fetch(`${baseUrl}/api/auth/reset-password/${expRawToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "AttemptExpired@2026" }),
    });
    assert.strictEqual(resResetExp.status, 400);
    console.log("✔ PASSED");

    // Test 10: Email service configuration verification
    console.log("Testing 10: Email service safe unconfigured report... ");
    const originalHost = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    assert.strictEqual(isEmailConfigured(), false);
    const emailRes = await sendPasswordResetEmail({
      to: "test@example.com",
      name: "Test User",
      resetUrl: "http://localhost:3000/reset-password/sampletoken",
    });
    assert.strictEqual(emailRes.delivered, false);
    assert.strictEqual(emailRes.reason, "SMTP_NOT_CONFIGURED");
    if (originalHost) process.env.SMTP_HOST = originalHost;
    console.log("✔ PASSED");

    console.log("\n=================================================");
    console.log("  ALL 10 FORGOT & RESET PASSWORD TESTS PASSED!   ");
    console.log("=================================================\n");
  } catch (err) {
    console.error("\n❌ TEST ENCOUNTERED AN ERROR:", err);
    throw err;
  } finally {
    console.log("Cleaning up test users in Atlas...");
    await User.deleteMany({
      email: { $in: [patientEmail, doctorEmail] },
    });

    if (server) {
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }

    await mongoose.disconnect();
    console.log("✔ Disconnected cleanly from Atlas.");
  }
};

runSuite().then(
  () => process.exit(0),
  (err) => {
    console.error("\n❌ FORGOT PASSWORD TEST SUITE FAILED:", err);
    process.exit(1);
  }
);
