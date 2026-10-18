/**
 * Vaidyasthana Web Push Notification Service
 * Handles VAPID configuration, client subscription storage, and delivery of background medication alerts.
 */

const webPush = require("web-push");
const mongoose = require("mongoose");
const PushSubscription = require("../models/PushSubscription");

const DEFAULT_VAPID_PUBLIC =
  "BD22SpLbtSvX8TsZBJS09Zf7v5oTnOYxncR_2uCbW-hLneNFm-4x2KAXyqZJaaPaQfnw_ZHVJjydt45Gy0CIq34";
const DEFAULT_VAPID_PRIVATE =
  "SXF02CEwe2x-Lgw7pwWzFDQ0pVio7UHg6mXSLGiODKI";
const DEFAULT_VAPID_SUBJECT =
  process.env.VAPID_SUBJECT || "mailto:support@vaidyasthana.com";

let vapidConfigured = false;

const initVapid = () => {
  if (vapidConfigured) return true;

  const publicKey = process.env.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC;
  const privateKey = process.env.VAPID_PRIVATE_KEY || DEFAULT_VAPID_PRIVATE;
  const subject = process.env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT;

  if (publicKey && privateKey) {
    try {
      webPush.setVapidDetails(subject, publicKey, privateKey);
      vapidConfigured = true;
      return true;
    } catch (err) {
      console.error("[PUSH_SERVICE] Failed to initialize VAPID credentials:", err.message);
      return false;
    }
  }
  return false;
};

// Initialize on module load
initVapid();

const getVapidPublicKey = () => {
  return process.env.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC;
};

const isDbConnected = () => mongoose.connection && mongoose.connection.readyState === 1;

/**
 * Saves or updates a push subscription for an authenticated user.
 */
const saveSubscription = async (userId, subscriptionData, userAgent = "") => {
  if (!isDbConnected()) {
    throw new Error("Database not connected");
  }

  if (!userId || !subscriptionData || !subscriptionData.endpoint) {
    throw new Error("Invalid push subscription payload");
  }

  const { endpoint, keys } = subscriptionData;
  if (!keys || !keys.p256dh || !keys.auth) {
    throw new Error("Push subscription is missing p256dh or auth encryption keys");
  }

  const subscription = await PushSubscription.findOneAndUpdate(
    { endpoint },
    {
      $set: {
        userId,
        endpoint,
        keys: {
          p256dh: keys.p256dh,
          auth: keys.auth,
        },
        userAgent: userAgent || "",
        status: "active",
        lastActive: new Date(),
      },
    },
    {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true,
    }
  );

  return subscription;
};

/**
 * Removes or deactivates a push subscription for a user.
 */
const removeSubscription = async (userId, endpoint) => {
  if (!isDbConnected() || !endpoint) return false;

  const query = { endpoint };
  if (userId) query.userId = userId;

  const res = await PushSubscription.deleteOne(query);
  return res.deletedCount > 0;
};

/**
 * Dispatches a push notification to all active devices registered to a specific user.
 * Automatically cleans up expired subscriptions (HTTP 404 or 410).
 *
 * @param {string|mongoose.Types.ObjectId} userId
 * @param {object} payload
 * @param {object} [options]
 * @returns {Promise<{ sent: number, failed: number }>}
 */
const sendPushToUser = async (userId, payload, options = {}) => {
  if (!isDbConnected() || !userId) {
    return { sent: 0, failed: 0 };
  }

  initVapid();
  if (!vapidConfigured) {
    console.warn("[PUSH_SERVICE] VAPID credentials not configured. Skipping push dispatch.");
    return { sent: 0, failed: 0 };
  }

  const subscriptions = await PushSubscription.find({
    userId,
    status: "active",
  });

  if (!subscriptions || subscriptions.length === 0) {
    return { sent: 0, failed: 0 };
  }

  const notificationPayload = JSON.stringify({
    title: payload.title || "Medication Reminder - Vaidyasthana",
    body: payload.body || "It's time for your scheduled medication dose.",
    icon: payload.icon || "/favicon.ico",
    badge: payload.badge || "/favicon.ico",
    tag: payload.tag || "medication-due-reminder",
    data: payload.data || { url: "/medications" },
  });

  let sent = 0;
  let failed = 0;

  await Promise.all(
    subscriptions.map(async (sub) => {
      const pushConfig = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
        },
      };

      try {
        await webPush.sendNotification(pushConfig, notificationPayload, {
          TTL: options.ttl || 120, // 2 minutes time-to-live for repeating alerts
        });
        sent++;
        // Update lastActive timestamp
        await PushSubscription.updateOne(
          { _id: sub._id },
          { $set: { lastActive: new Date() } }
        );
      } catch (err) {
        failed++;
        const statusCode = err.statusCode;
        // HTTP 404 or 410 indicates the push subscription has expired or was revoked by the user/browser
        if (statusCode === 404 || statusCode === 410) {
          console.log(`[PUSH_SERVICE] Subscription expired (${statusCode}). Cleaning up endpoint.`);
          await PushSubscription.deleteOne({ _id: sub._id });
        } else {
          console.warn(`[PUSH_SERVICE] Failed to deliver push notification: ${err.message}`);
        }
      }
    })
  );

  return { sent, failed };
};

module.exports = {
  getVapidPublicKey,
  saveSubscription,
  removeSubscription,
  sendPushToUser,
  initVapid,
};
