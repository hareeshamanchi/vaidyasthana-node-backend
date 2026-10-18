const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const crypto = require("crypto");
const { isEmailConfigured, sendPasswordResetEmail } = require("../services/emailService");
const { createNotification } = require("../services/notificationService");
const { recordAuditEvent, extractIpAddress } = require("../services/auditService");

// Rate limiting map for password reset requests: key -> array of timestamps
const passwordResetAttempts = new Map();
// Rate limiting map for login requests: key -> array of timestamps
const loginAttempts = new Map();

const isRateLimited = (identifier, maxAttempts = 5, windowMs = 15 * 60 * 1000) => {
  const now = Date.now();
  const timestamps = passwordResetAttempts.get(identifier) || [];
  const validTimestamps = timestamps.filter((t) => now - t < windowMs);

  if (validTimestamps.length >= maxAttempts) {
    return true;
  }

  validTimestamps.push(now);
  passwordResetAttempts.set(identifier, validTimestamps);
  return false;
};

const isLoginRateLimited = (identifier, maxAttempts = 10, windowMs = 15 * 60 * 1000) => {
  const now = Date.now();
  const timestamps = loginAttempts.get(identifier) || [];
  const validTimestamps = timestamps.filter((t) => now - t < windowMs);

  if (validTimestamps.length >= maxAttempts) {
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

// Generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      role: user.role,
      name: user.name,
      email: user.email,
    },
    getJwtSecret(),
    {
      expiresIn: getJwtExpiresIn(),
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

    const isSuperOrAdmin = user.role === "superadmin" || user.role === "admin";
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

    // Doctor specific updates
    if (user.role === "doctor") {
      if (specialization) user.specialization = specialization.trim();
      if (qualifications) user.qualifications = qualifications.trim();
      if (medicalRegistrationNumber) user.medicalRegistrationNumber = medicalRegistrationNumber.trim();
      if (experienceYears !== undefined) user.experienceYears = Number(experienceYears) || user.experienceYears;
      if (consultationFee !== undefined) user.consultationFee = Number(consultationFee) || user.consultationFee;
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

  // If candidate is not explicitly set
  if (!candidate) {
    if (process.env.NODE_ENV === "production") {
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

  if (process.env.NODE_ENV === "production") {
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

    // Rate limiting guard (5 requests per 15 minutes by IP or Email)
    const clientIp = req.ip || req.headers["x-forwarded-for"] || "ip-unknown";
    if (isRateLimited(`ip:${clientIp}`) || isRateLimited(`email:${normalizedEmail}`)) {
      console.warn(`[SAFE_DIAGNOSTIC] Stage 1: Rate limit triggered for IP or email.`);
      return res.status(429).json({
        success: false,
        message: "Too many password reset requests. Please wait 15 minutes before trying again.",
      });
    }

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

    // Anti-enumeration generic response (consistent whether user exists or not)
    const genericResponse = {
      success: true,
      message: "If an account exists for this email, password reset instructions will be sent.",
    };

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
    const resetUrl = `${frontendBaseUrl}/reset-password/${rawToken}`;
    console.log(
      `[SAFE_DIAGNOSTIC] Stage 5: Reset URL generated using base origin: ${frontendBaseUrl}. Target route: /reset-password/<token_hash_redacted>. Verified HTTPS: ${resetUrl.startsWith("https://")}`
    );

    // Stage 6 & 7: SMTP Dispatch
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

    // Stage 8: Delivery Confirmation & Distinction
    console.log(
      `[SAFE_DIAGNOSTIC] Stage 8: Email dispatch result: delivered=${emailResult.delivered}, reason=${emailResult.reason}. (Note: SMTP acceptance confirms upstream relay handoff; inbox delivery depends on recipient spam filters/DNS).`
    );

    return res.status(200).json({
      ...genericResponse,
      emailDelivery: {
        configured: isConfigured,
        delivered: Boolean(emailResult.delivered),
        reason: emailResult.reason || (emailResult.delivered ? "DELIVERED" : "FAILED"),
        smtpAccepted: Boolean(emailResult.smtpAccepted),
        inboxDeliveryGuaranteed: Boolean(emailResult.inboxDeliveryGuaranteed),
      },
      // In local development only (when NODE_ENV is development and email unconfigured), supply devResetUrl
      ...(process.env.NODE_ENV === "development" && !emailResult.delivered
        ? { devResetUrl: resetUrl }
        : {}),
    });
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

module.exports = {
  registerUser,
  loginUser,
  getProfile,
  updateProfile,
  forgotPassword,
  validateResetToken,
  resetPassword,
  _resetRateLimits,
  getFrontendBaseUrl,
  DEPLOYED_FRONTEND_URL,
  isDbConnected,
  maskEmail,
};
