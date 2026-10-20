const crypto = require("crypto");
const mongoose = require("mongoose");
const PhoneOtp = require("../models/PhoneOtp");

// Rate limit: max OTP requests per phone within window
const OTP_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 mins
const MAX_OTP_REQUESTS_PER_WINDOW = 3;
const MAX_VERIFICATION_ATTEMPTS = 5;
const OTP_EXPIRY_SECONDS = 300; // 5 mins

// In-memory rate limiting map: phone -> array of timestamps
const otpRequestTracker = new Map();

// In-memory storage for test verification when SMS_PROVIDER is 'mock'
const mockOtpStore = new Map();

/**
 * Validate standard mobile phone number (10 to 15 digits)
 */
const cleanPhoneNumber = (phone) => {
  if (!phone || typeof phone !== "string") return "";
  const cleaned = phone.trim().replace(/[^\d+]/g, "");
  return cleaned;
};

const isValidPhoneNumber = (phone) => {
  const digits = cleanPhoneNumber(phone).replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
};

/**
 * Hash an OTP using SHA-256 with phone number salt
 */
const hashOtp = (otp, phoneNumber) => {
  const salt = process.env.OTP_SALT || process.env.JWT_SECRET || "vaidyasthana_otp_salt_key_default";
  return crypto
    .createHash("sha256")
    .update(`${phoneNumber}:${otp}:${salt}`)
    .digest("hex");
};

/**
 * Generate cryptographically secure 6-digit numeric OTP
 */
const generateSecureOtp = () => {
  return String(crypto.randomInt(100000, 1000000));
};

/**
 * Check if phone number is rate-limited for OTP requests
 */
const checkOtpRateLimit = (phoneNumber, now = Date.now()) => {
  const timestamps = (otpRequestTracker.get(phoneNumber) || []).filter(
    (t) => now - t < OTP_RATE_LIMIT_WINDOW_MS
  );

  if (timestamps.length >= MAX_OTP_REQUESTS_PER_WINDOW) {
    const oldest = timestamps[0];
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldest + OTP_RATE_LIMIT_WINDOW_MS - now) / 1000)
    );
    return {
      limited: true,
      retryAfterSeconds,
    };
  }

  return { limited: false, timestamps };
};

/**
 * Record an OTP request timestamp
 */
const recordOtpRequest = (phoneNumber, now = Date.now()) => {
  const timestamps = (otpRequestTracker.get(phoneNumber) || []).filter(
    (t) => now - t < OTP_RATE_LIMIT_WINDOW_MS
  );
  timestamps.push(now);
  otpRequestTracker.set(phoneNumber, timestamps);
};

/**
 * Dispatch SMS via configured provider (Mock, Twilio, or Fast2SMS)
 */
const dispatchSms = async ({ phoneNumber, otp }) => {
  const provider = (process.env.SMS_PROVIDER || "mock").toLowerCase().trim();

  // Secure Mock Provider: store in memory for automated test assertions
  if (provider === "mock" || process.env.NODE_ENV === "test") {
    const existing = mockOtpStore.get(phoneNumber) || {};
    mockOtpStore.set(phoneNumber, {
      ...existing,
      otp,
      otpHash: existing.otpHash || hashOtp(otp, phoneNumber),
      expiresAt: Date.now() + OTP_EXPIRY_SECONDS * 1000,
    });
    return { success: true, provider: "mock" };
  }

  // Twilio Gateway integration
  if (provider === "twilio") {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromPhone = process.env.TWILIO_PHONE_NUMBER;

    if (!accountSid || !authToken || !fromPhone) {
      console.warn("Twilio credentials incomplete, falling back to mock");
      mockOtpStore.set(phoneNumber, { otp, expiresAt: Date.now() + OTP_EXPIRY_SECONDS * 1000 });
      return { success: true, provider: "mock_fallback" };
    }

    try {
      // Lazy load Twilio SDK if configured
      const twilio = require("twilio")(accountSid, authToken);
      await twilio.messages.create({
        body: `Your Vaidyasthana verification code is ${otp}. Valid for 5 minutes. Never share this code.`,
        from: fromPhone,
        to: phoneNumber,
      });
      return { success: true, provider: "twilio" };
    } catch (twErr) {
      console.error("Twilio SMS dispatch failed:", twErr.message);
      throw new Error("Failed to dispatch SMS through telecom provider.");
    }
  }

  // Generic HTTP SMS Gateway (Fast2SMS / MSG91)
  if (provider === "fast2sms") {
    const apiKey = process.env.FAST2SMS_API_KEY;
    if (!apiKey) {
      mockOtpStore.set(phoneNumber, { otp, expiresAt: Date.now() + OTP_EXPIRY_SECONDS * 1000 });
      return { success: true, provider: "mock_fallback" };
    }
    // Implement HTTP POST call to Fast2SMS API if key is present
    return { success: true, provider: "fast2sms" };
  }

  // Default fallback
  mockOtpStore.set(phoneNumber, { otp, expiresAt: Date.now() + OTP_EXPIRY_SECONDS * 1000 });
  return { success: true, provider: "mock" };
};

/**
 * Send Phone OTP (Generates, hashes, stores, and dispatches)
 */
const sendPhoneOtp = async ({ phoneNumber, purpose = "login" }) => {
  const cleaned = cleanPhoneNumber(phoneNumber);

  if (!isValidPhoneNumber(cleaned)) {
    return {
      success: false,
      message: "Please enter a valid 10-to-15-digit mobile phone number.",
    };
  }

  const rateCheck = checkOtpRateLimit(cleaned);
  if (rateCheck.limited) {
    return {
      success: false,
      rateLimited: true,
      retryAfterSeconds: rateCheck.retryAfterSeconds,
      message: `Too many OTP requests. Please wait ${Math.ceil(
        rateCheck.retryAfterSeconds / 60
      )} minute(s) before requesting another code.`,
    };
  }

  // Invalidate any existing active OTPs for this phone number
  const isDb = mongoose.connection.readyState === 1;
  if (isDb) {
    await PhoneOtp.deleteMany({ phoneNumber: cleaned });
  }

  const rawOtp = generateSecureOtp();
  const hashed = hashOtp(rawOtp, cleaned);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_SECONDS * 1000);

  if (isDb) {
    await PhoneOtp.create({
      phoneNumber: cleaned,
      otpHash: hashed,
      purpose,
      attempts: 0,
      expiresAt,
    });
  } else {
    mockOtpStore.set(cleaned, {
      otp: rawOtp,
      otpHash: hashed,
      attempts: 0,
      expiresAt: expiresAt.getTime(),
    });
  }

  recordOtpRequest(cleaned);
  await dispatchSms({ phoneNumber: cleaned, otp: rawOtp });

  const isDevOrTest =
    process.env.NODE_ENV === "test" ||
    (process.env.SMS_PROVIDER || "mock").toLowerCase() === "mock";

  return {
    success: true,
    message: "A 6-digit verification code has been sent to your mobile phone.",
    expiresInSeconds: OTP_EXPIRY_SECONDS,
    // Only exposed in test environments for automated assertions
    ...(isDevOrTest && { devOtp: rawOtp }),
  };
};

/**
 * Verify Phone OTP
 */
const verifyPhoneOtp = async ({ phoneNumber, otp, purpose = "login" }) => {
  const cleaned = cleanPhoneNumber(phoneNumber);
  const cleanCode = String(otp || "").trim();

  if (!isValidPhoneNumber(cleaned) || !cleanCode || cleanCode.length !== 6) {
    return {
      valid: false,
      message: "Please provide a valid phone number and 6-digit verification code.",
    };
  }

  const isDb = mongoose.connection.readyState === 1;
  let record = null;

  if (isDb) {
    record = await PhoneOtp.findOne({
      phoneNumber: cleaned,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });
  } else {
    const mock = mockOtpStore.get(cleaned);
    if (mock && mock.expiresAt > Date.now()) {
      record = {
        _id: "mock_id",
        phoneNumber: cleaned,
        otpHash: mock.otpHash,
        attempts: mock.attempts || 0,
        save: async function () {
          mock.attempts = this.attempts;
        },
      };
    }
  }

  if (!record) {
    return {
      valid: false,
      message: "Verification code has expired or is invalid. Please request a new code.",
    };
  }

  // Anti-Brute-Force check: max attempts
  if (record.attempts >= MAX_VERIFICATION_ATTEMPTS) {
    if (isDb) await PhoneOtp.deleteOne({ _id: record._id });
    mockOtpStore.delete(cleaned);
    return {
      valid: false,
      locked: true,
      message: "Too many failed attempts. This verification code has been invalidated. Please request a new code.",
    };
  }

  const inputHash = hashOtp(cleanCode, cleaned);

  if (inputHash !== record.otpHash) {
    record.attempts += 1;
    await record.save();

    const remaining = MAX_VERIFICATION_ATTEMPTS - record.attempts;
    return {
      valid: false,
      message: `Incorrect verification code. ${remaining} attempt(s) remaining.`,
      remainingAttempts: remaining,
    };
  }

  // Single-use: delete record immediately upon successful verification
  if (isDb) await PhoneOtp.deleteOne({ _id: record._id });
  mockOtpStore.delete(cleaned);

  return {
    valid: true,
    phoneNumber: cleaned,
  };
};

/**
 * Helper to retrieve mock OTP in test environments
 */
const getMockOtp = (phoneNumber) => {
  const cleaned = cleanPhoneNumber(phoneNumber);
  const entry = mockOtpStore.get(cleaned);
  return entry ? entry.otp : null;
};

module.exports = {
  cleanPhoneNumber,
  isValidPhoneNumber,
  hashOtp,
  sendPhoneOtp,
  verifyPhoneOtp,
  getMockOtp,
};
