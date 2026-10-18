const { google } = require("googleapis");
const crypto = require("crypto");
const mongoose = require("mongoose");
const EmailIntegration = require("../models/EmailIntegration");

// In-memory active OAuth state store for CSRF protection: state -> { createdAt, expiresAt, metadata, used }
const activeOAuthStates = new Map();

// In-memory refresh token cache for high-performance retrieval and fallback during test runs
let inMemoryRefreshTokenCache = null;

/**
 * Strips surrounding double or single quotes and whitespace.
 *
 * @param {string} str
 * @returns {string}
 */
const cleanEnv = (str) => {
  if (!str || typeof str !== "string") return "";
  let s = str.trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
};

/**
 * Derives a deterministic 32-byte key for AES-256-GCM encryption.
 *
 * @returns {Buffer}
 */
const getEncryptionKey = () => {
  const secret =
    process.env.ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    "vaidyasthana_secure_gmail_oauth_fallback_salt_key_32";
  return crypto.scryptSync(secret, "vaidyasthana_oauth_salt", 32);
};

/**
 * Encrypts a sensitive string (such as an OAuth refresh token) using AES-256-GCM.
 *
 * @param {string} text
 * @returns {{ encrypted: string, iv: string, tag: string }}
 */
const encryptSecret = (text) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return {
    encrypted,
    iv: iv.toString("hex"),
    tag,
  };
};

/**
 * Decrypts an AES-256-GCM encrypted payload.
 *
 * @param {string} encryptedHex
 * @param {string} ivHex
 * @param {string} tagHex
 * @returns {string}
 */
const decryptSecret = (encryptedHex, ivHex, tagHex) => {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
};

/**
 * Masks an email address for safe diagnostics without leaking PII.
 * Example: 'vaidyasthana.health@gmail.com' -> 'v***h@gmail.com'
 *
 * @param {string} email
 * @returns {string}
 */
const maskEmail = (email) => {
  if (!email || typeof email !== "string" || !email.includes("@")) return "[INVALID_EMAIL]";
  const [localPart, domain] = email.split("@");
  if (localPart.length <= 2) {
    return `${localPart[0]}***@${domain}`;
  }
  return `${localPart[0]}***${localPart[localPart.length - 1]}@${domain}`;
};

/**
 * Resolves Google OAuth 2.0 configuration from environment variables.
 *
 * @returns {{
 *   clientId: string,
 *   clientSecret: string,
 *   redirectUri: string,
 *   senderAddress: string,
 *   frontendUrl: string,
 *   configured: boolean,
 *   missingVars: string[]
 * }}
 */
const getGoogleOAuthConfig = () => {
  const clientId = cleanEnv(process.env.GOOGLE_CLIENT_ID);
  const clientSecret = cleanEnv(process.env.GOOGLE_CLIENT_SECRET);
  let redirectUri = cleanEnv(process.env.GOOGLE_REDIRECT_URI);
  const senderAddress = cleanEnv(process.env.GMAIL_SENDER_ADDRESS).toLowerCase();
  const frontendUrl = cleanEnv(process.env.FRONTEND_URL) || "https://vaidyasthana-frontend.onrender.com";

  const isProd =
    process.env.NODE_ENV === "production" ||
    process.env.RENDER === "true" ||
    Boolean(process.env.RENDER_SERVICE_ID);

  if (!redirectUri) {
    redirectUri = isProd
      ? "https://vaidyasthana-node-backend.onrender.com/api/auth/google/callback"
      : "http://localhost:5000/api/auth/google/callback";
  }

  const missingVars = [];
  if (!clientId) missingVars.push("GOOGLE_CLIENT_ID");
  if (!clientSecret) missingVars.push("GOOGLE_CLIENT_SECRET");
  if (!redirectUri) missingVars.push("GOOGLE_REDIRECT_URI");
  if (!senderAddress) missingVars.push("GMAIL_SENDER_ADDRESS");

  return {
    clientId,
    clientSecret,
    redirectUri,
    senderAddress,
    frontendUrl,
    configured: missingVars.length === 0,
    missingVars,
  };
};

/**
 * Creates an authorized OAuth2Client instance using the current credentials.
 *
 * @param {string} [overrideRedirectUri]
 * @returns {import('googleapis').Auth.OAuth2Client}
 */
const createOAuth2Client = (overrideRedirectUri) => {
  const config = getGoogleOAuthConfig();
  return new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    overrideRedirectUri || config.redirectUri
  );
};

/**
 * Generates and caches a cryptographically secure random state parameter (32 bytes = 256 bits).
 *
 * @param {Object} [metadata={}]
 * @param {number} [ttlMs=15*60*1000] - 15 minutes TTL
 * @returns {string} State token
 */
const generateOAuthState = (metadata = {}, ttlMs = 15 * 60 * 1000) => {
  const state = crypto.randomBytes(32).toString("hex");
  const now = Date.now();

  // Clean expired states
  for (const [key, item] of activeOAuthStates.entries()) {
    if (now > item.expiresAt) {
      activeOAuthStates.delete(key);
    }
  }

  activeOAuthStates.set(state, {
    createdAt: now,
    expiresAt: now + ttlMs,
    metadata,
    used: false,
  });

  return state;
};

/**
 * Validates and atomically consumes an OAuth state token to prevent replay attacks.
 *
 * @param {string} state
 * @returns {{ valid: boolean, reason?: string, metadata?: Object }}
 */
const validateAndConsumeState = (state) => {
  if (!state || typeof state !== "string" || state.trim() === "") {
    return { valid: false, reason: "MISSING_STATE" };
  }

  const cleanState = state.trim();
  const entry = activeOAuthStates.get(cleanState);

  if (!entry) {
    return { valid: false, reason: "INVALID_STATE" };
  }

  if (entry.used) {
    return { valid: false, reason: "STATE_ALREADY_USED" };
  }

  if (Date.now() > entry.expiresAt) {
    activeOAuthStates.delete(cleanState);
    return { valid: false, reason: "EXPIRED_STATE" };
  }

  // Atomically consume
  activeOAuthStates.delete(cleanState);

  return {
    valid: true,
    metadata: entry.metadata || {},
  };
};

/**
 * Clears all active state entries (used for unit test resets).
 */
const _resetOAuthStates = () => {
  activeOAuthStates.clear();
  inMemoryRefreshTokenCache = null;
};

/**
 * Generates the Google OAuth 2.0 authorization URL for Gmail API sender authorization.
 * Strictly requests offline access, explicit consent prompt, and minimal scope.
 *
 * @param {Object} [options]
 * @param {string} [options.adminId] - ID of the administrative actor
 * @param {string} [options.redirectUri] - Custom redirect URI if overriding default
 * @returns {{ authUrl: string, state: string, redirectUri: string, expiresInSeconds: number }}
 */
const generateGmailAuthUrl = (options = {}) => {
  const config = getGoogleOAuthConfig();

  if (!config.clientId || !config.clientSecret) {
    const missing = config.missingVars.join(", ");
    const err = new Error(`Google OAuth is not configured. Missing environment variables: ${missing}`);
    err.code = "OAUTH_CONFIG_MISSING";
    err.missingVars = config.missingVars;
    throw err;
  }

  const redirectUri = options.redirectUri || config.redirectUri;
  const oauth2Client = createOAuth2Client(redirectUri);

  const state = generateOAuthState({
    adminId: options.adminId || null,
    initiatedAt: new Date().toISOString(),
    redirectUri,
  });

  // Request the minimum Gmail sending scope and userinfo email for identity verification
  const scopes = [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/userinfo.email",
  ];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline", // Mandatory for Google to issue a refresh_token
    prompt: "consent",     // Mandatory: Forces Google to display consent and issue a refresh token every time
    scope: scopes,
    state,
    include_granted_scopes: true,
  });

  return {
    authUrl,
    state,
    redirectUri,
    expiresInSeconds: 900,
  };
};

/**
 * Exchanges the OAuth authorization code, verifies the sender identity,
 * and securely records the refresh token.
 *
 * @param {Object} params
 * @param {string} params.code - Authorization code from Google redirect
 * @param {string} params.state - CSRF state token
 * @param {string} [params.customRedirectUri] - If a custom redirect URI was supplied at initiation
 * @param {import('googleapis').Auth.OAuth2Client} [params.injectedOAuth2Client] - For automated unit tests
 * @returns {Promise<{
 *   success: boolean,
 *   authorizedEmail: string,
 *   provider: string,
 *   message: string,
 *   hasRefreshToken: boolean
 * }>}
 */
const exchangeCodeAndVerifySender = async ({
  code,
  state,
  customRedirectUri,
  injectedOAuth2Client,
}) => {
  // 1. Validate State Token
  const stateCheck = validateAndConsumeState(state);
  if (!stateCheck.valid) {
    const err = new Error(
      stateCheck.reason === "EXPIRED_STATE"
        ? "OAuth authorization session has expired. Please restart the authorization flow."
        : "Invalid or forged OAuth state parameter. Authorization rejected."
    );
    err.code = stateCheck.reason || "INVALID_STATE";
    err.statusCode = 400;
    throw err;
  }

  if (!code || typeof code !== "string" || !code.trim()) {
    const err = new Error("Missing authorization code from Google OAuth callback.");
    err.code = "MISSING_AUTHORIZATION_CODE";
    err.statusCode = 400;
    throw err;
  }

  const config = getGoogleOAuthConfig();
  const oauth2Client =
    injectedOAuth2Client ||
    createOAuth2Client(customRedirectUri || stateCheck.metadata?.redirectUri || config.redirectUri);

  // 2. Exchange authorization code for tokens
  let tokenResponse;
  try {
    tokenResponse = await oauth2Client.getToken(code.trim());
  } catch (tokenErr) {
    console.error(
      `[SAFE_DIAGNOSTIC] Google OAuth code exchange failed: ${tokenErr.message}`
    );
    const err = new Error(
      `Google authorization code exchange failed: ${tokenErr.message || "Invalid or expired code"}`
    );
    err.code = "CODE_EXCHANGE_FAILED";
    err.statusCode = 400;
    err.originalMessage = tokenErr.message;
    throw err;
  }

  const tokens = tokenResponse.tokens || tokenResponse;

  // 3. Verify Refresh Token presence
  if (!tokens.refresh_token) {
    console.error(
      "[SAFE_DIAGNOSTIC] Google OAuth exchange succeeded but Google did NOT return a refresh_token."
    );
    const err = new Error(
      "Google did not issue a refresh token. To obtain a refresh token, existing authorization must be re-consented. Please revoke existing access for this app in your Google Account security settings (https://myaccount.google.com/permissions) and try again with prompt=consent and access_type=offline."
    );
    err.code = "MISSING_REFRESH_TOKEN";
    err.statusCode = 400;
    err.recoveryGuidance =
      "Ensure prompt=consent and access_type=offline are present in the authorization URL. If previously authorized, revoke app access at https://myaccount.google.com/permissions first.";
    throw err;
  }

  // 4. Resolve Authorized Account Email
  let authorizedEmail = "";

  // Attempt A: Extract from id_token if provided
  if (tokens.id_token) {
    try {
      const parts = tokens.id_token.split(".");
      if (parts.length === 3) {
        const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
        const payload = JSON.parse(payloadJson);
        if (payload.email) {
          authorizedEmail = payload.email.toLowerCase().trim();
        }
      }
    } catch (parseErr) {
      // Continue to API check
    }
  }

  // Attempt B: Query userinfo API if id_token did not supply email
  if (!authorizedEmail) {
    try {
      oauth2Client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
      const userInfo = await oauth2.userinfo.get();
      if (userInfo.data && userInfo.data.email) {
        authorizedEmail = userInfo.data.email.toLowerCase().trim();
      }
    } catch (userInfoErr) {
      console.warn(
        `[SAFE_DIAGNOSTIC] Could not fetch userinfo via Google API: ${userInfoErr.message}`
      );
    }
  }

  // 5. Verify Authorized Account matches GMAIL_SENDER_ADDRESS
  const configuredSender = config.senderAddress;

  if (configuredSender && authorizedEmail) {
    if (authorizedEmail !== configuredSender) {
      console.error(
        `[SAFE_DIAGNOSTIC] Sender account mismatch: Authorized (${maskEmail(
          authorizedEmail
        )}) does not match GMAIL_SENDER_ADDRESS (${maskEmail(configuredSender)}).`
      );
      const err = new Error(
        `Authorized Google account (${maskEmail(
          authorizedEmail
        )}) does not match configured GMAIL_SENDER_ADDRESS (${maskEmail(
          configuredSender
        )}). Please sign in with the designated sender account.`
      );
      err.code = "SENDER_ACCOUNT_MISMATCH";
      err.statusCode = 400;
      err.authorizedAccount = maskEmail(authorizedEmail);
      err.expectedAccount = maskEmail(configuredSender);
      throw err;
    }
  }

  const effectiveEmail = authorizedEmail || configuredSender || "unknown@gmail.com";

  // 6. Securely Store Refresh Token (Encrypt at rest)
  const encryptedPayload = encryptSecret(tokens.refresh_token);

  // Update in-memory cache
  inMemoryRefreshTokenCache = {
    senderAddress: effectiveEmail,
    refreshToken: tokens.refresh_token,
    authorizedAt: new Date(),
  };

  // Persist to MongoDB Atlas if database is connected
  if (mongoose.connection.readyState === 1) {
    try {
      await EmailIntegration.findOneAndUpdate(
        { provider: "GMAIL_OAUTH2", senderAddress: effectiveEmail },
        {
          provider: "GMAIL_OAUTH2",
          senderAddress: effectiveEmail,
          encryptedRefreshToken: encryptedPayload.encrypted,
          iv: encryptedPayload.iv,
          tag: encryptedPayload.tag,
          scope: tokens.scope ? tokens.scope.split(" ") : ["https://www.googleapis.com/auth/gmail.send"],
          status: "active",
          authorizedBy:
            stateCheck.metadata?.adminId && mongoose.Types.ObjectId.isValid(stateCheck.metadata.adminId)
              ? stateCheck.metadata.adminId
              : null,
          lastAuthorizedAt: new Date(),
        },
        { upsert: true, returnDocument: "after" }
      );
      console.log(
        `[SAFE_DIAGNOSTIC] Google OAuth refresh token encrypted and committed to MongoDB Atlas for ${maskEmail(
          effectiveEmail
        )}.`
      );
    } catch (dbErr) {
      console.error(
        `[SAFE_DIAGNOSTIC] Failed to commit encrypted token to MongoDB: ${dbErr.message}`
      );
    }
  }

  console.log(
    `[SAFE_DIAGNOSTIC] Google OAuth 2.0 authorization successfully established for sender ${maskEmail(
      effectiveEmail
    )}. Refresh token stored securely.`
  );

  return {
    success: true,
    authorizedEmail: maskEmail(effectiveEmail),
    provider: "GMAIL_OAUTH2",
    message: "Gmail API sender successfully authorized.",
    hasRefreshToken: true,
  };
};

/**
 * Retrieves the stored decrypted refresh token from MongoDB or memory cache.
 *
 * @param {string} [senderAddress]
 * @returns {Promise<string|null>} Decrypted refresh token or null
 */
const getStoredRefreshToken = async (senderAddress) => {
  // 1. Check in-memory cache first
  if (inMemoryRefreshTokenCache && inMemoryRefreshTokenCache.refreshToken) {
    if (
      !senderAddress ||
      inMemoryRefreshTokenCache.senderAddress.toLowerCase() === senderAddress.toLowerCase().trim()
    ) {
      return inMemoryRefreshTokenCache.refreshToken;
    }
  }

  // 2. Check environment variable override
  if (process.env.GMAIL_REFRESH_TOKEN) {
    return cleanEnv(process.env.GMAIL_REFRESH_TOKEN);
  }

  // 3. Check MongoDB Atlas
  if (mongoose.connection.readyState === 1) {
    try {
      const query = { provider: "GMAIL_OAUTH2", status: "active" };
      if (senderAddress) {
        query.senderAddress = senderAddress.toLowerCase().trim();
      }

      const doc = await EmailIntegration.findOne(query).sort({ updatedAt: -1 });
      if (doc && doc.encryptedRefreshToken && doc.iv && doc.tag) {
        const decrypted = decryptSecret(doc.encryptedRefreshToken, doc.iv, doc.tag);
        // Cache in memory
        inMemoryRefreshTokenCache = {
          senderAddress: doc.senderAddress,
          refreshToken: decrypted,
          authorizedAt: doc.lastAuthorizedAt,
        };
        return decrypted;
      }
    } catch (err) {
      console.error(`[SAFE_DIAGNOSTIC] Failed to read refresh token from MongoDB: ${err.message}`);
    }
  }

  return null;
};

/**
 * Returns safe diagnostic status regarding Gmail OAuth integration.
 * NEVER leaks refresh tokens or secrets.
 *
 * @returns {Promise<{
 *   provider: string,
 *   configured: boolean,
 *   authorized: boolean,
 *   senderAddress: string,
 *   redirectUri: string,
 *   missingVars: string[],
 *   lastAuthorizedAt: string|null
 * }>}
 */
const getGmailOAuthStatus = async () => {
  const config = getGoogleOAuthConfig();
  const refreshToken = await getStoredRefreshToken(config.senderAddress);

  let lastAuthorizedAt = null;
  if (inMemoryRefreshTokenCache?.authorizedAt) {
    lastAuthorizedAt = inMemoryRefreshTokenCache.authorizedAt.toISOString();
  } else if (mongoose.connection.readyState === 1 && config.senderAddress) {
    try {
      const doc = await EmailIntegration.findOne({
        provider: "GMAIL_OAUTH2",
        senderAddress: config.senderAddress,
      });
      if (doc?.lastAuthorizedAt) {
        lastAuthorizedAt = doc.lastAuthorizedAt.toISOString();
      }
    } catch (e) {
      // Ignored
    }
  }

  return {
    provider: "GMAIL_OAUTH2",
    configured: config.configured,
    authorized: Boolean(refreshToken),
    senderAddress: maskEmail(config.senderAddress),
    redirectUri: config.redirectUri,
    missingVars: config.missingVars,
    lastAuthorizedAt,
  };
};

/**
 * Revokes the stored Gmail OAuth authorization.
 *
 * @returns {Promise<{ success: boolean, message: string }>}
 */
const revokeGmailAuthorization = async () => {
  const config = getGoogleOAuthConfig();
  const refreshToken = await getStoredRefreshToken(config.senderAddress);

  if (refreshToken) {
    try {
      const oauth2Client = createOAuth2Client();
      await oauth2Client.revokeToken(refreshToken);
    } catch (err) {
      console.warn(`[SAFE_DIAGNOSTIC] Google token revocation warning: ${err.message}`);
    }
  }

  inMemoryRefreshTokenCache = null;

  if (mongoose.connection.readyState === 1) {
    const filter = { provider: "GMAIL_OAUTH2" };
    if (config.senderAddress) {
      filter.senderAddress = config.senderAddress.toLowerCase().trim();
    }
    await EmailIntegration.updateMany(filter, { status: "revoked", updatedAt: new Date() });
  }

  return {
    success: true,
    message: "Gmail OAuth authorization revoked successfully.",
  };
};

/**
 * Synchronous check whether a Gmail OAuth refresh token is cached in memory or provided via env.
 *
 * @param {string} [senderAddress]
 * @returns {boolean}
 */
const isGmailOAuthAuthorizedSync = (senderAddress) => {
  const config = getGoogleOAuthConfig();
  if (!config.configured) return false;
  const targetSender = (senderAddress || config.senderAddress || "").toLowerCase().trim();

  if (inMemoryRefreshTokenCache && inMemoryRefreshTokenCache.refreshToken) {
    if (
      !targetSender ||
      inMemoryRefreshTokenCache.senderAddress.toLowerCase() === targetSender
    ) {
      return true;
    }
  }

  if (process.env.GMAIL_REFRESH_TOKEN && process.env.GMAIL_REFRESH_TOKEN.trim().length > 10) {
    return true;
  }

  return false;
};

/**
 * Asynchronous check whether a Gmail OAuth refresh token is authorized (memory cache, env, or DB).
 *
 * @param {string} [senderAddress]
 * @returns {Promise<boolean>}
 */
const isGmailOAuthAuthorized = async (senderAddress) => {
  const config = getGoogleOAuthConfig();
  if (!config.configured) return false;
  const token = await getStoredRefreshToken(senderAddress || config.senderAddress);
  return Boolean(token);
};

/**
 * Test helper to manually set in-memory refresh token cache.
 */
const _setInMemoryRefreshToken = ({ senderAddress, refreshToken }) => {
  inMemoryRefreshTokenCache = {
    senderAddress: (senderAddress || "vaidyasthana.clinical@gmail.com").toLowerCase().trim(),
    refreshToken,
    authorizedAt: new Date(),
  };
};

module.exports = {
  getGoogleOAuthConfig,
  createOAuth2Client,
  generateOAuthState,
  validateAndConsumeState,
  generateGmailAuthUrl,
  exchangeCodeAndVerifySender,
  getStoredRefreshToken,
  getGmailOAuthStatus,
  revokeGmailAuthorization,
  isGmailOAuthAuthorizedSync,
  isGmailOAuthAuthorized,
  _setInMemoryRefreshToken,
  maskEmail,
  cleanEnv,
  encryptSecret,
  decryptSecret,
  _resetOAuthStates,
};

