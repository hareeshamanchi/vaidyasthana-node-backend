const express = require("express");
const router = express.Router();

const {
  getDoctorsDirectory,
  getAvailableSlots,
  createAppointment,
  getAppointments,
  getAppointmentById,
  updateAppointment,
  deleteAppointment,
  getVideoAccess,
} = require("../controllers/appointmentController");

const { protect } = require("../middleware/authMiddleware");

// Doctor directory & slot availability endpoints (must precede /:id)
router.get("/doctors", getDoctorsDirectory);
router.get("/slots", getAvailableSlots);

// Protected appointment management endpoints
router.use(protect);

router.post("/", createAppointment);
router.get("/", getAppointments);
router.get("/:id", getAppointmentById);
router.get("/:id/video-access", getVideoAccess);
router.put("/:id", updateAppointment);
router.delete("/:id", deleteAppointment);

module.exports = router;
