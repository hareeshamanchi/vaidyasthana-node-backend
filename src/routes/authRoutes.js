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
} = require("../controllers/authController");

const { protect } = require("../middleware/authMiddleware");

router.post("/register", registerUser);
router.post("/login", loginUser);
router.get("/profile", protect, getProfile);
router.put("/profile", protect, updateProfile);

// Password Reset Routes (Unauthenticated, Secure Token Driven)
router.post("/forgot-password", forgotPassword);
router.get("/reset-password/:token", validateResetToken);
router.post("/reset-password/:token", resetPassword);

module.exports = router;