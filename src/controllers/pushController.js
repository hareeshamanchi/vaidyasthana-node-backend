const {
  getVapidPublicKey,
  saveSubscription,
  removeSubscription,
  sendPushToUser,
} = require("../services/pushNotificationService");

const getVapidKey = (req, res) => {
  const publicKey = getVapidPublicKey();
  res.status(200).json({
    success: true,
    publicKey,
  });
};

const subscribe = async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({
        success: false,
        message: "Push subscription object is required.",
      });
    }

    const saved = await saveSubscription(
      req.user._id,
      subscription,
      req.headers["user-agent"]
    );

    res.status(201).json({
      success: true,
      message: "Push subscription registered successfully.",
      subscriptionId: saved._id,
    });
  } catch (error) {
    console.error("Error saving push subscription:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to register push subscription.",
    });
  }
};

const unsubscribe = async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({
        success: false,
        message: "Subscription endpoint is required.",
      });
    }

    await removeSubscription(req.user._id, endpoint);

    res.status(200).json({
      success: true,
      message: "Push subscription removed successfully.",
    });
  } catch (error) {
    console.error("Error removing push subscription:", error);
    res.status(500).json({
      success: false,
      message: "Failed to remove push subscription.",
    });
  }
};

const testPush = async (req, res) => {
  try {
    const result = await sendPushToUser(req.user._id, {
      title: "Vaidyasthana Test Reminder",
      body: "Background push notifications are verified and active on this device.",
      data: { url: "/medications" },
    });

    res.status(200).json({
      success: true,
      message: `Test push dispatched to ${result.sent} device(s).`,
      result,
    });
  } catch (error) {
    console.error("Error dispatching test push:", error);
    res.status(500).json({
      success: false,
      message: "Failed to dispatch test push notification.",
    });
  }
};

module.exports = {
  getVapidKey,
  subscribe,
  unsubscribe,
  testPush,
};
