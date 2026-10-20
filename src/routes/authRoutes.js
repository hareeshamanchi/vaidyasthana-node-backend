const express = require("express");
const router = express.Router();

const {
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
} = require("../controllers/authController");

const {
  getFamilyMembers,
  createFamilyMember,
  updateFamilyMember,
  deleteFamilyMember,
} = require("../controllers/familyController");

const { protect, authorizeRoles } = require("../middleware/authMiddleware");

// Authentication Core Endpoints
router.post("/register", registerUser);
router.post("/login", loginUser);
router.post("/logout", logoutUser);
router.post("/logout-all", protect, logoutAllDevices);

// Phone OTP Authentication
router.post("/otp/send", requestPhoneOtp);
router.post("/otp/verify", verifyPhoneOtpAndLogin);

// Two-Factor Authentication (2FA)
router.post("/2fa/verify", verifyTwoFactorLogin);
router.post("/2fa/setup", protect, setupTwoFactorAuth);
router.post("/2fa/enable", protect, enableTwoFactorAuth);
router.post("/2fa/disable", protect, disableTwoFactorAuth);

// User & Doctor Profile Management
router.get("/profile", protect, getProfile);
router.put("/profile", protect, updateProfile);
router.put(
  "/doctor-profile",
  protect,
  authorizeRoles("doctor", "admin", "hospital_admin", "superadmin"),
  updateDoctorProfile
);

// Family Accounts Management
router.get("/family", protect, getFamilyMembers);
router.post("/family", protect, createFamilyMember);
router.put("/family/:id", protect, updateFamilyMember);
router.delete("/family/:id", protect, deleteFamilyMember);

// Password Reset Routes (Unauthenticated, Secure Token Driven)
router.post("/forgot-password", forgotPassword);
router.get("/reset-password/:token", validateResetToken);
router.post("/reset-password/:token", resetPassword);

// Google OAuth 2.0 Gmail Sender Integration
const googleOAuthRoutes = require("./googleOAuthRoutes");
router.use("/google", googleOAuthRoutes);

module.exports = router;