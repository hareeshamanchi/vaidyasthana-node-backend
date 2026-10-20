const User = require("../models/User");
const HospitalInvitation = require("../models/HospitalInvitation");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const crypto = require("crypto");
const {
  isEmailConfigured,
  getEmailProvider,
  sendPasswordResetEmail,
} = require("../services/emailService");
const { createNotification } = require("../services/notificationService");
const { recordAuditEvent, extractIpAddress, maskIp } = require("../services/auditService");
const { sendPhoneOtp, verifyPhoneOtp } = require("../services/phoneOtpService");
const {
  setupTwoFactor,
  verifyTotpCode,
  consumeRecoveryCode,
} = require("../services/twoFactorService");

// Rate limiting configuration
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_EMAIL_LIMIT = 5; // 5 attempts per 15 min per email (protects inbox from spam)
const DEFAULT_IP_LIMIT = 30; // 30 attempts per 15 min per IP (accommodates shared hospital/clinic networks & prevents bot enumeration)

// Rate limiting storage: key -> array of timestamps
const passwordResetAttempts = new Map();
// In-flight request tracker to prevent duplicate concurrent submissions from burning tokens
const inFlightPasswordResets = new Set();
// Rate limiting map for login requests: key -> array of timestamps
const loginAttempts = new Map();

/**
 * Prunes expired timestamps older than windowMs.
 *
 * @param {number[]} timestamps
 * @param {number} now
 * @param {number} windowMs
 * @returns {number[]}
 */
const pruneTimestamps = (timestamps, now, windowMs) => {
  if (!Array.isArray(timestamps)) return [];
  return timestamps.filter((t) => now - t < windowMs);
};

/**
 * Periodically sweeps and purges expired entries from memory to prevent map leaks.
 */
const sweepStaleRateLimits = (now = Date.now(), windowMs = RATE_LIMIT_WINDOW_MS) => {
  for (const [key, timestamps] of passwordResetAttempts.entries()) {
    const valid = pruneTimestamps(timestamps, now, windowMs);
    if (valid.length === 0) {
      passwordResetAttempts.delete(key);
    } else {
      passwordResetAttempts.set(key, valid);
    }
  }
  for (const [key, timestamps] of loginAttempts.entries()) {
    const valid = pruneTimestamps(timestamps, now, windowMs);
    if (valid.length === 0) {
      loginAttempts.delete(key);
    } else {
      loginAttempts.set(key, valid);
    }
  }
};

// Automatic sweep every 5 minutes (unref so process can exit cleanly during tests)
const sweepTimer = setInterval(sweepStaleRateLimits, 5 * 60 * 1000);
if (sweepTimer.unref) sweepTimer.unref();

/**
 * Differentiated rate limiter for Forgot Password requests.
 * - Enforces per-email quota (default: 5 / 15m) to protect individual email accounts.
 * - Enforces per-IP quota (default: 30 / 15m) to accommodate shared hospital/clinic networks
 *   while mitigating automated bot enumeration attacks.
 * - Prunes stale timestamps on access.
 * - Returns detailed diagnostic metrics and Retry-After duration.
 *
 * @param {{ email: string, clientIp: string, now?: number }} params
 * @returns {{
 *   limited: boolean,
 *   triggerType?: 'email' | 'ip',
 *   count?: number,
 *   max?: number,
 *   retryAfterSeconds?: number,
 *   maskedKey?: string
 * }}
 */
const checkForgotPasswordRateLimit = ({ email, clientIp, now = Date.now() }) => {
  const windowMs = RATE_LIMIT_WINDOW_MS;
  const maxEmailAttempts =
    parseInt(process.env.FORGOT_PASSWORD_EMAIL_LIMIT, 10) || DEFAULT_EMAIL_LIMIT;
  const maxIpAttempts =
    parseInt(process.env.FORGOT_PASSWORD_IP_LIMIT, 10) || DEFAULT_IP_LIMIT;

  const emailKey = `email:${(email || "").toLowerCase().trim()}`;
  const ipKey = `ip:${(clientIp || "unknown").trim()}`;

  // 1. Check per-email bucket
  const emailTimestamps = pruneTimestamps(
    passwordResetAttempts.get(emailKey) || [],
    now,
    windowMs
  );
  if (emailTimestamps.length >= maxEmailAttempts) {
    passwordResetAttempts.set(emailKey, emailTimestamps);
    const oldest = emailTimestamps[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return {
      limited: true,
      triggerType: "email",
      count: emailTimestamps.length,
      max: maxEmailAttempts,
      retryAfterSeconds,
      maskedKey: maskEmail(email),
    };
  }

  // 2. Check per-IP bucket
  const ipTimestamps = pruneTimestamps(
    passwordResetAttempts.get(ipKey) || [],
    now,
    windowMs
  );
  if (ipTimestamps.length >= maxIpAttempts) {
    passwordResetAttempts.set(ipKey, ipTimestamps);
    const oldest = ipTimestamps[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return {
      limited: true,
      triggerType: "ip",
      count: ipTimestamps.length,
      max: maxIpAttempts,
      retryAfterSeconds,
      maskedKey: maskIp(clientIp),
    };
  }

  // 3. Record attempt in both buckets
  emailTimestamps.push(now);
  passwordResetAttempts.set(emailKey, emailTimestamps);

  ipTimestamps.push(now);
  passwordResetAttempts.set(ipKey, ipTimestamps);

  return { limited: false };
};

// Legacy helper preserved for backward compatibility and direct helper tests
const isRateLimited = (identifier, maxAttempts = 5, windowMs = RATE_LIMIT_WINDOW_MS) => {
  const now = Date.now();
  const timestamps = passwordResetAttempts.get(identifier) || [];
  const validTimestamps = pruneTimestamps(timestamps, now, windowMs);

  if (validTimestamps.length >= maxAttempts) {
    passwordResetAttempts.set(identifier, validTimestamps);
    return true;
  }

  validTimestamps.push(now);
  passwordResetAttempts.set(identifier, validTimestamps);
  return false;
};

const isLoginRateLimited = (identifier, maxAttempts = 10, windowMs = RATE_LIMIT_WINDOW_MS) => {
  const now = Date.now();
  const timestamps = loginAttempts.get(identifier) || [];
  const validTimestamps = pruneTimestamps(timestamps, now, windowMs);

  if (validTimestamps.length >= maxAttempts) {
    loginAttempts.set(identifier, validTimestamps);
    return true;
  }

  return false;
};

const recordFailedLogin = (identifier) => {
  const now = Date.now();
  const timestamps = loginAttempts.get(identifier) || [];
  timestamps.push(now);
  loginAttempts.set(identifier, timestamps);
};

const clearLoginAttempts = (identifier) => {
  loginAttempts.delete(identifier);
};

const _resetRateLimits = () => {
  passwordResetAttempts.clear();
  loginAttempts.clear();
  inFlightPasswordResets.clear();
};

const isDbConnected = () => mongoose.connection.readyState === 1;

const getJwtSecret = () =>
  process.env.JWT_SECRET || "vaidyasthana_development_jwt_secret_key_32bytes";

const getJwtExpiresIn = () =>
  process.env.JWT_EXPIRES_IN || "7d";

// Validate phone number (must contain between 10 and 15 digits)
const validatePhoneNumber = (phone) => {
  if (!phone || typeof phone !== "string") return false;
  const trimmed = phone.trim();
  const digitsOnly = trimmed.replace(/\D/g, "");
  return digitsOnly.length >= 10 && digitsOnly.length <= 15;
};

// Normalize phone number
const normalizePhoneNumber = (phone) => {
  if (!phone) return "";
  return phone.trim();
};

// Generate JWT token with tokenVersion and hospitalId embedded
const generateToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      role: user.role,
      name: user.name,
      email: user.email,
      tokenVersion: user.tokenVersion || 0,
      hospitalId: user.hospitalId || null,
    },
    getJwtSecret(),
    {
      expiresIn: getJwtExpiresIn(),
    }
  );
};

// Generate temporary 5-minute token for 2FA challenge resolution
const generate2FaTempToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      email: user.email,
      type: "2fa_pending",
    },
    getJwtSecret(),
    {
      expiresIn: "5m",
    }
  );
};

// ==========================================
// Register User
// POST /api/auth/register
// ==========================================
const registerUser = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      phoneNumber,
      address,
      city,
      state,
      postalCode,
      role,
      specialization,
      qualifications,
      medicalRegistrationNumber,
      experienceYears,
      consultationFee,
    } = req.body;

    // Validate Required Identity Fields
    if (!name || String(name).trim() === "") {
      return res.status(400).json({
        success: false,
        field: "name",
        message: "Full name is required.",
      });
    }

    if (!email || String(email).trim() === "") {
      return res.status(400).json({
        success: false,
        field: "email",
        message: "Valid email address is required.",
      });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        field: "password",
        message: "Password must be at least 6 characters long.",
      });
    }

    // Validate Mandatory Mobile Phone Number (both patient & doctor)
    if (!phoneNumber || String(phoneNumber).trim() === "") {
      return res.status(400).json({
        success: false,
        field: "phoneNumber",
        message: "Mobile phone number is mandatory for clinical identification.",
      });
    }

    if (!validatePhoneNumber(phoneNumber)) {
      return res.status(400).json({
        success: false,
        field: "phoneNumber",
        message: "Please provide a valid 10-digit mobile phone number (e.g. +91 9876543210 or 9876543210).",
      });
    }

    // Validate Mandatory Complete Address (both patient & doctor)
    if (!address || String(address).trim() === "") {
      return res.status(400).json({
        success: false,
        field: "address",
        message: "Complete residential or clinic address is mandatory.",
      });
    }

    if (String(address).trim().length < 5) {
      return res.status(400).json({
        success: false,
        field: "address",
        message: "Address must include street/locality details (minimum 5 characters).",
      });
    }

    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable. Please verify MONGODB_URI in environment.",
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        field: "email",
        message: "An account with this email already exists.",
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Security Rule: Public registration can ONLY create "patient" or "doctor" accounts.
    // Privileged roles ("admin", "superadmin") can NEVER be registered publicly.
    const assignedRole = role === "doctor" ? "doctor" : "patient";

    // Clinician verification: doctors registering with credentials are verified and eligible to accept appointments
    const verificationStatus =
      req.body.verificationStatus ||
      (assignedRole === "doctor"
        ? (medicalRegistrationNumber && medicalRegistrationNumber.trim() ? "verified" : "verified")
        : "verified");

    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      phoneNumber: normalizePhoneNumber(phoneNumber),
      address: address.trim(),
      city: city ? city.trim() : "",
      state: state ? state.trim() : "",
      postalCode: postalCode ? postalCode.trim() : "",
      role: assignedRole,
      status: "active",
      specialization: assignedRole === "doctor" ? (specialization ? specialization.trim() : "General Medicine") : "General Medicine",
      qualifications: assignedRole === "doctor" ? (qualifications ? qualifications.trim() : "MBBS") : "MBBS",
      medicalRegistrationNumber: medicalRegistrationNumber ? medicalRegistrationNumber.trim() : "",
      experienceYears: Number(experienceYears) || 5,
      consultationFee: Number(consultationFee) || 500,
      profilePhoto: req.body.profilePhoto ? String(req.body.profilePhoto).trim() : "",
      languagesSpoken: Array.isArray(req.body.languagesSpoken) ? req.body.languagesSpoken : ["English"],
      hospitalId: req.body.hospitalId || null,
      verificationStatus,
    });

    const token = generateToken(user);

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    recordAuditEvent({
      eventType: "AUTH_REGISTER_SUCCESS",
      actor: user,
      action: `New ${user.role} account registered`,
      outcome: "success",
      req,
    });

    return res.status(201).json({
      success: true,
      message: "Account registered successfully",
      token,
      user: {
        id: user._id,
        _id: user._id,
        name: user.name,
        email: user.email,
        phoneNumber: user.phoneNumber,
        address: user.address,
        city: user.city,
        state: user.state,
        postalCode: user.postalCode,
        role: user.role,
        status: user.status,
        specialization: user.specialization,
        qualifications: user.qualifications,
        profilePhoto: user.profilePhoto || "",
        languagesSpoken: user.languagesSpoken || [],
        hospitalId: user.hospitalId || null,
        twoFactorEnabled: false,
        verificationStatus: user.verificationStatus,
        profileComplete: Boolean(user.phoneNumber && user.address),
      },
    });
  } catch (error) {
    console.error("Register Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during registration. Please try again.",
    });
  }
};

// ==========================================
// Login User
// POST /api/auth/login
// ==========================================
const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Please enter both email and password.",
      });
    }

    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable. Please verify MONGODB_URI in environment.",
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const clientIp = extractIpAddress(req);
    const rateLimitKey = `${clientIp}_${normalizedEmail}`;

    // Rate Limiting on repeated failed logins
    if (isLoginRateLimited(rateLimitKey, 10, 15 * 60 * 1000)) {
      recordAuditEvent({
        eventType: "RATE_LIMIT_TRIGGERED",
        actorEmail: normalizedEmail,
        action: "Login attempt throttled due to excessive failures",
        outcome: "warning",
        reason: "Too many consecutive failed login attempts",
        req,
      });

      return res.status(429).json({
        success: false,
        message: "Too many failed login attempts. Please wait 15 minutes before trying again.",
      });
    }

    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      recordFailedLogin(rateLimitKey);
      recordAuditEvent({
        eventType: "AUTH_LOGIN_FAILURE",
        actorEmail: normalizedEmail,
        action: "Login failed - account does not exist",
        outcome: "failure",
        reason: "Invalid credentials",
        req,
      });

      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    // Check account status: prevent suspended accounts from logging in
    if (user.status === "suspended") {
      recordAuditEvent({
        eventType: "AUTH_SUSPENDED_LOGIN_ATTEMPT",
        actor: user,
        action: "Suspended user attempted login",
        outcome: "failure",
        reason: "Account is suspended",
        req,
      });

      return res.status(403).json({
        success: false,
        code: "ACCOUNT_SUSPENDED",
        message: "Your account has been suspended. Please contact platform administration.",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      recordFailedLogin(rateLimitKey);
      recordAuditEvent({
        eventType: "AUTH_LOGIN_FAILURE",
        actor: user,
        action: "Login failed - incorrect password",
        outcome: "failure",
        reason: "Invalid credentials",
        req,
      });

      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    // Successful login: reset failed login counter
    clearLoginAttempts(rateLimitKey);

    // If Two-Factor Authentication is enabled, issue temporary 2FA token
    if (user.twoFactorEnabled) {
      const tempToken = generate2FaTempToken(user);
      return res.status(200).json({
        success: true,
        twoFactorRequired: true,
        tempToken,
        message: "Two-factor authentication code required. Please enter code from your authenticator app.",
      });
    }

    const isSuperOrAdmin = user.role === "superadmin" || user.role === "admin" || user.role === "hospital_admin";
    recordAuditEvent({
      eventType: isSuperOrAdmin ? "AUTH_ADMIN_LOGIN_SUCCESS" : "AUTH_LOGIN_SUCCESS",
      actor: user,
      action: `${user.role} logged in successfully`,
      outcome: "success",
      req,
    });

    const token = generateToken(user);

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    const isProfileComplete = Boolean(
      user.phoneNumber && user.phoneNumber.trim() && user.address && user.address.trim()
    );

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        _id: user._id,
        name: user.name,
        email: user.email,
        phoneNumber: user.phoneNumber,
        address: user.address,
        city: user.city,
        state: user.state,
        postalCode: user.postalCode,
        role: user.role,
        status: user.status || "active",
        specialization: user.specialization,
        qualifications: user.qualifications,
        profilePhoto: user.profilePhoto || "",
        languagesSpoken: user.languagesSpoken || [],
        hospitalId: user.hospitalId || null,
        twoFactorEnabled: Boolean(user.twoFactorEnabled),
        verificationStatus: user.verificationStatus,
        profileComplete: isProfileComplete,
      },
    });
  } catch (error) {
    console.error("Login Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during authentication.",
    });
  }
};

// ==========================================
// Get User Profile
// GET /api/auth/profile
// ==========================================
const getProfile = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const user = await User.findById(req.user.id).select("-password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User profile not found.",
      });
    }

    const isProfileComplete = Boolean(
      user.phoneNumber && user.phoneNumber.trim() && user.address && user.address.trim()
    );

    // Return safe document references (metadata only, no raw storage credentials)
    const safeDocuments = (user.verificationDocuments || []).map((doc) => ({
      _id: doc._id,
      documentType: doc.documentType,
      fileName: doc.fileName,
      originalName: doc.originalName,
      fileType: doc.fileType,
      fileSize: doc.fileSize,
      uploadedAt: doc.uploadedAt,
    }));

    return res.status(200).json({
      success: true,
      id: user._id,
      _id: user._id,
      name: user.name,
      email: user.email,
      phoneNumber: user.phoneNumber || "",
      address: user.address || "",
      city: user.city || "",
      state: user.state || "",
      postalCode: user.postalCode || "",
      role: user.role,
      status: user.status || "active",
      gender: user.gender,
      bloodGroup: user.bloodGroup,
      dateOfBirth: user.dateOfBirth,
      specialization: user.specialization,
      qualifications: user.qualifications,
      medicalRegistrationNumber: user.medicalRegistrationNumber,
      experienceYears: user.experienceYears,
      consultationFee: user.consultationFee,
      profilePhoto: user.profilePhoto || "",
      languagesSpoken: user.languagesSpoken || [],
      hospitalId: user.hospitalId || null,
      twoFactorEnabled: Boolean(user.twoFactorEnabled),
      verificationStatus: user.verificationStatus,
      verificationDocuments: safeDocuments,
      verificationReview: user.verificationReview,
      profileComplete: isProfileComplete,
      createdAt: user.createdAt,
    });
  } catch (error) {
    console.error("Get Profile Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve user profile.",
    });
  }
};

// ==========================================
// Update User Profile
// PUT /api/auth/profile
// ==========================================
const updateProfile = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const {
      name,
      phoneNumber,
      address,
      city,
      state,
      postalCode,
      gender,
      bloodGroup,
      dateOfBirth,
      specialization,
      qualifications,
      medicalRegistrationNumber,
      experienceYears,
      consultationFee,
    } = req.body;

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (name && name.trim()) user.name = name.trim();

    if (phoneNumber !== undefined) {
      const cleanPhone = String(phoneNumber).trim();
      if (cleanPhone === "") {
        return res.status(400).json({
          success: false,
          field: "phoneNumber",
          message: "Mobile phone number cannot be empty.",
        });
      }
      if (!validatePhoneNumber(cleanPhone)) {
        return res.status(400).json({
          success: false,
          field: "phoneNumber",
          message: "Please enter a valid 10-digit mobile number.",
        });
      }
      user.phoneNumber = normalizePhoneNumber(cleanPhone);
    }

    if (address !== undefined) {
      const cleanAddr = String(address).trim();
      if (cleanAddr === "") {
        return res.status(400).json({
          success: false,
          field: "address",
          message: "Address cannot be empty.",
        });
      }
      user.address = cleanAddr;
    }

    if (city !== undefined) user.city = city.trim();
    if (state !== undefined) user.state = state.trim();
    if (postalCode !== undefined) user.postalCode = postalCode.trim();
    if (gender !== undefined) user.gender = gender;
    if (bloodGroup !== undefined) user.bloodGroup = bloodGroup.trim();
    if (dateOfBirth !== undefined) user.dateOfBirth = dateOfBirth;
    if (req.body.profilePhoto !== undefined) user.profilePhoto = String(req.body.profilePhoto).trim();
    if (req.body.languagesSpoken !== undefined && Array.isArray(req.body.languagesSpoken)) {
      user.languagesSpoken = req.body.languagesSpoken.map((s) => String(s).trim()).filter(Boolean);
    }

    // Doctor specific updates (doctor or authorized admin)
    const isDoctorOrAdmin =
      user.role === "doctor" ||
      req.user.role === "admin" ||
      req.user.role === "superadmin" ||
      req.user.role === "hospital_admin";

    if (isDoctorOrAdmin) {
      if (specialization) user.specialization = specialization.trim();
      if (qualifications) user.qualifications = qualifications.trim();
      if (medicalRegistrationNumber) user.medicalRegistrationNumber = medicalRegistrationNumber.trim();
      if (experienceYears !== undefined) {
        const expNum = Number(experienceYears);
        if (!isNaN(expNum) && expNum >= 0 && expNum <= 70) {
          user.experienceYears = expNum;
        }
      }
      if (consultationFee !== undefined) {
        const feeNum = Number(consultationFee);
        if (!isNaN(feeNum) && feeNum >= 0 && feeNum <= 100000) {
          user.consultationFee = feeNum;
        }
      }
    }

    await user.save();

    const isProfileComplete = Boolean(
      user.phoneNumber && user.phoneNumber.trim() && user.address && user.address.trim()
    );

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully.",
      user: {
        id: user._id,
        _id: user._id,
        name: user.name,
        email: user.email,
        phoneNumber: user.phoneNumber,
        address: user.address,
        city: user.city,
        state: user.state,
        postalCode: user.postalCode,
        role: user.role,
        gender: user.gender,
        bloodGroup: user.bloodGroup,
        dateOfBirth: user.dateOfBirth,
        specialization: user.specialization,
        qualifications: user.qualifications,
        profilePhoto: user.profilePhoto || "",
        languagesSpoken: user.languagesSpoken || [],
        hospitalId: user.hospitalId || null,
        twoFactorEnabled: Boolean(user.twoFactorEnabled),
        verificationStatus: user.verificationStatus,
        profileComplete: isProfileComplete,
      },
    });
  } catch (error) {
    console.error("Update Profile Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update profile.",
    });
  }
};

const DEPLOYED_FRONTEND_URL = "https://vaidyasthana-frontend.onrender.com";

/**
 * Masks an email address for safe diagnostic logging without leaking PII.
 * Example: 'patient@example.com' -> 'p***t@example.com'
 *
 * @param {string} email
 * @returns {string}
 */
const maskEmail = (email) => {
  if (!email || typeof email !== "string" || !email.includes("@")) return "[INVALID_EMAIL]";
  const [localPart, domain] = email.split("@");
  if (localPart.length <= 2) {
    return `${localPart[0]}***@${domain}`;
  }
  return `${localPart[0]}***${localPart[localPart.length - 1]}@${domain}`;
};

/**
 * Determines the frontend base URL for password reset links.
 * Strictly avoids localhost, 127.0.0.1, or private LAN IPs in production.
 * Ensures HTTPS protocol in production.
 *
 * @param {Object} req - Express request object
 * @returns {string} - Clean base URL without trailing slash
 */
const getFrontendBaseUrl = (req) => {
  let candidate = (
    process.env.FRONTEND_URL ||
    process.env.CLIENT_URL ||
    ""
  )
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\/+$/, "");

  const isProd =
    process.env.NODE_ENV === "production" ||
    process.env.RENDER === "true" ||
    Boolean(process.env.RENDER_SERVICE_ID) ||
    Boolean(process.env.RENDER_INSTANCE_ID);

  // If candidate is not explicitly set
  if (!candidate) {
    if (isProd) {
      return DEPLOYED_FRONTEND_URL;
    }
    const origin = req?.get ? req.get("origin") : req?.headers?.origin;
    if (origin && !origin.includes("localhost") && !origin.includes("127.0.0.1")) {
      return origin.replace(/\/+$/, "");
    }
    return DEPLOYED_FRONTEND_URL;
  }

  // Detect localhost, 127.0.0.1, or private LAN IPs
  const isLocalOrPrivate =
    /^(https?:\/\/)?(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?/i.test(
      candidate
    );

  if (isProd) {
    if (isLocalOrPrivate) {
      console.warn(
        `[SAFE_DIAGNOSTIC] FRONTEND_URL (${candidate}) points to local/private network in production. Overriding with official deployed HTTPS URL (${DEPLOYED_FRONTEND_URL}).`
      );
      return DEPLOYED_FRONTEND_URL;
    }
    // In production, force HTTPS
    if (candidate.startsWith("http://")) {
      candidate = candidate.replace(/^http:\/\//i, "https://");
    } else if (!candidate.startsWith("https://")) {
      candidate = `https://${candidate}`;
    }
    return candidate;
  }

  // Development/Test environment: ensure valid protocol prefix
  if (!candidate.startsWith("http://") && !candidate.startsWith("https://")) {
    candidate = `http://${candidate}`;
  }

  return candidate;
};

// ==========================================
// Request Password Reset
// POST /api/auth/forgot-password
// ==========================================
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    // Stage 1: Input Validation & Sanitization
    if (!email || typeof email !== "string" || !email.trim()) {
      return res.status(400).json({
        success: false,
        message: "A valid email address is required.",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const normalizedEmail = email.trim().toLowerCase();

    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address.",
      });
    }

    console.log(
      `[SAFE_DIAGNOSTIC] Stage 1: Forgot-password request received for masked address: ${maskEmail(normalizedEmail)}`
    );

    // Anti-enumeration generic response (consistent whether user exists or not)
    const genericResponse = {
      success: true,
      message: "If an account exists for this email, password reset instructions will be sent.",
    };

    // Client IP extraction: uses reverse proxy aware extractIpAddress
    const clientIp = extractIpAddress(req) || "unknown";

    // In-flight concurrent duplicate request check (handles rapid double clicks without burning tokens)
    if (inFlightPasswordResets.has(normalizedEmail)) {
      console.log(
        `[SAFE_DIAGNOSTIC] Stage 1: Concurrent in-flight request active for ${maskEmail(normalizedEmail)}. Returning anti-enumeration response without double-processing.`
      );
      return res.status(200).json(genericResponse);
    }

    // Differentiated Rate Limiting Guard:
    // - 5 attempts per 15 min per email (protects individual account inboxes from flooding)
    // - 30 attempts per 15 min per IP (accommodates shared hospital/clinic networks & stops automated bot enumeration)
    const rateCheck = checkForgotPasswordRateLimit({
      email: normalizedEmail,
      clientIp,
    });

    if (rateCheck.limited) {
      console.warn(
        `[SAFE_DIAGNOSTIC] Stage 1: Rate limit triggered by ${rateCheck.triggerType} for [${rateCheck.maskedKey}]. Attempts: ${rateCheck.count}/${rateCheck.max}. Retry-After: ${rateCheck.retryAfterSeconds}s. Client IP: ${maskIp(clientIp)}`
      );
      res.set("Retry-After", String(rateCheck.retryAfterSeconds));
      return res.status(429).json({
        success: false,
        message: "Too many password reset requests. Please wait 15 minutes before trying again.",
        retryAfter: rateCheck.retryAfterSeconds,
      });
    }

    inFlightPasswordResets.add(normalizedEmail);
    try {
      // Stage 2: Database Connection Readiness Check
      if (!isDbConnected()) {
        console.error(
          "[SAFE_DIAGNOSTIC] Stage 2: Database connection not ready (readyState !== 1). Returning 503 Service Unavailable."
        );
        return res.status(503).json({
          success: false,
          message: "Database service is temporarily unavailable. Please retry shortly.",
        });
      }
      console.log("[SAFE_DIAGNOSTIC] Stage 2: Database connection readiness check PASSED.");

      // Stage 3: Account Lookup & Anti-Enumeration Protection
      const user = await User.findOne({ email: normalizedEmail });

      if (!user) {
        console.log(
          "[SAFE_DIAGNOSTIC] Stage 3: Account lookup completed. No account matched. Returning generic anti-enumeration response."
        );
        return res.status(200).json(genericResponse);
      }
    console.log(
      `[SAFE_DIAGNOSTIC] Stage 3: Account lookup completed. Account found (Role: ${user.role}). Proceeding with single-use token generation.`
    );

    // Safety verification: The user account must have a real, valid email address
    if (
      !user.email ||
      typeof user.email !== "string" ||
      !emailRegex.test(user.email.trim())
    ) {
      console.warn(
        `[SAFE_DIAGNOSTIC] Account found for reset but has missing or invalid email format. Skipping email dispatch.`
      );
      return res.status(200).json(genericResponse);
    }

    const recipientEmail = user.email.trim().toLowerCase();

    // Guard against placeholder / fake domains if any exist in DB
    const placeholderDomains = ["example.com", "example.org", "test.com", "placeholder.com"];
    const emailDomain = recipientEmail.split("@")[1];
    if (placeholderDomains.includes(emailDomain)) {
      console.warn(
        `[SAFE_DIAGNOSTIC] Account email domain (${emailDomain}) is a known placeholder. Skipping email dispatch.`
      );
      return res.status(200).json(genericResponse);
    }

    // Stage 4: Cryptographically secure single-use token (32 bytes = 256 bits entropy)
    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");

    // 15-minute expiration
    const expiresInMinutes = 15;
    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = new Date(Date.now() + expiresInMinutes * 60 * 1000);
    await user.save();
    console.log(
      `[SAFE_DIAGNOSTIC] Stage 4: Cryptographic token generated (256-bit entropy). SHA-256 digest committed to MongoDB Atlas. Expiry: ${expiresInMinutes} minutes.`
    );

    recordAuditEvent({
      eventType: "AUTH_PASSWORD_RESET_REQUEST",
      actor: user,
      action: "Password reset requested",
      outcome: "success",
      details: { maskedEmail: maskEmail(recipientEmail) },
      req,
    });

    // Notify user of security event
    createNotification({
      userId: user._id,
      title: "Security Alert: Password Reset Requested",
      message:
        "A password reset request was initiated for your account. If you did not make this request, please review your account immediately.",
      type: "security_event",
      link: "/forgot-password",
    }).catch((e) => console.error("Forgot pass notify error:", e.message));

    // Stage 5: URL Construction & Origin Verification
    const frontendBaseUrl = getFrontendBaseUrl(req);
    const resetUrl = `${frontendBaseUrl}/reset-password/${encodeURIComponent(rawToken)}`;
    console.log(
      `[SAFE_DIAGNOSTIC] Stage 5: Reset URL generated using base origin: ${frontendBaseUrl}. Target route: /reset-password/<token_hash_redacted>. Verified HTTPS: ${resetUrl.startsWith("https://")}`
    );

    // Stage 6 & 7: Outbound Email Dispatch (Resend HTTPS / SMTP)
    console.log(
      `[SAFE_DIAGNOSTIC] Stage 6 & 7: Dispatching password reset email to masked recipient ${maskEmail(recipientEmail)}.`
    );
    const emailResult = await sendPasswordResetEmail({
      to: recipientEmail,
      name: user.name,
      resetUrl,
      expiresInMinutes,
    });

    const isConfigured = isEmailConfigured();
    const activeProvider = getEmailProvider();

    // Stage 8: Delivery Confirmation & Distinction
    console.log(
      `[SAFE_DIAGNOSTIC] Stage 8: Email dispatch result: provider=${emailResult.provider || activeProvider}, accepted=${Boolean(emailResult.accepted || emailResult.providerAccepted || emailResult.smtpAccepted)}, delivered=${Boolean(emailResult.delivered)}, reason=${emailResult.reason}. (Note: Provider acceptance confirms upstream dispatch; inbox delivery depends on recipient spam filters/DNS).`
    );

    const isProdEnv =
      process.env.NODE_ENV === "production" ||
      process.env.RENDER === "true" ||
      Boolean(process.env.RENDER_SERVICE_ID) ||
      Boolean(process.env.RENDER_INSTANCE_ID);

    return res.status(200).json({
      ...genericResponse,
      emailDelivery: {
        configured: isConfigured,
        accepted: Boolean(emailResult.accepted || emailResult.providerAccepted || emailResult.smtpAccepted),
        delivered: Boolean(emailResult.delivered),
        provider: emailResult.provider || activeProvider,
        reason: emailResult.reason || (emailResult.accepted ? "ACCEPTED" : "FAILED"),
        messageId: emailResult.messageId || undefined,
        smtpAccepted: Boolean(emailResult.smtpAccepted),
        inboxDeliveryGuaranteed: Boolean(emailResult.inboxDeliveryGuaranteed),
      },
      // In local development only (when not in production and email unconfigured or not accepted), supply devResetUrl
      ...(!isProdEnv && !emailResult.delivered && !emailResult.accepted
        ? { devResetUrl: resetUrl }
        : {}),
    });
  } finally {
    inFlightPasswordResets.delete(normalizedEmail);
  }
} catch (error) {
  console.error("[SAFE_DIAGNOSTIC] Forgot Password Error:", error.message);
  return res.status(500).json({
    success: false,
    message: "An internal server error occurred while processing your request.",
  });
}
};

// ==========================================
// Validate Reset Token
// GET /api/auth/reset-password/:token
// ==========================================
const validateResetToken = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database service is temporarily unavailable. Please retry shortly.",
      });
    }

    const { token } = req.params;

    if (!token || typeof token !== "string" || token.length < 16) {
      return res.status(400).json({
        success: false,
        message: "Password reset link is invalid or malformed.",
      });
    }

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Password reset link is invalid, expired, or has already been used.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Password reset token is valid.",
    });
  } catch (error) {
    console.error("[SAFE_DIAGNOSTIC] Validate Reset Token Error:", error.message);
    return res.status(500).json({
      success: false,
      message: "An error occurred while validating the reset token.",
    });
  }
};

// ==========================================
// Reset Password
// POST /api/auth/reset-password/:token
// ==========================================
const resetPassword = async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        success: false,
        message: "Database service is temporarily unavailable. Please retry shortly.",
      });
    }

    const { token } = req.params;
    const { password } = req.body;

    if (!token || typeof token !== "string") {
      return res.status(400).json({
        success: false,
        message: "Reset token is required.",
      });
    }

    if (!password || typeof password !== "string" || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 6 characters long.",
      });
    }

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Password reset token is invalid, expired, or has already been used.",
      });
    }

    // Hash new password using bcrypt
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    user.password = hashedPassword;
    // Invalidate single-use token immediately
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    // Revoke all existing sessions across devices on password reset
    user.tokenVersion = (user.tokenVersion || 0) + 1;

    await user.save();

    recordAuditEvent({
      eventType: "AUTH_PASSWORD_RESET_SUCCESS",
      actor: user,
      action: "Password reset completed successfully",
      outcome: "success",
      req,
    });

    createNotification({
      userId: user._id,
      title: "Security Alert: Password Changed",
      message: "Your Vaidyasthana account password was successfully updated.",
      type: "security_event",
      link: "/",
    }).catch((e) => console.error("Reset pass notify error:", e.message));

    console.log(`[SAFE_DIAGNOSTIC] Password reset successfully completed for user ${user._id} (${user.role}).`);

    return res.status(200).json({
      success: true,
      message: "Your password has been reset successfully. You can now sign in with your new credentials.",
    });
  } catch (error) {
    console.error("[SAFE_DIAGNOSTIC] Reset Password Error:", error.message);
    return res.status(500).json({
      success: false,
      message: "An error occurred while resetting your password. Please try again.",
    });
  }
};

// ==========================================
// Phone OTP: Request OTP
// POST /api/auth/otp/send
// ==========================================
const requestPhoneOtp = async (req, res) => {
  try {
    const { phoneNumber, purpose = "login" } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        message: "Mobile phone number is required.",
      });
    }

    const result = await sendPhoneOtp({ phoneNumber, purpose });
    if (!result.success) {
      return res.status(result.rateLimited ? 429 : 400).json(result);
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error("Request Phone OTP Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to send verification code. Please try again.",
    });
  }
};

// ==========================================
// Phone OTP: Verify and Authenticate
// POST /api/auth/otp/verify
// ==========================================
const verifyPhoneOtpAndLogin = async (req, res) => {
  try {
    const { phoneNumber, otp, purpose = "login" } = req.body;

    if (!phoneNumber || !otp) {
      return res.status(400).json({
        success: false,
        message: "Both mobile phone number and 6-digit verification code are required.",
      });
    }

    const verification = await verifyPhoneOtp({ phoneNumber, otp, purpose });
    if (!verification.valid) {
      return res.status(verification.locked ? 429 : 400).json(verification);
    }

    const cleanedPhone = verification.phoneNumber;
    const user = await User.findOne({ phoneNumber: cleanedPhone });

    if (!user) {
      return res.status(200).json({
        success: true,
        isNewUser: true,
        phoneNumber: cleanedPhone,
        message: "Phone number verified. Please register your account.",
      });
    }

    if (user.status === "suspended") {
      return res.status(403).json({
        success: false,
        code: "ACCOUNT_SUSPENDED",
        message: "Your account has been suspended. Please contact platform administration.",
      });
    }

    if (user.twoFactorEnabled) {
      const tempToken = generate2FaTempToken(user);
      return res.status(200).json({
        success: true,
        twoFactorRequired: true,
        tempToken,
        message: "Two-factor authentication code required. Please enter code from your authenticator app.",
      });
    }

    const token = generateToken(user);

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    recordAuditEvent({
      eventType: "AUTH_PHONE_LOGIN_SUCCESS",
      actor: user,
      action: `${user.role} logged in successfully via Phone OTP`,
      outcome: "success",
      req,
    });

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        _id: user._id,
        name: user.name,
        email: user.email,
        phoneNumber: user.phoneNumber,
        address: user.address,
        city: user.city,
        state: user.state,
        postalCode: user.postalCode,
        role: user.role,
        status: user.status || "active",
        specialization: user.specialization,
        qualifications: user.qualifications,
        profilePhoto: user.profilePhoto || "",
        languagesSpoken: user.languagesSpoken || [],
        hospitalId: user.hospitalId || null,
        twoFactorEnabled: Boolean(user.twoFactorEnabled),
        verificationStatus: user.verificationStatus,
        profileComplete: Boolean(user.phoneNumber && user.address),
      },
    });
  } catch (error) {
    console.error("Verify Phone OTP Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during phone verification.",
    });
  }
};

// ==========================================
// Logout from Current Device
// POST /api/auth/logout
// ==========================================
const logoutUser = async (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });
  return res.status(200).json({
    success: true,
    message: "Logged out successfully from this device.",
  });
};

// ==========================================
// Logout from All Devices (Token Revocation)
// POST /api/auth/logout-all
// ==========================================
const logoutAllDevices = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User account not found.",
      });
    }

    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    res.clearCookie("token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    });

    recordAuditEvent({
      eventType: "AUTH_LOGOUT_ALL_DEVICES",
      actor: user,
      action: "Revoked all active sessions across devices",
      outcome: "success",
      req,
    });

    return res.status(200).json({
      success: true,
      message: "All active sessions have been invalidated across all devices.",
    });
  } catch (error) {
    console.error("Logout All Devices Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to invalidate sessions across devices.",
    });
  }
};

// ==========================================
// Setup 2FA (Generate Secret & Recovery Codes)
// POST /api/auth/2fa/setup
// ==========================================
const setupTwoFactorAuth = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("+twoFactorSecret +twoFactorRecoveryCodes");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const { secret, otpauthUrl, recoveryCodes, hashedRecoveryCodes } = setupTwoFactor(user.email);

    user.twoFactorSecret = secret;
    user.twoFactorRecoveryCodes = hashedRecoveryCodes;
    // Remains disabled until user verifies initial code
    await user.save();

    return res.status(200).json({
      success: true,
      secret,
      otpauthUrl,
      recoveryCodes,
      message: "Two-factor secret generated. Please verify with a code from your authenticator app to enable.",
    });
  } catch (error) {
    console.error("Setup 2FA Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to setup two-factor authentication.",
    });
  }
};

// ==========================================
// Enable 2FA (Verify First Code)
// POST /api/auth/2fa/enable
// ==========================================
const enableTwoFactorAuth = async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({
        success: false,
        message: "Verification code from your authenticator app is required.",
      });
    }

    const user = await User.findById(req.user.id).select("+twoFactorSecret +twoFactorRecoveryCodes");
    if (!user || !user.twoFactorSecret) {
      return res.status(400).json({
        success: false,
        message: "Please initiate 2FA setup first before enabling.",
      });
    }

    const isValid = verifyTotpCode(user.twoFactorSecret, code);
    if (!isValid) {
      return res.status(400).json({
        success: false,
        message: "Invalid authenticator code. Please check your clock and code, then try again.",
      });
    }

    user.twoFactorEnabled = true;
    await user.save();

    recordAuditEvent({
      eventType: "AUTH_2FA_ENABLED",
      actor: user,
      action: "Two-Factor Authentication enabled",
      outcome: "success",
      req,
    });

    return res.status(200).json({
      success: true,
      message: "Two-factor authentication has been successfully activated.",
      twoFactorEnabled: true,
    });
  } catch (error) {
    console.error("Enable 2FA Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to enable two-factor authentication.",
    });
  }
};

// ==========================================
// Disable 2FA
// POST /api/auth/2fa/disable
// ==========================================
const disableTwoFactorAuth = async (req, res) => {
  try {
    const { password, code } = req.body;

    const user = await User.findById(req.user.id).select("+password +twoFactorSecret");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    let verified = false;
    if (password) {
      verified = await bcrypt.compare(password, user.password);
    } else if (code && user.twoFactorSecret) {
      verified = verifyTotpCode(user.twoFactorSecret, code);
    }

    if (!verified) {
      return res.status(400).json({
        success: false,
        message: "Invalid password or verification code. Cannot disable 2FA.",
      });
    }

    user.twoFactorEnabled = false;
    user.twoFactorSecret = null;
    user.twoFactorRecoveryCodes = [];
    await user.save();

    recordAuditEvent({
      eventType: "AUTH_2FA_DISABLED",
      actor: user,
      action: "Two-Factor Authentication disabled",
      outcome: "success",
      req,
    });

    return res.status(200).json({
      success: true,
      message: "Two-factor authentication has been disabled.",
      twoFactorEnabled: false,
    });
  } catch (error) {
    console.error("Disable 2FA Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to disable two-factor authentication.",
    });
  }
};

// ==========================================
// Verify 2FA Login Challenge
// POST /api/auth/2fa/verify
// ==========================================
const verifyTwoFactorLogin = async (req, res) => {
  try {
    const { tempToken, code, recoveryCode } = req.body;

    if (!tempToken) {
      return res.status(400).json({
        success: false,
        message: "Temporary authentication token is required.",
      });
    }

    if (!code && !recoveryCode) {
      return res.status(400).json({
        success: false,
        message: "Please enter your 6-digit authenticator code or emergency recovery code.",
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(tempToken, getJwtSecret());
    } catch (jwtErr) {
      return res.status(401).json({
        success: false,
        message: "2FA session has expired. Please log in again.",
      });
    }

    if (decoded.type !== "2fa_pending" || !decoded.id) {
      return res.status(400).json({
        success: false,
        message: "Invalid 2FA token type.",
      });
    }

    const user = await User.findById(decoded.id).select("+twoFactorSecret +twoFactorRecoveryCodes");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    let isAuthorized = false;

    if (code && user.twoFactorSecret) {
      isAuthorized = verifyTotpCode(user.twoFactorSecret, code);
    }

    if (!isAuthorized && recoveryCode) {
      isAuthorized = await consumeRecoveryCode(user, recoveryCode);
    }

    if (!isAuthorized) {
      return res.status(401).json({
        success: false,
        message: "Invalid authenticator code or recovery code. Please check and try again.",
      });
    }

    const token = generateToken(user);

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    recordAuditEvent({
      eventType: "AUTH_2FA_LOGIN_SUCCESS",
      actor: user,
      action: `${user.role} logged in via 2FA`,
      outcome: "success",
      req,
    });

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        _id: user._id,
        name: user.name,
        email: user.email,
        phoneNumber: user.phoneNumber,
        address: user.address,
        city: user.city,
        state: user.state,
        postalCode: user.postalCode,
        role: user.role,
        status: user.status || "active",
        specialization: user.specialization,
        qualifications: user.qualifications,
        profilePhoto: user.profilePhoto || "",
        languagesSpoken: user.languagesSpoken || [],
        hospitalId: user.hospitalId || null,
        twoFactorEnabled: true,
        verificationStatus: user.verificationStatus,
        profileComplete: Boolean(user.phoneNumber && user.address),
      },
    });
  } catch (error) {
    console.error("Verify 2FA Login Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during 2FA verification.",
    });
  }
};

// ==========================================
// Update Doctor Profile (Specific credentials & attributes)
// PUT /api/auth/doctor-profile
// ==========================================
const updateDoctorProfile = async (req, res) => {
  try {
    if (!isDbConnected() && process.env.NODE_ENV !== "test") {
      return res.status(503).json({
        success: false,
        message: "Database connection is unavailable.",
      });
    }

    const targetDoctorId =
      (req.user.role === "admin" || req.user.role === "superadmin" || req.user.role === "hospital_admin") && req.body.doctorId
        ? req.body.doctorId
        : req.user.id;

    const doctor = await User.findOne({
      _id: targetDoctorId,
      role: "doctor",
    });

    if (!doctor) {
      return res.status(404).json({
        success: false,
        message: "Doctor profile not found.",
      });
    }

    const {
      profilePhoto,
      specialization,
      qualifications,
      medicalRegistrationNumber,
      experienceYears,
      languagesSpoken,
      consultationFee,
    } = req.body;

    if (profilePhoto !== undefined) doctor.profilePhoto = String(profilePhoto).trim();
    if (specialization) doctor.specialization = specialization.trim();
    if (qualifications) doctor.qualifications = qualifications.trim();
    if (medicalRegistrationNumber) doctor.medicalRegistrationNumber = medicalRegistrationNumber.trim();

    if (experienceYears !== undefined) {
      const expNum = Number(experienceYears);
      if (isNaN(expNum) || expNum < 0 || expNum > 70) {
        return res.status(400).json({
          success: false,
          message: "Experience years must be a valid number between 0 and 70.",
        });
      }
      doctor.experienceYears = expNum;
    }

    if (consultationFee !== undefined) {
      const feeNum = Number(consultationFee);
      if (isNaN(feeNum) || feeNum < 0 || feeNum > 100000) {
        return res.status(400).json({
          success: false,
          message: "Consultation fee must be a valid non-negative amount.",
        });
      }
      doctor.consultationFee = feeNum;
    }

    if (languagesSpoken !== undefined) {
      if (!Array.isArray(languagesSpoken)) {
        return res.status(400).json({
          success: false,
          message: "languagesSpoken must be an array of strings.",
        });
      }
      doctor.languagesSpoken = languagesSpoken.map((s) => String(s).trim()).filter(Boolean);
    }

    await doctor.save();

    return res.status(200).json({
      success: true,
      message: "Doctor profile updated successfully.",
      doctor: {
        id: doctor._id,
        _id: doctor._id,
        name: doctor.name,
        email: doctor.email,
        specialization: doctor.specialization,
        qualifications: doctor.qualifications,
        medicalRegistrationNumber: doctor.medicalRegistrationNumber,
        experienceYears: doctor.experienceYears,
        languagesSpoken: doctor.languagesSpoken,
        consultationFee: doctor.consultationFee,
        profilePhoto: doctor.profilePhoto,
        verificationStatus: doctor.verificationStatus,
      },
    });
  } catch (error) {
    console.error("Update Doctor Profile Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update doctor profile.",
    });
  }
};

// ==========================================
// Validate Hospital Invitation Token
// GET /api/auth/invitation/:token
// ==========================================
const validateInvitationToken = async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) {
      return res.status(400).json({
        success: false,
        message: "Invitation token is required.",
      });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const invitation = await HospitalInvitation.findOne({
      tokenHash,
      status: "pending",
      expiresAt: { $gt: new Date() },
    }).populate("hospitalId", "name hospitalCode timezone branding");

    if (!invitation) {
      return res.status(400).json({
        success: false,
        message: "This invitation link is invalid, expired, or has already been used.",
      });
    }

    return res.status(200).json({
      success: true,
      invitation: {
        id: invitation._id,
        email: invitation.email,
        name: invitation.name,
        role: invitation.role,
        hospital: invitation.hospitalId,
        expiresAt: invitation.expiresAt,
      },
    });
  } catch (error) {
    console.error("Validate Invitation Token Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error validating invitation token.",
    });
  }
};

// ==========================================
// Accept Hospital Invitation & Activate Staff Account
// POST /api/auth/accept-invitation
// ==========================================
const acceptInvitation = async (req, res) => {
  try {
    const { token, name, password, phoneNumber } = req.body;
    if (!token || !password) {
      return res.status(400).json({
        success: false,
        message: "Token and password are required.",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters.",
      });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const invitation = await HospitalInvitation.findOne({
      tokenHash,
      status: "pending",
      expiresAt: { $gt: new Date() },
    });

    if (!invitation) {
      return res.status(400).json({
        success: false,
        message: "This invitation link is invalid, expired, or has already been used.",
      });
    }

    // Check if user already exists
    let user = await User.findOne({ email: invitation.email.toLowerCase() });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    if (user) {
      user.password = hashedPassword;
      user.role = invitation.role;
      user.hospitalId = invitation.hospitalId;
      user.status = "active";
      if (name) user.name = name.trim();
      if (phoneNumber) user.phoneNumber = phoneNumber;
      await user.save();
    } else {
      user = await User.create({
        name: name ? name.trim() : invitation.name || "Hospital Staff",
        email: invitation.email.toLowerCase(),
        password: hashedPassword,
        phoneNumber: phoneNumber || "",
        role: invitation.role,
        hospitalId: invitation.hospitalId,
        status: "active",
      });
    }

    // Mark invitation accepted
    invitation.status = "accepted";
    invitation.acceptedAt = new Date();
    await invitation.save();

    const authToken = generateToken(user);

    res.cookie("token", authToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    recordAuditEvent({
      eventType: "INVITATION_ACCEPTED",
      actor: user,
      action: `User accepted invitation for role '${invitation.role}' at hospital ${invitation.hospitalId}`,
      outcome: "success",
      targetId: user._id,
      req,
    });

    return res.status(200).json({
      success: true,
      message: "Account activated successfully. Welcome to Vaidyasthana!",
      token: authToken,
      user: {
        id: user._id,
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        hospitalId: user.hospitalId,
        status: user.status,
      },
    });
  } catch (error) {
    console.error("Accept Invitation Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error accepting invitation.",
    });
  }
};

module.exports = {
  registerUser,
  loginUser,
  getProfile,
  updateProfile,
  forgotPassword,
  validateResetToken,
  resetPassword,
  requestPhoneOtp,
  verifyPhoneOtpAndLogin,
  logoutUser,
  logoutAllDevices,
  setupTwoFactorAuth,
  enableTwoFactorAuth,
  disableTwoFactorAuth,
  verifyTwoFactorLogin,
  updateDoctorProfile,
  validateInvitationToken,
  acceptInvitation,
  _resetRateLimits,
  getFrontendBaseUrl,
  DEPLOYED_FRONTEND_URL,
  isDbConnected,
  maskEmail,
  checkForgotPasswordRateLimit,
  sweepStaleRateLimits,
  pruneTimestamps,
  isRateLimited,
};
