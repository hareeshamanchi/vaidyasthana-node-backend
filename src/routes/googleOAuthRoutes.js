const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

const {
  initiateOAuthSetup,
  handleOAuthCallback,
  getOAuthStatus,
  revokeOAuth,
} = require("../controllers/googleOAuthController");

/**
 * Optional session decoder:
 * If an admin JWT is supplied in header or cookie, populates req.user.
 * If absent, leaves req.user undefined so controller can evaluate GMAIL_SETUP_SECRET.
 */
const populateUserIfPresent = (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (token) {
    try {
      const jwtSecret =
        process.env.JWT_SECRET || "vaidyasthana_development_jwt_secret_key_32bytes";
      const decoded = jwt.verify(token, jwtSecret);
      if (decoded && decoded.id) {
        req.user = {
          id: decoded.id,
          _id: decoded.id,
          role: decoded.role || "patient",
          email: decoded.email || "",
          name: decoded.name || "",
        };
      }
    } catch (e) {
      // Token expired or invalid; leave req.user undefined
    }
  }
  next();
};

router.use(populateUserIfPresent);

// 1. Authorization Initiation (Restricted to Admin or setup secret)
router.get("/authorize", initiateOAuthSetup);
router.get("/url", initiateOAuthSetup);

// 2. OAuth 2.0 Redirect Callback (Invoked by Google)
router.get("/callback", handleOAuthCallback);

// 3. Integration Status (Restricted to Admin or setup secret)
router.get("/status", getOAuthStatus);

// 4. Revocation / Disconnect (Restricted to Admin or setup secret)
router.post("/revoke", revokeOAuth);

module.exports = router;
