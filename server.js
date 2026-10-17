require("dotenv").config();
const http = require("http");

const connectDB = require("./src/config/db");
const app = require("./src/app");
const { initSocket } = require("./src/config/socket");
const {
  startAppointmentExpiryCron,
  stopAppointmentExpiryCron,
} = require("./src/services/appointmentExpiryService");

connectDB();

const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

// Initialize real-time Socket.IO server
initSocket(server);

// Start automatic appointment status & consultation expiry worker
startAppointmentExpiryCron(60000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT} (0.0.0.0)`);
});

// Graceful shutdown handling
const handleShutdown = async (signal) => {
  console.log(`\n🛑 Received ${signal}. Commencing graceful server shutdown...`);
  server.close(async () => {
    console.log("✅ HTTP server closed.");
    try {
      stopAppointmentExpiryCron();
      const { disconnectDB } = require("./src/config/db");
      await disconnectDB();
    } catch (e) {
      console.error("Error during DB disconnect:", e.message);
    }
    process.exit(0);
  });

  // Force close after 10s if graceful shutdown hangs
  setTimeout(() => {
    console.error("⚠️ Forcing shutdown after timeout.");
    process.exit(1);
  }, 10000);
};

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));