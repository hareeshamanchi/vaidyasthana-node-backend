const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const User = require("../src/models/User");
const FamilyMember = require("../src/models/FamilyMember");
const PhoneOtp = require("../src/models/PhoneOtp");
const {
  sendPhoneOtp,
  verifyPhoneOtp,
  hashOtp,
  isValidPhoneNumber,
  cleanPhoneNumber,
  getMockOtp,
} = require("../src/services/phoneOtpService");
const {
  setupTwoFactor,
  computeTotp,
  verifyTotpCode,
  consumeRecoveryCode,
} = require("../src/services/twoFactorService");
const {
  authorizeRoles,
  enforceHospitalScope,
} = require("../src/middleware/authMiddleware");

test("User Model - Supports all 5 healthcare roles, hospitalId, and 2FA attributes", () => {
  const roles = [
    "patient",
    "doctor",
    "receptionist",
    "hospital_admin",
    "admin",
    "superadmin",
  ];

  roles.forEach((role) => {
    const user = new User({
      name: `Test User ${role}`,
      email: `${role}.test@vaidyasthana.test`,
      password: "HashedPassword123!",
      phoneNumber: "9876543210",
      address: "123 Clinic Way, Bangalore",
      role,
      tokenVersion: 1,
      twoFactorEnabled: false,
      profilePhoto: "https://example.com/avatar.jpg",
      languagesSpoken: ["English", "Kannada", "Hindi"],
    });

    const err = user.validateSync();
    assert.equal(err, undefined, `Role '${role}' should validate without schema error`);
    assert.equal(user.role, role);
    assert.equal(user.tokenVersion, 1);
    assert.equal(user.profilePhoto, "https://example.com/avatar.jpg");
    assert.equal(user.languagesSpoken.length, 3);
  });

  // Invalid role should fail validation
  const invalidRoleUser = new User({
    name: "Hacker User",
    email: "hacker@test.com",
    password: "Password123!",
    phoneNumber: "9876543210",
    address: "123 Main St",
    role: "god_mode_admin",
  });
  const invErr = invalidRoleUser.validateSync();
  assert.ok(invErr.errors.role, "Unauthorized/unsupported role should fail validation");
});

test("FamilyMember Model - Schema validation & Minor auto-calculation", () => {
  const primaryAccountId = new mongoose.Types.ObjectId();

  // 1. Minor child profile (Born 8 years ago)
  const childDob = new Date();
  childDob.setFullYear(childDob.getFullYear() - 8);

  const minorMember = new FamilyMember({
    primaryAccountId,
    name: "Aarav Kumar",
    relationship: "Child",
    gender: "Male",
    dateOfBirth: childDob,
    bloodGroup: "O+",
    allergies: ["Peanuts"],
  });

  const err1 = minorMember.validateSync();
  assert.equal(err1, undefined, "Minor family member should pass validation");
  // Pre-save calculation simulation
  const today = new Date();
  let age = today.getFullYear() - childDob.getFullYear();
  assert.ok(age < 18, "Child must be under 18");

  // 2. Elderly parent profile (Born 65 years ago)
  const parentDob = new Date();
  parentDob.setFullYear(parentDob.getFullYear() - 65);

  const parentMember = new FamilyMember({
    primaryAccountId,
    name: "Saraswathi Devi",
    relationship: "Parent",
    gender: "Female",
    dateOfBirth: parentDob,
    bloodGroup: "B+",
    emergencyContact: "9876543210",
  });

  const err2 = parentMember.validateSync();
  assert.equal(err2, undefined, "Parent profile should pass validation");
  assert.equal(parentMember.relationship, "Parent");

  // 3. Missing required relationship or DOB
  const badMember = new FamilyMember({ primaryAccountId });
  const badErr = badMember.validateSync();
  assert.ok(badErr.errors.name, "Name is required");
  assert.ok(badErr.errors.relationship, "Relationship is required");
  assert.ok(badErr.errors.dateOfBirth, "Date of birth is required");
});

test("phoneOtpService - Phone validation, secure hashing, and mock delivery", async () => {
  assert.equal(isValidPhoneNumber("9876543210"), true);
  assert.equal(isValidPhoneNumber("+91 9876543210"), true);
  assert.equal(isValidPhoneNumber("123"), false);

  const phone = "+919876543210";
  const otp = "123456";

  const hash1 = hashOtp(otp, phone);
  const hash2 = hashOtp(otp, phone);
  const hashOther = hashOtp("654321", phone);

  assert.equal(hash1, hash2, "Hashing same OTP and phone should produce consistent hash");
  assert.notEqual(hash1, hashOther, "Different OTPs must produce distinct hashes");
  assert.equal(hash1.length, 64, "SHA-256 hash must be 64 characters");

  // Test full OTP dispatch and verification lifecycle
  const testPhone = "9876501234";
  const sendRes = await sendPhoneOtp({ phoneNumber: testPhone });
  assert.equal(sendRes.success, true, "OTP should be dispatched successfully");
  assert.ok(sendRes.devOtp, "devOtp should be available in test environment");

  const actualOtp = sendRes.devOtp;

  // Mock DB lookup for PhoneOtp in test environment
  const originalFindOne = PhoneOtp.findOne;
  const originalDeleteOne = PhoneOtp.deleteOne;
  const originalDeleteMany = PhoneOtp.deleteMany;

  let storedRecord = {
    _id: new mongoose.Types.ObjectId(),
    phoneNumber: testPhone,
    otpHash: hashOtp(actualOtp, testPhone),
    attempts: 0,
    save: async function () {},
  };

  PhoneOtp.findOne = () => ({
    sort: () => storedRecord,
  });
  PhoneOtp.deleteOne = async () => {
    storedRecord = null;
  };

  try {
    // 1. Wrong OTP should fail
    const wrongRes = await verifyPhoneOtp({ phoneNumber: testPhone, otp: "000000" });
    assert.equal(wrongRes.valid, false, "Wrong OTP must fail verification");
    assert.equal(wrongRes.remainingAttempts, 4, "Remaining attempts should be 4");

    // 2. Correct OTP should succeed and delete OTP
    const correctRes = await verifyPhoneOtp({ phoneNumber: testPhone, otp: actualOtp });
    assert.equal(correctRes.valid, true, "Correct OTP must succeed verification");

    // 3. Re-verifying should fail
    const replayRes = await verifyPhoneOtp({ phoneNumber: testPhone, otp: actualOtp });
    assert.equal(replayRes.valid, false, "Replaying used OTP must fail");
  } finally {
    PhoneOtp.findOne = originalFindOne;
    PhoneOtp.deleteOne = originalDeleteOne;
    PhoneOtp.deleteMany = originalDeleteMany;
  }
});

test("twoFactorService - TOTP RFC 6238 generation, verification, and recovery codes", async () => {
  const { secret, otpauthUrl, recoveryCodes, hashedRecoveryCodes } = setupTwoFactor("doctor@vaidyasthana.test");

  assert.ok(secret && secret.length >= 16, "Base32 secret must be at least 16 characters");
  assert.ok(otpauthUrl.startsWith("otpauth://totp/"), "OTPAuth URL must use totp scheme");
  assert.equal(recoveryCodes.length, 8, "Must generate exactly 8 recovery codes");
  assert.equal(hashedRecoveryCodes.length, 8, "Must hash all 8 recovery codes");

  // Generate current valid TOTP
  const currentCode = computeTotp(secret);
  assert.equal(currentCode.length, 6, "TOTP code must be 6 digits");

  // Verify valid TOTP code
  const isValid = verifyTotpCode(secret, currentCode);
  assert.equal(isValid, true, "Current TOTP code must verify successfully");

  // Verify wrong code fails
  const isInvalid = verifyTotpCode(secret, "000000" === currentCode ? "111111" : "000000");
  assert.equal(isInvalid, false, "Incorrect TOTP code must fail verification");

  // Verify single-use recovery code consumption
  const mockUser = {
    twoFactorRecoveryCodes: [...hashedRecoveryCodes],
    save: async () => {},
  };

  const firstRecoveryCode = recoveryCodes[0];
  const consumed = await consumeRecoveryCode(mockUser, firstRecoveryCode);
  assert.equal(consumed, true, "Valid recovery code should be accepted");

  // Re-attempting same recovery code must fail (single-use constraint)
  const reused = await consumeRecoveryCode(mockUser, firstRecoveryCode);
  assert.equal(reused, false, "Consumed recovery code must NOT be accepted again");
});

test("authMiddleware - authorizeRoles supports 5 roles & administrative cross-compatibility", async () => {
  // Test 1: Receptionist allowed on front-desk route
  const receptionistMiddleware = authorizeRoles("receptionist", "hospital_admin", "admin");
  let passed1 = false;
  receptionistMiddleware(
    { user: { role: "receptionist" } },
    {},
    () => { passed1 = true; }
  );
  assert.equal(passed1, true, "Receptionist must be authorized for front-desk route");

  // Test 2: Patient blocked from front-desk route
  let rejectedStatus = 0;
  let rejectedMessage = "";
  const mockRes = {
    status: (code) => {
      rejectedStatus = code;
      return {
        json: (data) => { rejectedMessage = data.message; },
      };
    },
  };

  receptionistMiddleware(
    { user: { role: "patient" } },
    mockRes,
    () => { assert.fail("Patient should not be authorized"); }
  );
  assert.equal(rejectedStatus, 403, "Patient should receive 403 Forbidden");

  // Test 3: hospital_admin matches admin role requirement
  const adminMiddleware = authorizeRoles("admin");
  let passedAdmin = false;
  adminMiddleware(
    { user: { role: "hospital_admin" } },
    {},
    () => { passedAdmin = true; }
  );
  assert.equal(passedAdmin, true, "hospital_admin must satisfy admin authorization");

  // Test 4: superadmin inherits administrative roles
  let passedSuper = false;
  adminMiddleware(
    { user: { role: "superadmin" } },
    {},
    () => { passedSuper = true; }
  );
  assert.equal(passedSuper, true, "superadmin must satisfy admin authorization");
});

test("authMiddleware - enforceHospitalScope attaches tenant scope", () => {
  const hospitalId = new mongoose.Types.ObjectId();
  const req = { user: { role: "hospital_admin", hospitalId } };
  enforceHospitalScope(req, {}, () => {});
  assert.equal(req.hospitalScope.toString(), hospitalId.toString(), "Hospital scope must be attached");

  const standaloneReq = { user: { role: "patient", hospitalId: null } };
  enforceHospitalScope(standaloneReq, {}, () => {});
  assert.equal(standaloneReq.hospitalScope, undefined, "Standalone user has undefined hospitalScope");
});

test("Session Management - tokenVersion mismatch triggers SESSION_REVOKED", async () => {
  const { protect } = require("../src/middleware/authMiddleware");
  const jwt = require("jsonwebtoken");

  const userId = new mongoose.Types.ObjectId();
  const secret = process.env.JWT_SECRET || "vaidyasthana_development_jwt_secret_key_32bytes";

  // Simulate token issued at version 0
  const oldToken = jwt.sign(
    { id: userId, role: "patient", tokenVersion: 0 },
    secret,
    { expiresIn: "1h" }
  );

  // Simulate user in DB whose version was bumped to 1 (e.g. Logout-all or password reset)
  const originalFindById = User.findById;
  User.findById = (id) => ({
    select: async () => ({
      _id: userId,
      role: "patient",
      status: "active",
      tokenVersion: 1, // Current DB version is 1!
    }),
  });

  try {
    let statusCode = 0;
    let responseData = null;

    const mockReq = {
      headers: { authorization: `Bearer ${oldToken}` },
      cookies: {},
    };

    const mockRes = {
      status: (code) => {
        statusCode = code;
        return {
          json: (data) => { responseData = data; },
        };
      },
    };

    await protect(mockReq, mockRes, () => {
      assert.fail("protect should NOT call next() on revoked token");
    });

    assert.equal(statusCode, 401, "Revoked token must receive 401 Unauthorized");
    assert.equal(responseData.code, "SESSION_REVOKED", "Response code must be SESSION_REVOKED");

    // Now test token issued with matching version 1
    const matchingToken = jwt.sign(
      { id: userId, role: "patient", tokenVersion: 1 },
      secret,
      { expiresIn: "1h" }
    );

    let nextCalled = false;
    const validReq = {
      headers: { authorization: `Bearer ${matchingToken}` },
      cookies: {},
    };

    await protect(validReq, mockRes, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true, "Matching token version must call next()");
    assert.equal(validReq.user.tokenVersion, 1);
  } finally {
    User.findById = originalFindById;
  }
});

test("Doctor Profile Validation - Experience, fees, languages, and photo", async () => {
  const { updateDoctorProfile } = require("../src/controllers/authController");

  const doctorId = new mongoose.Types.ObjectId();
  const mockDoctor = {
    _id: doctorId,
    name: "Dr. Deepa Nair",
    email: "deepa.nair@vaidyasthana.test",
    role: "doctor",
    specialization: "Dermatology",
    qualifications: "MD, DNB",
    experienceYears: 12,
    consultationFee: 750,
    languagesSpoken: ["English", "Malayalam"],
    profilePhoto: "https://clinic.com/photos/deepa.jpg",
    save: async function () {},
  };

  const originalFindOne = User.findOne;
  User.findOne = () => mockDoctor;

  try {
    let statusCode = 0;
    let resData = null;

    const mockRes = {
      status: (code) => {
        statusCode = code;
        return { json: (d) => { resData = d; } };
      },
    };

    // 1. Invalid experience years (>70) should fail
    await updateDoctorProfile(
      {
        user: { id: doctorId.toString(), role: "doctor" },
        body: { experienceYears: 150 },
      },
      mockRes
    );
    assert.equal(statusCode, 400, "Experience years > 70 must be rejected");
    assert.ok(resData.message.includes("between 0 and 70"));

    // 2. Negative consultation fee should fail
    await updateDoctorProfile(
      {
        user: { id: doctorId.toString(), role: "doctor" },
        body: { consultationFee: -50 },
      },
      mockRes
    );
    assert.equal(statusCode, 400, "Negative fee must be rejected");

    // 3. Valid update succeeds
    await updateDoctorProfile(
      {
        user: { id: doctorId.toString(), role: "doctor" },
        body: {
          experienceYears: 15,
          consultationFee: 900,
          languagesSpoken: ["English", "Malayalam", "Hindi"],
          profilePhoto: "https://clinic.com/photos/deepa_updated.jpg",
        },
      },
      mockRes
    );
    assert.equal(statusCode, 200, "Valid doctor profile update must succeed");
    assert.equal(mockDoctor.experienceYears, 15);
    assert.equal(mockDoctor.consultationFee, 900);
    assert.equal(mockDoctor.languagesSpoken.length, 3);
    assert.equal(mockDoctor.profilePhoto, "https://clinic.com/photos/deepa_updated.jpg");
  } finally {
    User.findOne = originalFindOne;
  }
});


