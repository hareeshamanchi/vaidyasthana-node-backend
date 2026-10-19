const express = require("express");
const router = express.Router();
const translationController = require("../controllers/translationController");

// Public endpoints (no auth required for UI interface translation)
router.get("/languages", translationController.getSupportedLanguages);
router.post("/", translationController.translate);

module.exports = router;
