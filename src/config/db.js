const mongoose = require("mongoose");
const dns = require("dns");

// Configure resilient public DNS servers to prevent Windows c-ares ECONNREFUSED during SRV resolution
try {
  dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
} catch (dnsErr) {
  // If environment restricts setServers, continue with default resolver
}

const connectDB = async () => {
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
    const dbName = process.env.DB_NAME || "vaidyasthana";
    const conn = await mongoose.connect(uri, {
      dbName,
      serverSelectionTimeoutMS: 10000,
      family: 4, // Force IPv4 to prevent Windows getaddrinfo ENOTFOUND hiccups
      autoIndex: true,
    });
    console.log(`✅ MongoDB Connected: ${conn.connection.host} | Database: ${conn.connection.name}`);
    return conn;
  } catch (err) {
    console.error("❌ MongoDB initial connection error:", err.message);
    if (process.env.NODE_ENV === "production") {
      process.exit(1);
    }
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
