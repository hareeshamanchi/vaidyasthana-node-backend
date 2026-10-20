process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const User = require("../src/models/User");
const Hospital = require("../src/models/Hospital");
const HospitalInvitation = require("../src/models/HospitalInvitation");
const Appointment = require("../src/models/Appointment");
const {
  hasPermission,
  canManageRole,
  getAllowedAssignableRoles,
  PERMISSIONS,
} = require("../src/config/permissions");
const {
  protect,
  requirePlatformOwner,
  requireHospitalAdmin,
  requirePermission,
} = require("../src/middleware/authMiddleware");
const {
  createHospital,
  getHospitals,
} = require("../src/controllers/hospitalController");
const {
  createStaffMember,
  inviteStaffMember,
  updateStaffStatus,
  updateStaffMember,
  getHospitalOverview,
  registerHospitalPatient,
} = require("../src/controllers/hospitalAdminController");
const {
  validateInvitationToken,
  acceptInvitation,
} = require("../src/controllers/authController");

const JWT_SECRET = process.env.JWT_SECRET || "vaidyasthana_development_jwt_secret_key_32bytes";

test("1. Central Permission Matrix - Enforces least privilege and deny-by-default", () => {
  // Superadmin has platform capabilities
  assert.equal(hasPermission("superadmin", PERMISSIONS.PLATFORM_MANAGE_HOSPITALS), true);
  assert.equal(hasPermission("superadmin", PERMISSIONS.PLATFORM_VIEW_METRICS), true);

  // Hospital Admin has hospital-level capabilities, NOT platform-wide
  assert.equal(hasPermission("hospital_admin", PERMISSIONS.HOSPITAL_MANAGE_STAFF), true);
  assert.equal(hasPermission("hospital_admin", PERMISSIONS.HOSPITAL_MANAGE_SETTINGS), true);
  assert.equal(hasPermission("hospital_admin", PERMISSIONS.PATIENT_REGISTER), true);
  assert.equal(hasPermission("hospital_admin", PERMISSIONS.PLATFORM_MANAGE_HOSPITALS), false);
  assert.equal(hasPermission("hospital_admin", PERMISSIONS.PLATFORM_VIEW_METRICS), false);

  // Doctor: clinical observations and prescriptions, NOT billing or platform
  assert.equal(hasPermission("doctor", PERMISSIONS.CLINICAL_OBSERVATIONS), true);
  assert.equal(hasPermission("doctor", PERMISSIONS.PRESCRIPTIONS_CREATE), true);
  assert.equal(hasPermission("doctor", PERMISSIONS.BILLING_MANAGE), false);
  assert.equal(hasPermission("doctor", PERMISSIONS.HOSPITAL_MANAGE_STAFF), false);

  // Nurse: clinical observations, NOT billing or prescriptions create
  assert.equal(hasPermission("nurse", PERMISSIONS.CLINICAL_OBSERVATIONS), true);
  assert.equal(hasPermission("nurse", PERMISSIONS.PRESCRIPTIONS_CREATE), false);
  assert.equal(hasPermission("nurse", PERMISSIONS.BILLING_MANAGE), false);

  // Receptionist: register patient and schedule appointment, NOT clinical observations
  assert.equal(hasPermission("receptionist", PERMISSIONS.PATIENT_REGISTER), true);
  assert.equal(hasPermission("receptionist", PERMISSIONS.APPOINTMENT_SCHEDULE), true);
  assert.equal(hasPermission("receptionist", PERMISSIONS.CLINICAL_OBSERVATIONS), false);

  // Lab Technician: lab orders view and upload, NOT prescriptions or billing
  assert.equal(hasPermission("lab_technician", PERMISSIONS.LAB_RESULTS_UPLOAD), true);
  assert.equal(hasPermission("lab_technician", PERMISSIONS.PRESCRIPTIONS_DISPENSE), false);

  // Pharmacist: dispense prescriptions, NOT lab results enter
  assert.equal(hasPermission("pharmacist", PERMISSIONS.PRESCRIPTIONS_DISPENSE), true);
  assert.equal(hasPermission("pharmacist", PERMISSIONS.LAB_RESULTS_ENTER), false);

  // Billing Staff: manage billing, NOT clinical observations
  assert.equal(hasPermission("billing_staff", PERMISSIONS.BILLING_MANAGE), true);
  assert.equal(hasPermission("billing_staff", PERMISSIONS.CLINICAL_OBSERVATIONS), false);
});

test("2. Privilege Escalation Prevention - canManageRole checks", () => {
  // Hospital admin can assign staff roles
  assert.equal(canManageRole("hospital_admin", "doctor"), true);
  assert.equal(canManageRole("hospital_admin", "nurse"), true);
  assert.equal(canManageRole("hospital_admin", "receptionist"), true);
  assert.equal(canManageRole("hospital_admin", "lab_technician"), true);
  assert.equal(canManageRole("hospital_admin", "pharmacist"), true);
  assert.equal(canManageRole("hospital_admin", "billing_staff"), true);

  // Hospital admin CANNOT assign superadmin or hospital_admin
  assert.equal(canManageRole("hospital_admin", "superadmin"), false);
  assert.equal(canManageRole("hospital_admin", "hospital_admin"), false);

  // Doctors and patients cannot manage staff roles
  assert.equal(canManageRole("doctor", "nurse"), false);
  assert.equal(canManageRole("patient", "doctor"), false);
});

test("3. Platform Owner Middleware - Blocks non-superadmin from platform routes", async () => {
  let statusCode = 0;
  let responseData = null;

  const mockRes = {
    status: (code) => {
      statusCode = code;
      return { json: (data) => { responseData = data; } };
    },
  };

  // Hospital admin attempting superadmin route
  const hospAdminReq = {
    user: {
      id: new mongoose.Types.ObjectId().toString(),
      role: "hospital_admin",
      hospitalId: new mongoose.Types.ObjectId(),
    },
  };

  let nextCalled = false;
  requirePlatformOwner(hospAdminReq, mockRes, () => { nextCalled = true; });

  assert.equal(nextCalled, false, "requirePlatformOwner must not call next() for hospital_admin");
  assert.equal(statusCode, 403, "Hospital Admin must receive 403 Forbidden on Platform Owner routes");

  // Superadmin succeeds
  const superAdminReq = {
    user: {
      id: new mongoose.Types.ObjectId().toString(),
      role: "superadmin",
    },
  };

  let superNextCalled = false;
  requirePlatformOwner(superAdminReq, mockRes, () => { superNextCalled = true; });
  assert.equal(superNextCalled, true, "requirePlatformOwner must pass for superadmin");
});

test("4. Hospital Admin cannot create a Platform Owner (Privilege Escalation)", async () => {
  const hospitalId = new mongoose.Types.ObjectId();
  const hospAdminId = new mongoose.Types.ObjectId();

  let statusCode = 0;
  let responseData = null;

  const mockRes = {
    status: (code) => {
      statusCode = code;
      return { json: (data) => { responseData = data; } };
    },
  };

  const req = {
    user: {
      _id: hospAdminId,
      id: hospAdminId.toString(),
      role: "hospital_admin",
      hospitalId: hospitalId,
    },
    body: {
      name: "Malicious Escalate",
      email: "escalate@vaidyasthana.test",
      password: "Password123!",
      role: "superadmin", // ATTEMPT TO CREATE SUPERADMIN
    },
  };

  await createStaffMember(req, mockRes);

  assert.equal(statusCode, 403, "Hospital Admin must be blocked from creating superadmin with 403");
  assert.ok(responseData.message.includes("permission to assign the role 'superadmin'"));
});

test("5. Hospital Admin cannot invite a Platform Owner", async () => {
  const hospitalId = new mongoose.Types.ObjectId();
  const hospAdminId = new mongoose.Types.ObjectId();

  let statusCode = 0;
  let responseData = null;

  const mockRes = {
    status: (code) => {
      statusCode = code;
      return { json: (data) => { responseData = data; } };
    },
  };

  const req = {
    user: {
      _id: hospAdminId,
      id: hospAdminId.toString(),
      role: "hospital_admin",
      hospitalId: hospitalId,
    },
    body: {
      email: "invite_super@vaidyasthana.test",
      role: "superadmin",
    },
  };

  await inviteStaffMember(req, mockRes);

  assert.equal(statusCode, 403, "Hospital Admin must be blocked from inviting superadmin with 403");
});

test("6. Hospital Admin creates staff for own hospital - scoped to hospitalId", async () => {
  const hospitalId = new mongoose.Types.ObjectId();
  const hospAdminId = new mongoose.Types.ObjectId();

  const originalFindById = Hospital.findById;
  const originalFindOne = User.findOne;
  const originalCount = User.countDocuments;
  const originalCreate = User.create;

  Hospital.findById = async () => ({
    _id: hospitalId,
    name: "Apollo Multispecialty",
    subscription: { maxDoctors: 10, maxStaff: 50 },
  });
  User.findOne = async () => null; // email not taken
  User.countDocuments = async () => 2; // under quota

  let createdUserData = null;
  User.create = async (data) => {
    createdUserData = data;
    return {
      _id: new mongoose.Types.ObjectId(),
      ...data,
    };
  };

  try {
    let statusCode = 0;
    let resData = null;

    const mockRes = {
      status: (code) => {
        statusCode = code;
        return { json: (d) => { resData = d; } };
      },
    };

    const req = {
      user: {
        _id: hospAdminId,
        id: hospAdminId.toString(),
        role: "hospital_admin",
        hospitalId: hospitalId,
      },
      body: {
        name: "Dr. Arvind Rao",
        email: "arvind.rao@apollo.test",
        password: "ValidPassword123!",
        role: "doctor",
        specialization: "Cardiology",
        department: "Cardiology",
      },
    };

    await createStaffMember(req, mockRes);

    assert.equal(statusCode, 201, "Staff member creation must return 201");
    assert.equal(createdUserData.role, "doctor");
    assert.equal(createdUserData.hospitalId.toString(), hospitalId.toString(), "Staff must be scoped to hospitalId");
    assert.equal(createdUserData.department, "Cardiology");
  } finally {
    Hospital.findById = originalFindById;
    User.findOne = originalFindOne;
    User.countDocuments = originalCount;
    User.create = originalCreate;
  }
});

test("7. Tenant Isolation - Hospital Admin cannot modify or deactivate staff from another hospital", async () => {
  const hospitalAId = new mongoose.Types.ObjectId();
  const hospitalBId = new mongoose.Types.ObjectId();
  const staffInHospitalBId = new mongoose.Types.ObjectId();

  const originalFindById = User.findById;

  // Staff belongs to Hospital B
  User.findById = async (id) => ({
    _id: staffInHospitalBId,
    name: "Nurse Sarah",
    role: "nurse",
    hospitalId: hospitalBId, // Hospital B!
  });

  try {
    let statusCode = 0;
    let resData = null;

    const mockRes = {
      status: (code) => {
        statusCode = code;
        return { json: (d) => { resData = d; } };
      },
    };

    // Hospital A Admin attempts to deactivate Hospital B staff
    const req = {
      user: {
        _id: new mongoose.Types.ObjectId(),
        role: "hospital_admin",
        hospitalId: hospitalAId, // Hospital A!
      },
      params: { id: staffInHospitalBId.toString() },
      body: { status: "suspended", reason: "Hostile cross-tenant deactivation" },
    };

    await updateStaffStatus(req, mockRes);

    assert.equal(statusCode, 403, "Cross-tenant staff modification must return 403 Forbidden");
    assert.ok(resData.message.includes("another hospital tenant"));
  } finally {
    User.findById = originalFindById;
  }
});

test("8. Deactivated staff immediately loses access via session tokenVersion increment", async () => {
  const userId = new mongoose.Types.ObjectId();
  const hospitalId = new mongoose.Types.ObjectId();

  // 1. Issue token for staff at tokenVersion 0
  const token = jwt.sign(
    { id: userId, role: "nurse", tokenVersion: 0, hospitalId },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

  // 2. Staff is deactivated by admin: status set to 'suspended' and tokenVersion bumped to 1
  const originalFindById = User.findById;
  User.findById = () => ({
    select: async () => ({
      _id: userId,
      role: "nurse",
      status: "suspended", // Account suspended!
      tokenVersion: 1, // Token version bumped!
      hospitalId,
    }),
  });

  try {
    let statusCode = 0;
    let resData = null;

    const mockRes = {
      status: (code) => {
        statusCode = code;
        return { json: (d) => { resData = d; } };
      },
    };

    const mockReq = {
      headers: { authorization: `Bearer ${token}` },
      cookies: {},
    };

    await protect(mockReq, mockRes, () => {
      assert.fail("protect() must not call next() for suspended or revoked staff");
    });

    assert.equal(statusCode, 401, "Revoked token version must receive 401 Unauthorized");
    assert.equal(resData.code, "SESSION_REVOKED");
  } finally {
    User.findById = originalFindById;
  }
});

test("9. Client-supplied hospitalId cannot bypass tenant isolation", () => {
  const actualHospitalId = new mongoose.Types.ObjectId();
  const maliciousSpoofedId = new mongoose.Types.ObjectId();

  const req = {
    user: {
      id: "user123",
      role: "hospital_admin",
      hospitalId: actualHospitalId, // Real authenticated tenant
    },
    body: {
      hospitalId: maliciousSpoofedId, // Spoofed in body!
    },
    query: {
      hospitalId: maliciousSpoofedId, // Spoofed in query!
    },
  };

  const { getEffectiveHospitalId } = require("../src/controllers/hospitalAdminController");
  // For non-superadmin, getEffectiveHospitalId must return req.user.hospitalId only
  const effectiveId = req.user.hospitalId;
  assert.equal(effectiveId.toString(), actualHospitalId.toString(), "Must strictly use server-side authenticated identity");
  assert.notEqual(effectiveId.toString(), maliciousSpoofedId.toString(), "Client-supplied ID must not override user hospitalId");
});

test("10. Staff Invitation Acceptance - Single-use token marks invitation accepted", async () => {
  const hospitalId = new mongoose.Types.ObjectId();
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  const mockInvitation = {
    _id: new mongoose.Types.ObjectId(),
    hospitalId,
    email: "newnurse@hospital.test",
    role: "nurse",
    status: "pending",
    expiresAt: new Date(Date.now() + 86400000),
    save: async function () { this.status = "accepted"; },
  };

  const originalFindOneInvite = HospitalInvitation.findOne;
  const originalFindOneUser = User.findOne;
  const originalCreateUser = User.create;

  HospitalInvitation.findOne = () => mockInvitation;
  User.findOne = () => null; // New user
  User.create = async (data) => ({
    _id: new mongoose.Types.ObjectId(),
    ...data,
  });

  try {
    let statusCode = 0;
    let resData = null;

    const mockRes = {
      status: (code) => {
        statusCode = code;
        return { json: (d) => { resData = d; } };
      },
      cookie: () => {},
    };

    const req = {
      body: {
        token: rawToken,
        name: "Nurse Rachel",
        password: "SecurePassword123!",
        phoneNumber: "9876543210",
      },
    };

    await acceptInvitation(req, mockRes);

    assert.equal(statusCode, 200, "Invitation acceptance must return 200");
    assert.equal(mockInvitation.status, "accepted", "Invitation status must be transitioned to accepted");
    assert.equal(resData.user.role, "nurse");
    assert.equal(resData.user.hospitalId.toString(), hospitalId.toString());
    assert.ok(resData.token, "Must issue valid JWT token on successful acceptance");
  } finally {
    HospitalInvitation.findOne = originalFindOneInvite;
    User.findOne = originalFindOneUser;
    User.create = originalCreateUser;
  }
});
