const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");

let io = null;

const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => callback(null, true),
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE"],
    },
  });

  // Authenticate socket handshake using JWT
  io.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        (socket.handshake.headers.authorization &&
          socket.handshake.headers.authorization.split(" ")[1]);

      if (!token) {
        // Allow unauthenticated connection for public broadcasts if needed,
        // but mark user as guest
        socket.user = null;
        return next();
      }

      const secret =
        process.env.JWT_SECRET ||
        "vaidyasthana_development_jwt_secret_key_32bytes";
      const decoded = jwt.verify(token, secret);
      socket.user = decoded;
      next();
    } catch (err) {
      console.warn("Socket handshake auth warning:", err.message);
      socket.user = null;
      next();
    }
  });

  io.on("connection", (socket) => {
    if (socket.user) {
      const userId = socket.user.id || socket.user._id;
      const userRole = socket.user.role;

      // Join private user room (e.g. user:60c72b...)
      socket.join(`user:${userId}`);

      if (userRole === "admin") {
        socket.join("admins");
      }

      if (userRole === "doctor") {
        socket.join("doctors");
      }
    }

    socket.on("join_patient_room", (patientId) => {
      // Only authorized doctor or the patient themselves can join
      if (
        socket.user &&
        (socket.user.role === "doctor" ||
          socket.user.role === "admin" ||
          socket.user.id === patientId)
      ) {
        socket.join(`patient:${patientId}`);
      }
    });

    socket.on("disconnect", () => {
      // Handle socket disconnect cleanly
    });
  });

  return io;
};

const getIO = () => io;

/**
 * Notify doctor and patient about appointment changes in real time
 */
const notifyAppointmentEvent = ({ doctorId, patientId, appointment, action }) => {
  if (!io) return;

  const docIdStr = doctorId ? doctorId.toString() : null;
  const patIdStr = patientId ? patientId.toString() : null;

  const payload = {
    action, // "created", "confirmed", "rescheduled", "cancelled", "rejected", "completed"
    appointment,
    timestamp: new Date().toISOString(),
  };

  // Deliver strictly to doctor's private room
  if (docIdStr) {
    io.to(`user:${docIdStr}`).emit("appointment:update", payload);
  }

  // Deliver strictly to patient's private room
  if (patIdStr) {
    io.to(`user:${patIdStr}`).emit("appointment:update", payload);
  }
};

/**
 * Notify doctor and admins about verification state changes
 */
const notifyVerificationEvent = ({ doctorId, status, decision, rejectionReason }) => {
  if (!io) return;

  const docIdStr = doctorId ? doctorId.toString() : null;

  if (docIdStr) {
    io.to(`user:${docIdStr}`).emit("verification:update", {
      status,
      decision,
      rejectionReason,
      timestamp: new Date().toISOString(),
    });
  }

  io.to("admins").emit("doctor:verification_status_changed", {
    doctorId: docIdStr,
    status,
    timestamp: new Date().toISOString(),
  });
};

/**
 * Notify user about new notifications or unread count changes
 */
const notifyNotificationEvent = ({ userId, notification, unreadCount }) => {
  if (!io) return;
  const userIdStr = userId ? userId.toString() : null;
  if (userIdStr) {
    io.to(`user:${userIdStr}`).emit("notification:new", {
      notification,
      unreadCount,
      timestamp: new Date().toISOString(),
    });
  }
};

module.exports = {
  initSocket,
  getIO,
  notifyAppointmentEvent,
  notifyVerificationEvent,
  notifyNotificationEvent,
};

