const express = require("express");
const router = express.Router();

const {
  createInsurance,
  getInsuranceList,
  getInsuranceById,
  updateInsurance,
  deleteInsurance,
} = require("../controllers/insuranceController");

const { protect } = require("../middleware/authMiddleware");

router.use(protect);

router.post("/", createInsurance);
router.get("/", getInsuranceList);
router.get("/:id", getInsuranceById);
router.put("/:id", updateInsurance);
router.delete("/:id", deleteInsurance);

module.exports = router;
