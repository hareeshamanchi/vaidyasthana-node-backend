const {
  generateGmailAuthUrl,
  exchangeCodeAndVerifySender,
  getGmailOAuthStatus,
  revokeGmailAuthorization,
  cleanEnv,
} = require("../services/gmailOAuthService");
const { recordAuditEvent } = require("../services/auditService");

/**
 * Checks whether the incoming request is authorized to initiate or inspect Gmail OAuth setup.
 * Requires an authenticated Administrator (admin or superadmin) OR a valid setup secret key.
 *
 * @param {import('express').Request} req
 * @returns {{ authorized: boolean, reason?: string, actor?: string }}
 */
const isSetupAuthorized = (req) => {
  // 1. Authenticated administrator (via JWT cookie or Bearer token)
  if (req.user && (req.user.role === "admin" || req.user.role === "superadmin")) {
    return {
      authorized: true,
      actor: `admin:${req.user.id || req.user.email || "admin"}`,
    };
  }

  // 2. Secret setup key (via header or query parameter)
  const configuredSecret = cleanEnv(process.env.GMAIL_SETUP_SECRET);
  const suppliedSecret =
    req.headers["x-setup-secret"] ||
    req.headers["x-gmail-setup-key"] ||
    req.query.setupSecret ||
    req.query.setup_secret;

  if (configuredSecret && suppliedSecret && cleanEnv(suppliedSecret) === configuredSecret) {
    return {
      authorized: true,
      actor: "setup-secret-bearer",
    };
  }

  // 3. In local development only: If GMAIL_SETUP_SECRET is not explicitly configured,
  // permit local loopback requests with a localhost diagnostic notice
  if (process.env.NODE_ENV === "development" && !configuredSecret) {
    const isLocal =
      req.ip === "127.0.0.1" ||
      req.ip === "::1" ||
      req.hostname === "localhost" ||
      req.hostname === "127.0.0.1";
    if (isLocal) {
      return {
        authorized: true,
        actor: "local-dev-loopback",
      };
    }
  }

  return {
    authorized: false,
    reason:
      "Administrative privileges or a valid GMAIL_SETUP_SECRET header is required to access Gmail OAuth setup.",
  };
};

/**
 * Helper to render an accessible HTML status card for browser redirects
 */
const renderHtmlResponse = ({ success, title, message, details, recovery, meta }) => {
  const primaryColor = success ? "#059669" : "#dc2626";
  const bgLight = success ? "#f0fdf4" : "#fef2f2";
  const borderCol = success ? "#bbf7d0" : "#fecaca";

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Vaidyasthana Healthcare</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #0b1329;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
    }
    .card {
      background: #111c38;
      border: 1px solid #1e293b;
      border-radius: 12px;
      max-width: 580px;
      width: 100%;
      padding: 32px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .badge {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      background: ${bgLight};
      color: ${primaryColor};
      border: 1px solid ${borderCol};
      margin-bottom: 16px;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 22px;
      color: #f8fafc;
    }
    p {
      margin: 0 0 16px;
      line-height: 1.6;
      color: #94a3b8;
      font-size: 15px;
    }
    .box {
      background: #0d1527;
      border-left: 4px solid ${primaryColor};
      padding: 14px 18px;
      border-radius: 6px;
      margin: 18px 0;
      font-size: 14px;
      color: #cbd5e1;
    }
    .recovery {
      background: #1e1b4b;
      border: 1px solid #3730a3;
      padding: 14px 18px;
      border-radius: 6px;
      margin: 18px 0;
      font-size: 13px;
      color: #c7d2fe;
      line-height: 1.5;
    }
    .btn {
      display: inline-block;
      background: #0284c7;
      color: #ffffff;
      text-decoration: none;
      padding: 10px 20px;
      border-radius: 6px;
      font-weight: 500;
      font-size: 14px;
      margin-top: 10px;
    }
    .btn:hover {
      background: #0369a1;
    }
    .footer {
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid #1e293b;
      font-size: 12px;
      color: #64748b;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">${success ? "AUTHORIZATION SUCCESS" : "SETUP NOTICE"}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    ${details ? `<div class="box"><strong>Status Details:</strong><br>${details}</div>` : ""}
    ${recovery ? `<div class="recovery"><strong>How to resolve:</strong><br>${recovery}</div>` : ""}
    ${
      meta?.frontendUrl
        ? `<a href="${meta.frontendUrl}" class="btn">Return to Platform &rarr;</a>`
        : ""
    }
    <div class="footer">
      Vaidyasthana Healthcare Platform &bull; Secure Administrative Gmail Integration &bull; ${new Date().toUTCString()}
    </div>
  </div>
</body>
</html>
  `.trim();
};

/**
 * Initiates the Google OAuth 2.0 authorization code flow.
 * Restricted to authenticated administrators or valid setup secret bearers.
 *
 * GET /api/auth/google/authorize
 * GET /api/auth/google/url
 */
const initiateOAuthSetup = async (req, res) => {
  try {
    const authCheck = isSetupAuthorized(req);
    if (!authCheck.authorized) {
      return res.status(403).json({
        success: false,
        code: "SETUP_UNAUTHORIZED",
        message: authCheck.reason,
      });
    }

    const { authUrl, state, redirectUri, expiresInSeconds } = generateGmailAuthUrl({
      adminId: req.user?.id || null,
      redirectUri: req.query.redirect_uri,
    });

    recordAuditEvent({
      eventType: "GMAIL_OAUTH_INITIATED",
      actor: req.user || { role: "admin", name: authCheck.actor },
      action: "Initiated Google OAuth flow for Gmail sender",
      outcome: "success",
      details: { redirectUri },
      req,
    });

    console.log(
      `[SAFE_DIAGNOSTIC] Gmail OAuth authorization initiated by ${authCheck.actor}. Redirect URI: ${redirectUri}`
    );

    // If caller explicitly requested browser redirect via redirect=true
    if (req.query.redirect === "true") {
      return res.redirect(authUrl);
    }

    return res.status(200).json({
      success: true,
      message:
        "Google OAuth authorization URL generated. Open the link to authorize your Gmail sender account.",
      authUrl,
      state,
      redirectUri,
      expiresInSeconds,
    });
  } catch (error) {
    console.error("[SAFE_DIAGNOSTIC] Initiate OAuth error:", error.message);
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({
      success: false,
      code: error.code || "OAUTH_INITIATE_FAILED",
      message: error.message || "Failed to generate Google authorization URL.",
      missingVars: error.missingVars || undefined,
    });
  }
};

/**
 * OAuth 2.0 callback endpoint invoked by Google upon user authorization.
 * Validates state, exchanges authorization code, verifies sender account, and secures refresh token.
 *
 * GET /api/auth/google/callback
 */
const handleOAuthCallback = async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const acceptsHtml =
    req.headers.accept &&
    (req.headers.accept.includes("text/html") || req.headers.accept.includes("*/*"));

  // 1. Handle user cancellation or Google error
  if (error) {
    console.warn(
      `[SAFE_DIAGNOSTIC] Google OAuth callback returned error: ${error} - ${error_description || "No description"}`
    );

    recordAuditEvent({
      eventType: "GMAIL_OAUTH_DENIED",
      actor: { role: "system", name: "Google OAuth Callback" },
      action: "Google OAuth consent was denied or failed",
      outcome: "failure",
      reason: error_description || error,
      req,
    });

    if (acceptsHtml) {
      return res.status(400).send(
        renderHtmlResponse({
          success: false,
          title: "Google Authorization Denied",
          message:
            "The authorization request was declined or encountered an error from Google.",
          details: `Error: ${error}${error_description ? ` (${error_description})` : ""}`,
          recovery:
            "To grant email sending capabilities, restart the authorization flow and click 'Continue' / 'Allow' on the Google consent screen.",
          meta: { frontendUrl: process.env.FRONTEND_URL },
        })
      );
    }

    return res.status(400).json({
      success: false,
      code: "GOOGLE_OAUTH_ERROR",
      error,
      error_description: error_description || "Google authorization failed.",
    });
  }

  // 2. Validate input parameters
  if (!state || !code) {
    const missingMsg = !state ? "Missing state parameter" : "Missing authorization code";
    if (acceptsHtml) {
      return res.status(400).send(
        renderHtmlResponse({
          success: false,
          title: "Invalid Authorization Callback",
          message:
            "The callback request was missing required parameters from Google.",
          details: missingMsg,
          recovery: "Please restart the authorization process from the administrator dashboard.",
        })
      );
    }
    return res.status(400).json({
      success: false,
      code: "INVALID_CALLBACK_PARAMS",
      message: missingMsg,
    });
  }

  // 3. Process Code Exchange & Account Verification
  try {
    const result = await exchangeCodeAndVerifySender({
      code: String(code),
      state: String(state),
    });

    recordAuditEvent({
      eventType: "GMAIL_OAUTH_COMPLETED",
      actor: { role: "admin", name: "Google OAuth Callback" },
      action: "Google OAuth refresh token acquired and sender verified",
      outcome: "success",
      details: { authorizedEmail: result.authorizedEmail },
      req,
    });

    if (acceptsHtml) {
      return res.status(200).send(
        renderHtmlResponse({
          success: true,
          title: "Gmail Sender Successfully Authorized",
          message:
            "Your Google account has been authorized to send platform emails via the official Gmail API.",
          details: `Authorized Sender: ${result.authorizedEmail}<br>Transport: Gmail API (HTTPS)<br>Storage: Refresh token encrypted at rest.`,
          meta: { frontendUrl: process.env.FRONTEND_URL },
        })
      );
    }

    return res.status(200).json({
      success: true,
      code: "OAUTH_SUCCESS",
      message: "Gmail sender authorized successfully.",
      authorizedAccount: result.authorizedEmail,
      provider: result.provider,
    });
  } catch (err) {
    console.error(`[SAFE_DIAGNOSTIC] OAuth callback processing error: [${err.code}] ${err.message}`);

    recordAuditEvent({
      eventType: "GMAIL_OAUTH_ERROR",
      actor: { role: "system", name: "Google OAuth Callback" },
      action: "Failed to complete Google OAuth exchange",
      outcome: "failure",
      reason: err.message,
      details: { code: err.code },
      req,
    });

    const statusCode = err.statusCode || 400;

    if (acceptsHtml) {
      return res.status(statusCode).send(
        renderHtmlResponse({
          success: false,
          title: "Authorization Setup Failed",
          message: err.message,
          details: `Error Code: ${err.code || "UNKNOWN_ERROR"}`,
          recovery: err.recoveryGuidance || undefined,
          meta: { frontendUrl: process.env.FRONTEND_URL },
        })
      );
    }

    return res.status(statusCode).json({
      success: false,
      code: err.code || "OAUTH_CALLBACK_FAILED",
      message: err.message,
      recoveryGuidance: err.recoveryGuidance || undefined,
      authorizedAccount: err.authorizedAccount || undefined,
      expectedAccount: err.expectedAccount || undefined,
    });
  }
};

/**
 * Returns safe status of the Gmail OAuth integration without leaking secrets.
 *
 * GET /api/auth/google/status
 */
const getOAuthStatus = async (req, res) => {
  try {
    const authCheck = isSetupAuthorized(req);
    if (!authCheck.authorized) {
      return res.status(403).json({
        success: false,
        code: "SETUP_UNAUTHORIZED",
        message: authCheck.reason,
      });
    }

    const status = await getGmailOAuthStatus();
    return res.status(200).json({
      success: true,
      ...status,
    });
  } catch (error) {
    console.error("[SAFE_DIAGNOSTIC] Get OAuth status error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve Gmail OAuth status.",
    });
  }
};

/**
 * Revokes current Gmail OAuth authorization.
 *
 * POST /api/auth/google/revoke
 */
const revokeOAuth = async (req, res) => {
  try {
    const authCheck = isSetupAuthorized(req);
    if (!authCheck.authorized) {
      return res.status(403).json({
        success: false,
        code: "SETUP_UNAUTHORIZED",
        message: authCheck.reason,
      });
    }

    const result = await revokeGmailAuthorization();

    recordAuditEvent({
      eventType: "GMAIL_OAUTH_REVOKED",
      actor: req.user || { role: "admin", name: authCheck.actor },
      action: "Revoked Google OAuth Gmail integration",
      outcome: "success",
      req,
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error("[SAFE_DIAGNOSTIC] Revoke OAuth error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to revoke Gmail OAuth authorization.",
    });
  }
};

module.exports = {
  initiateOAuthSetup,
  handleOAuthCallback,
  getOAuthStatus,
  revokeOAuth,
  isSetupAuthorized,
};
