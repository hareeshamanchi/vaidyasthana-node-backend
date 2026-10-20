const express = require("express");
const router = express.Router();
const {
  getHospitalOverview,
  getStaffMembers,
  createStaffMember,
  inviteStaffMember,
  updateStaffMember,
  updateStaffStatus,
  registerHospitalPatient,
  getHospitalPatients,
  updateHospitalSettings,
  revokeInvitation,
} = require("../controllers/hospitalAdminController");
const {
  protect,
  requireHospitalAdmin,
} = require("../middleware/authMiddleware");

// All Hospital Admin routes require authentication and Hospital Admin or Superadmin authorization
router.use(protect);
router.use(requireHospitalAdmin);

router.get("/overview", getHospitalOverview);
router.get("/staff", getStaffMembers);
router.post("/staff", createStaffMember);
router.post("/invite", inviteStaffMember);
router.put("/staff/:id", updateStaffMember);
router.patch("/staff/:id/status", updateStaffStatus);
router.post("/patients", registerHospitalPatient);
router.get("/patients", getHospitalPatients);
router.put("/settings", updateHospitalSettings);
router.delete("/invitations/:id", revokeInvitation);

module.exports = router;
