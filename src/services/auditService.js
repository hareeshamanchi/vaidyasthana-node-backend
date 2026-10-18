const AuditLog = require("../models/AuditLog");
const mongoose = require("mongoose");

/**
 * Sanitizes details dictionary by stripping any sensitive keys, tokens,
 * passwords, or credentials before writing to the immutable audit log.
 */
const sanitizeAuditDetails = (details) => {
  if (!details || typeof details !== "object") return {};

  const sensitiveKeys = [
    "password",
    "token",
    "jwt",
    "authorization",
    "secret",
    "cookie",
    "apiKey",
    "resetPasswordToken",
    "ocrText",
    "aiAnalysis",
  ];

  const clean = {};
  for (const [key, value] of Object.entries(details)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some((s) => lowerKey.includes(s.toLowerCase()))) {
      clean[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      clean[key] = sanitizeAuditDetails(value);
    } else {
      clean[key] = value;
    }
  }
  return clean;
};

/**
 * Safely extracts client IP address from request headers or socket.
 */
const extractIpAddress = (req) => {
  if (!req) return "";
  const forwarded = req.headers?.["x-forwarded-for"];
  if (forwarded && typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || "";
};

/**
 * Records an immutable audit log entry.
 * Non-blocking: failures to log will not break primary application operations.
 */
const recordAuditEvent = async ({
  eventType,
  actor = null,
  actorId = null,
  actorRole = null,
  actorEmail = null,
  targetId = null,
  targetModel = null,
  action,
  outcome = "success",
  reason = "",
  details = {},
  req = null,
}) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      console.warn(`[AUDIT_LOG_SKIPPED] DB not connected for event: ${eventType}`);
      return null;
    }

    const resolvedActorId = actorId || actor?._id || actor?.id || null;
    const resolvedActorRole = actorRole || actor?.role || (req?.user?.role) || "anonymous";
    const resolvedActorEmail = actorEmail || actor?.email || (req?.user?.email) || "";
    const ipAddress = extractIpAddress(req);
    const userAgent = req?.headers?.["user-agent"] ? String(req.headers["user-agent"]).slice(0, 255) : "";

    const entry = await AuditLog.create({
      eventType,
      actorId: resolvedActorId,
      actorRole: resolvedActorRole,
      actorEmail: resolvedActorEmail,
      targetId: targetId ? String(targetId) : null,
      targetModel: targetModel || null,
      action,
      outcome,
      reason: reason || "",
      details: sanitizeAuditDetails(details),
      ipAddress,
      userAgent,
      timestamp: new Date(),
    });

    return entry;
  } catch (err) {
    console.error("[AUDIT_LOG_ERROR] Failed to record audit event:", err.message);
    return null;
  }
};

module.exports = {
  recordAuditEvent,
  sanitizeAuditDetails,
  extractIpAddress,
};
