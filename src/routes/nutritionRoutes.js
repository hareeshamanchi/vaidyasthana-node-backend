const express = require("express");
const router = express.Router();
const {
  getNutritionServiceStatus,
  generateNutrition,
} = require("../controllers/nutritionController");
const { protect } = require("../middleware/authMiddleware");

// Public service health/status check
router.get("/status", getNutritionServiceStatus);

// Generate nutrition plan (optional authentication to link with user lab reports)
router.post("/generate", (req, res, next) => {
  // If authorization header is present, run protect, otherwise proceed as guest
  if (req.headers.authorization) {
    return protect(req, res, next);
  }
  next();
}, generateNutrition);

module.exports = router;
