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
 * Safely extracts client IP address from reverse proxy headers, req.ip, or socket.
 * Handles Cloudflare, standard X-Forwarded-For, X-Real-IP, and strips IPv6-mapped IPv4 prefixes.
 */
const extractIpAddress = (req) => {
  if (!req) return "";
  
  // 1. Cloudflare connecting IP
  const cfConnecting = req.headers?.["cf-connecting-ip"];
  if (cfConnecting && typeof cfConnecting === "string" && cfConnecting.trim()) {
    return cfConnecting.trim().replace(/^::ffff:/, "");
  }

  // 2. Nginx / reverse proxy X-Real-IP
  const realIp = req.headers?.["x-real-ip"];
  if (realIp && typeof realIp === "string" && realIp.trim()) {
    return realIp.trim().replace(/^::ffff:/, "");
  }

  // 3. Standard X-Forwarded-For (client is the leftmost IP in the chain)
  const forwarded = req.headers?.["x-forwarded-for"];
  if (forwarded && typeof forwarded === "string" && forwarded.trim()) {
    const firstIp = forwarded.split(",")[0].trim();
    if (firstIp) {
      return firstIp.replace(/^::ffff:/, "");
    }
  }

  // 4. Express req.ip (populated when trust proxy is enabled) or raw socket remote address
  const rawIp = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || "";
  return typeof rawIp === "string" ? rawIp.replace(/^::ffff:/, "").trim() : "";
};

/**
 * Masks an IP address for safe diagnostics without leaking PII.
 * IPv4: '198.51.100.42' -> '198.51.***.***'
 * IPv6: '2001:db8:85a3::8a2e:370:7334' -> '2001:db8:****'
 */
const maskIp = (ip) => {
  if (!ip || typeof ip !== "string") return "[UNKNOWN_IP]";
  const cleanIp = ip.replace(/^::ffff:/, "").trim();
  if (cleanIp === "127.0.0.1" || cleanIp === "::1" || cleanIp === "localhost") {
    return "127.0.0.***";
  }
  if (cleanIp.includes(".")) {
    const parts = cleanIp.split(".");
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.***.***`;
    }
  } else if (cleanIp.includes(":")) {
    const parts = cleanIp.split(":");
    return `${parts.slice(0, 2).join(":")}:****`;
  }
  return cleanIp.length > 4 ? `${cleanIp.slice(0, 3)}***` : "***";
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
  maskIp,
};
