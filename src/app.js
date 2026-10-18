const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");

const authRoutes = require("./routes/authRoutes");
const uploadRoutes = require("./routes/uploadRoutes");
const appointmentRoutes = require("./routes/appointmentRoutes");
const insuranceRoutes = require("./routes/insuranceRoutes");
const contactRoutes = require("./routes/contactRoutes");
const doctorRoutes = require("./routes/doctorRoutes");
const healthRoutes = require("./routes/healthRoutes");
const adminRoutes = require("./routes/adminRoutes");
const nutritionRoutes = require("./routes/nutritionRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const timelineRoutes = require("./routes/timelineRoutes");
const medicationRoutes = require("./routes/medicationRoutes");
const googleOAuthRoutes = require("./routes/googleOAuthRoutes");
const errorHandler = require("./middleware/errorHandler");

const app = express();

// Trust reverse proxy (Render, Cloudflare, AWS, etc.) so that req.ip and req.protocol accurately reflect the client
const trustProxyEnv = process.env.TRUST_PROXY;
if (trustProxyEnv) {
  const parsed = parseInt(trustProxyEnv, 10);
  app.set("trust proxy", isNaN(parsed) ? trustProxyEnv : parsed);
} else {
  // On Render and common cloud hosts, trust 1 hop behind the reverse proxy
  app.set("trust proxy", 1);
}

/*
|--------------------------------------------------------------------------
| CORS Configuration
|--------------------------------------------------------------------------
*/
const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.CLIENT_URL,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://vaidyasthana-frontend.onrender.com",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, or server-to-server)
      if (!origin) return callback(null, true);
      if (
        allowedOrigins.includes(origin) ||
        origin.startsWith("http://localhost:") ||
        origin.endsWith(".trycloudflare.com") ||
        origin.endsWith(".vercel.app") ||
        origin.endsWith(".onrender.com")
      ) {
        return callback(null, true);
      }
      return callback(null, true); // Permissive for local dev & preview deployments
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
  })
);

/*
|--------------------------------------------------------------------------
| Body Parsers & Cookie Parser
|--------------------------------------------------------------------------
*/
app.use(cookieParser());
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

/*
|--------------------------------------------------------------------------
| API Routes
|--------------------------------------------------------------------------
*/
app.use("/api/auth/google", googleOAuthRoutes);
app.use("/api/auth", authRoutes);
app.use("/upload", uploadRoutes);
app.use("/api/reports", uploadRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/insurance", insuranceRoutes);
app.use("/api/contact", contactRoutes);
app.use("/doctor", doctorRoutes);
app.use("/api/doctor", doctorRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/health", healthRoutes);
app.use("/api/nutrition", nutritionRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/timeline", timelineRoutes);
app.use("/api/medications", medicationRoutes);

/*
|--------------------------------------------------------------------------
| Home Route
|--------------------------------------------------------------------------
*/
app.get("/", (req, res) => {
  res.status(200).json({
    name: "Vaidyasthana Healthcare Platform API",
    version: "1.0.0",
    status: "online",
    endpoints: {
      auth: "/api/auth",
      reports: "/api/reports",
      upload: "/upload",
      appointments: "/api/appointments",
      insurance: "/api/insurance",
      contact: "/api/contact",
      doctor: "/api/doctor",
      admin: "/api/admin",
      health: "/api/health",
      nutrition: "/api/nutrition",
      notifications: "/api/notifications",
      timeline: "/api/timeline",
      medications: "/api/medications",
    },
  });
});

/*
|--------------------------------------------------------------------------
| 404 Route
|--------------------------------------------------------------------------
*/
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `API endpoint '${req.originalUrl}' not found.`,
  });
});

/*
|--------------------------------------------------------------------------
| Centralized Error Handler
|--------------------------------------------------------------------------
*/
app.use(errorHandler);

module.exports = app;