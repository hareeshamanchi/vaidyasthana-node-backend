const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/User");

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
    const jwtSecret = process.env.JWT_SECRET || "vaidyasthana_development_jwt_secret_key_32bytes";
    const decoded = jwt.verify(token, jwtSecret);

    // Attach basic decoded token info
    req.user = {
      id: decoded.id,
      role: decoded.role || "patient",
      name: decoded.name || "",
      email: decoded.email || "",
    };

    // Optionally attach full user from database if available
    if (mongoose.connection.readyState === 1) {
      try {
        const user = await User.findById(decoded.id).select("-password");
        if (user) {
          req.user = {
            id: user._id.toString(),
            _id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
          };
        }
      } catch (dbErr) {
        // In case DB lookup fails, continue with decoded token payload
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
      return res.status(403).json({
        success: false,
        message: `Forbidden: role '${req.user?.role || "unknown"}' is not authorized to access this resource.`,
      });
    }
    next();
  };
};

module.exports = {
  protect,
  authorizeRoles,
};
