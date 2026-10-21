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
      tokenVersion: decoded.tokenVersion || 0,
      hospitalId: decoded.hospitalId || null,
    };

    // Verify current identity, role, active status, and session tokenVersion directly in database
    if ((mongoose.connection.readyState === 1 || process.env.NODE_ENV === "test") && decoded.id) {
      try {
        const user = await User.findById(decoded.id).select(
          "_id name email role status suspensionHistory tokenVersion hospitalId"
        );

        if (!user) {
          return res.status(401).json({
            success: false,
            message: "User account associated with this session no longer exists.",
          });
        }

        // Enforce session revocation check (Logout-all-devices, password change, etc.)
        if (
          decoded.tokenVersion !== undefined &&
          user.tokenVersion !== undefined &&
          user.tokenVersion !== decoded.tokenVersion
        ) {
          recordAuditEvent({
            eventType: "AUTH_SESSION_REVOKED",
            actor: user,
            action: "Access attempted with revoked token version",
            outcome: "failure",
            reason: `Token version (${decoded.tokenVersion}) does not match current user version (${user.tokenVersion})`,
            req,
          });

          return res.status(401).json({
            success: false,
            code: "SESSION_REVOKED",
            message: "Your session has been invalidated or logged out. Please log in again.",
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
          tokenVersion: user.tokenVersion || 0,
          hospitalId: user.hospitalId || null,
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
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const userRole = req.user.role || "unknown";

    // Normalize role checks with backward-compatibility for admin <-> hospital_admin and superadmin inheritance
    const hasRole = roles.some((role) => {
      if (role === userRole) return true;
      if (role === "admin" && (userRole === "hospital_admin" || userRole === "superadmin")) return true;
      if (role === "hospital_admin" && (userRole === "admin" || userRole === "superadmin")) return true;
      return false;
    });

    if (!hasRole) {
      if (roles.includes("admin") || roles.includes("superadmin") || roles.includes("hospital_admin")) {
        recordAuditEvent({
          eventType: "UNAUTHORIZED_ADMIN_ATTEMPT",
          actor: req.user,
          action: "Unauthorized administrative access attempt",
          outcome: "failure",
          reason: `Role '${userRole}' is not authorized. Required: [${roles.join(", ")}]`,
          req,
        });
      }

      return res.status(403).json({
        success: false,
        message: `Forbidden: role '${userRole}' is not authorized to access this resource.`,
      });
    }
    next();
  };
};

/**
 * Multi-Hospital Scope Middleware: attaches hospital scope to request if user is scoped
 */
const enforceHospitalScope = (req, res, next) => {
  if (req.user && req.user.hospitalId) {
    req.hospitalScope = req.user.hospitalId;
  }
  next();
};

const { hasPermission } = require("../config/permissions");

/**
 * Super Admin / Platform Owner Middleware:
 * Strictly reserved for the Vaidyasthana SaaS platform operator.
 * Hospital Admins and legacy administrators are blocked from platform ownership.
 */
const requirePlatformOwner = (req, res, next) => {
  if (!req.user || req.user.role !== "superadmin") {
    recordAuditEvent({
      eventType: "UNAUTHORIZED_ADMIN_ATTEMPT",
      actor: req.user,
      action: "Platform Owner route access attempt",
      outcome: "failure",
      reason: `Role '${req.user?.role || "unknown"}' lacks platform owner privilege.`,
      req,
    });

    return res.status(403).json({
      success: false,
      message: "Forbidden: Dedicated Platform Owner (Super Administrator) access required.",
    });
  }
  next();
};

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

const requireStrictSuperAdmin = requirePlatformOwner;

/**
 * Hospital Admin Middleware:
 * Allows authorized administrators of a hospital.
 * Enforces that a non-superadmin hospital_admin must be bound to a valid hospitalId.
 */
const requireHospitalAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: "Authentication required.",
    });
  }

  const role = req.user.role;
  const isSuper = role === "superadmin";
  const isHospAdmin = role === "hospital_admin" || (role === "admin" && req.user.hospitalId);

  if (!isSuper && !isHospAdmin) {
    recordAuditEvent({
      eventType: "UNAUTHORIZED_HOSPITAL_ADMIN_ATTEMPT",
      actor: req.user,
      action: "Hospital administrator route access attempt",
      outcome: "failure",
      reason: `Role '${role}' is not a hospital administrator.`,
      req,
    });

    return res.status(403).json({
      success: false,
      message: "Forbidden: Hospital Administrator privilege required.",
    });
  }

  // If not superadmin, hospital admin MUST belong to a hospital
  if (!isSuper && !req.user.hospitalId) {
    return res.status(403).json({
      success: false,
      message: "Forbidden: Hospital administrator is not assigned to any hospital tenant.",
    });
  }

  next();
};

/**
 * Permission-Based Middleware:
 * Checks whether user's role grants specific permission in the central matrix.
 */
const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (!hasPermission(req.user.role, permission)) {
      recordAuditEvent({
        eventType: "UNAUTHORIZED_PERMISSION_ATTEMPT",
        actor: req.user,
        action: `Attempted action requiring '${permission}'`,
        outcome: "failure",
        reason: `Role '${req.user.role}' lacks permission '${permission}'`,
        req,
      });

      return res.status(403).json({
        success: false,
        message: `Forbidden: your role (${req.user.role}) does not have permission for '${permission}'.`,
      });
    }

    next();
  };
};

module.exports = {
  protect,
  authorizeRoles,
  requireSuperAdmin,
  requireStrictSuperAdmin,
  requirePlatformOwner,
  requireHospitalAdmin,
  requirePermission,
  enforceHospitalScope,
};
