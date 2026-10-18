const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/User");
const { recordAuditEvent } = require("../services/auditService");

const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer ")
  ) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authentication required. No token provided.",
    });
  }

  try {
    const jwtSecret =
      process.env.JWT_SECRET || "vaidyasthana_development_jwt_secret_key_32bytes";
    const decoded = jwt.verify(token, jwtSecret);

    // Initial decoded token payload
    req.user = {
      id: decoded.id,
      _id: decoded.id,
      role: decoded.role || "patient",
      name: decoded.name || "",
      email: decoded.email || "",
      status: "active",
    };

    // Verify current identity, role, and active status directly in database
    if (mongoose.connection.readyState === 1 && decoded.id) {
      try {
        const user = await User.findById(decoded.id).select(
          "_id name email role status suspensionHistory"
        );

        if (!user) {
          return res.status(401).json({
            success: false,
            message: "User account associated with this session no longer exists.",
          });
        }

        // Enforce account suspension check across all protected endpoints
        if (user.status === "suspended") {
          recordAuditEvent({
            eventType: "AUTH_SUSPENDED_ACCESS_ATTEMPT",
            actor: user,
            action: "Suspended user attempted protected resource access",
            outcome: "failure",
            reason: "Account is suspended",
            req,
          });

          return res.status(403).json({
            success: false,
            code: "ACCOUNT_SUSPENDED",
            message:
              "Your account has been suspended. Please contact platform administration.",
          });
        }

        req.user = {
          id: user._id.toString(),
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          status: user.status || "active",
        };
      } catch (dbErr) {
        // Continue with decoded token payload if DB lookup encounters transient issue
      }
    }

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired session token. Please log in again.",
    });
  }
};

const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      const attemptedRole = req.user?.role || "unknown";

      if (roles.includes("admin") || roles.includes("superadmin")) {
        recordAuditEvent({
          eventType: "UNAUTHORIZED_ADMIN_ATTEMPT",
          actor: req.user,
          action: "Unauthorized administrative access attempt",
          outcome: "failure",
          reason: `Role '${attemptedRole}' is not authorized. Required: [${roles.join(", ")}]`,
          req,
        });
      }

      return res.status(403).json({
        success: false,
        message: `Forbidden: role '${attemptedRole}' is not authorized to access this resource.`,
      });
    }
    next();
  };
};

/**
 * Super Admin Middleware: allows 'superadmin' and 'admin' roles by default
 */
const requireSuperAdmin = (req, res, next) => {
  if (!req.user || (req.user.role !== "superadmin" && req.user.role !== "admin")) {
    recordAuditEvent({
      eventType: "UNAUTHORIZED_ADMIN_ATTEMPT",
      actor: req.user,
      action: "Superadmin route access attempt",
      outcome: "failure",
      reason: `Role '${req.user?.role || "unknown"}' lacks administrative privilege.`,
      req,
    });

    return res.status(403).json({
      success: false,
      message: "Forbidden: Super Administrator access required.",
    });
  }
  next();
};

/**
 * Strict Super Admin Middleware: allows ONLY the highest-privilege 'superadmin' role
 */
const requireStrictSuperAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "superadmin") {
    recordAuditEvent({
      eventType: "UNAUTHORIZED_ADMIN_ATTEMPT",
      actor: req.user,
      action: "Strict superadmin action attempt",
      outcome: "failure",
      reason: `Role '${req.user?.role || "unknown"}' is not superadmin.`,
      req,
    });

    return res.status(403).json({
      success: false,
      message: "Forbidden: Dedicated Super Administrator role required for this sensitive action.",
    });
  }
  next();
};

module.exports = {
  protect,
  authorizeRoles,
  requireSuperAdmin,
  requireStrictSuperAdmin,
};
