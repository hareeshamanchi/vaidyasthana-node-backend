const mongoose = require("mongoose");
const dns = require("dns");

// Configure resilient public DNS servers only on Windows to prevent c-ares ECONNREFUSED during SRV resolution
if (process.platform === "win32") {
  try {
    dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
  } catch (dnsErr) {
    // If environment restricts setServers, continue with default resolver
  }
}

let isConnecting = false;

const connectDB = async () => {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }
  if (isConnecting) {
    return null;
  }

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;

  if (!uri) {
    console.warn(
      "⚠️ WARNING: Neither MONGODB_URI nor MONGO_URI is set. Database connection skipped."
    );
    return null;
  }

  // Register connection lifecycle listeners once
  if (!mongoose.connection._hasLifecycleListeners) {
    mongoose.connection._hasLifecycleListeners = true;

    mongoose.connection.on("error", (err) => {
      console.error("❌ MongoDB connection error:", err.message);
    });

    mongoose.connection.on("disconnected", () => {
      console.warn("⚠️ MongoDB connection disconnected. Attempting auto-reconnect...");
    });

    mongoose.connection.on("reconnected", () => {
      console.log("✅ MongoDB connection re-established.");
    });
  }

  try {
    isConnecting = true;
    const dbName = process.env.DB_NAME || "vaidyasthana";
    const connectOptions = {
      dbName,
      serverSelectionTimeoutMS: 15000,
      autoIndex: true,
    };
    if (process.platform === "win32") {
      connectOptions.family = 4; // Force IPv4 only on Windows to prevent getaddrinfo ENOTFOUND
    }

    const conn = await mongoose.connect(uri, connectOptions);
    console.log(`✅ MongoDB Connected: ${conn.connection.host} | Database: ${conn.connection.name}`);
    isConnecting = false;
    return conn;
  } catch (err) {
    isConnecting = false;
    console.error("❌ MongoDB initial connection error:", err.message);
    // Keep HTTP server alive for health checks and Render container boot; schedule retry
    setTimeout(() => {
      if (mongoose.connection.readyState === 0) {
        console.log("🔄 Retrying MongoDB connection...");
        connectDB();
      }
    }, 5000);
    return null;
  }
};

const disconnectDB = async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    console.log("✅ MongoDB disconnected cleanly.");
  }
};

module.exports = connectDB;
module.exports.connectDB = connectDB;
module.exports.disconnectDB = disconnectDB;
