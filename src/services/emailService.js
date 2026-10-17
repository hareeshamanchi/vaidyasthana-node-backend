const nodemailer = require("nodemailer");

/**
 * Checks whether the SMTP email transport credentials are fully configured.
 * @returns {boolean}
 */
const isEmailConfigured = () => {
  return Boolean(
    process.env.SMTP_HOST &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS
  );
};

/**
 * Formats a clean, high-accessibility HTML template for password reset.
 * Adheres to Vaidyasthana's clinical theme (#0284c7, #0f172a, #f8fafc).
 */
const generatePasswordResetEmailHtml = ({ name, resetUrl, expiresInMinutes = 15 }) => {
  const safeName = name ? String(name).replace(/<[^>]*>?/gm, "") : "Patient / Doctor";

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Password Reset Request - Vaidyasthana</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #334155;
      line-height: 1.6;
    }
    .wrapper {
      width: 100%;
      background-color: #f1f5f9;
      padding: 40px 10px;
    }
    .container {
      max-width: 560px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 16px rgba(15, 23, 42, 0.08);
      border: 1px solid #e2e8f0;
    }
    .header {
      background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
      padding: 32px 24px;
      text-align: center;
      color: #ffffff;
    }
    .brand-title {
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.5px;
      margin: 0 0 6px 0;
    }
    .brand-subtitle {
      font-size: 13px;
      color: #e0f2fe;
      margin: 0;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      font-weight: 600;
    }
    .body-content {
      padding: 32px 28px;
    }
    .greeting {
      font-size: 18px;
      font-weight: 600;
      color: #0f172a;
      margin-top: 0;
      margin-bottom: 14px;
    }
    .text {
      font-size: 15px;
      color: #475569;
      margin-bottom: 20px;
    }
    .btn-wrap {
      text-align: center;
      margin: 32px 0;
    }
    .btn-reset {
      display: inline-block;
      background: #0284c7;
      color: #ffffff !important;
      text-decoration: none;
      font-size: 15px;
      font-weight: 600;
      padding: 14px 32px;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(2, 132, 199, 0.3);
    }
    .alert-box {
      background: #f8fafc;
      border-left: 4px solid #0284c7;
      padding: 14px 16px;
      border-radius: 0 6px 6px 0;
      margin: 24px 0;
      font-size: 13px;
      color: #64748b;
    }
    .alert-box strong {
      color: #0f172a;
    }
    .link-fallback {
      font-size: 12px;
      color: #94a3b8;
      word-break: break-all;
      margin-top: 24px;
      border-top: 1px solid #e2e8f0;
      padding-top: 16px;
    }
    .link-fallback a {
      color: #0284c7;
    }
    .footer {
      background: #f8fafc;
      padding: 20px 28px;
      text-align: center;
      border-top: 1px solid #e2e8f0;
      font-size: 12px;
      color: #94a3b8;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <h1 class="brand-title">Vaidyasthana</h1>
        <p class="brand-subtitle">Encrypted Health Vault & Clinical Systems</p>
      </div>

      <div class="body-content">
        <h2 class="greeting">Hello, ${safeName}</h2>
        <p class="text">
          We received a request to reset the password for your Vaidyasthana account. To create a new secure password, click the button below:
        </p>

        <div class="btn-wrap">
          <a href="${resetUrl}" target="_blank" rel="noopener noreferrer" class="btn-reset">
            Reset My Password
          </a>
        </div>

        <div class="alert-box">
          <strong>Security Notice:</strong> This single-use password reset link is valid for <strong>${expiresInMinutes} minutes</strong> only. If you did not request this password reset, you can safely ignore this email; your account remains secure and no changes have been made.
        </div>

        <div class="link-fallback">
          If the button above does not work, copy and paste this URL into your browser:<br>
          <a href="${resetUrl}" target="_blank" rel="noopener noreferrer">${resetUrl}</a>
        </div>
      </div>

      <div class="footer">
        &copy; ${new Date().getFullYear()} Vaidyasthana Healthcare Platform. All rights reserved.<br>
        This is an automated system notification. Please do not reply directly to this email.
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();
};

/**
 * Checks whether the recipient is a non-deliverable test fixture or placeholder domain.
 * Prevents attempting live outbound SMTP deliveries to placeholder accounts during tests.
 *
 * @param {string} email
 * @returns {boolean}
 */
const isTestPlaceholderEmail = (email) => {
  if (!email || typeof email !== "string") return true;
  const lower = email.trim().toLowerCase();
  const parts = lower.split("@");
  if (parts.length !== 2) return true;
  const localPart = parts[0];
  const domain = parts[1];

  return (
    domain === "vaidyasthana.com" ||
    domain === "example.com" ||
    domain === "example.org" ||
    domain === "test.com" ||
    domain === "localhost" ||
    localPart.startsWith("reset_patient_") ||
    localPart.startsWith("reset_doctor_") ||
    localPart.startsWith("test_patient_") ||
    localPart.startsWith("test_doctor_") ||
    localPart.startsWith("spam_")
  );
};

/**
 * Sends a password reset email using nodemailer if SMTP credentials are configured.
 * Safely handles unconfigured states without crashing or logging secrets.
 *
 * @param {Object} options
 * @param {string} options.to - Real recipient email address
 * @param {string} options.name - Recipient user's name
 * @param {string} options.resetUrl - Full password reset URL with single-use token
 * @param {number} [options.expiresInMinutes=15] - Expiration duration in minutes
 * @returns {Promise<{ delivered: boolean, messageId?: string, reason?: string, missingEnv?: string[], accepted?: string[], rejected?: string[] }>}
 */
const sendPasswordResetEmail = async ({ to, name, resetUrl, expiresInMinutes = 15 }) => {
  if (!isEmailConfigured()) {
    const missing = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"].filter(
      (envVar) => !process.env[envVar]
    );

    console.warn(
      `[SAFE_LOG] SMTP service is not configured (missing: ${missing.join(
        ", "
      )}). Password reset email could not be dispatched.`
    );

    return {
      delivered: false,
      reason: "SMTP_NOT_CONFIGURED",
      missingEnv: missing,
    };
  }

  // Intercept test fixture / placeholder emails to avoid outbound bounces
  if (isTestPlaceholderEmail(to)) {
    console.log(
      `[SAFE_LOG] Email address (${to}) is recognized as an internal test placeholder. Bypassing live outbound SMTP dispatch.`
    );
    return {
      delivered: true,
      messageId: `<mock-test-${Date.now()}@vaidyasthana.internal>`,
      reason: "TEST_FIXTURE_BYPASS",
      accepted: [to],
    };
  }

  try {
    const port = parseInt(process.env.SMTP_PORT, 10) || 587;
    const isSecure = process.env.SMTP_SECURE === "true" || port === 465;

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: isSecure,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    // Determine correct From header based on email provider requirements
    let fromAddress = (process.env.SMTP_FROM || "").trim();
    const smtpHost = (process.env.SMTP_HOST || "").toLowerCase();
    const smtpUser = (process.env.SMTP_USER || "").trim();

    if (!fromAddress) {
      fromAddress = `"Vaidyasthana Healthcare" <${smtpUser}>`;
    } else if (smtpHost.includes("gmail") && !fromAddress.includes(smtpUser)) {
      // Gmail SMTP requires the sender address to match the authenticated account
      // Preserve display name while ensuring sender matches SMTP_USER to prevent 553 error
      const nameMatch = fromAddress.match(/^"?([^"<]+)"?\s*</);
      const displayName = nameMatch ? nameMatch[1].trim() : "Vaidyasthana Healthcare";
      fromAddress = `"${displayName}" <${smtpUser}>`;
    }

    const htmlContent = generatePasswordResetEmailHtml({
      name,
      resetUrl,
      expiresInMinutes,
    });

    const textContent = `Hello ${name || "User"},\n\nWe received a request to reset your Vaidyasthana account password.\n\nPlease visit this link to choose a new password:\n${resetUrl}\n\nThis link is valid for ${expiresInMinutes} minutes.\nIf you did not request this, please disregard this email.\n\n— Vaidyasthana Healthcare Team`;

    const info = await transporter.sendMail({
      from: fromAddress,
      to,
      subject: "Vaidyasthana - Password Reset Request",
      text: textContent,
      html: htmlContent,
    });

    // Verify that provider confirmed acceptance of the recipient
    const isAccepted = Array.isArray(info.accepted) && info.accepted.includes(to);
    const wasRejected = Array.isArray(info.rejected) && info.rejected.includes(to);

    if (!isAccepted || wasRejected) {
      console.warn(
        `[SAFE_LOG] SMTP provider did not confirm acceptance for recipient ${to}. Response: ${info.response || "No response details"}`
      );
      return {
        delivered: false,
        reason: "PROVIDER_REJECTED",
        response: info.response,
        rejected: info.rejected || [],
      };
    }

    console.log(
      `[SAFE_LOG] Password reset email delivered successfully. MessageId: ${info.messageId}`
    );
    return {
      delivered: true,
      messageId: info.messageId,
      accepted: info.accepted,
      response: info.response,
    };
  } catch (error) {
    console.error(`[SAFE_LOG] Failed to send password reset email: ${error.message}`);
    return {
      delivered: false,
      reason: "SMTP_TRANSMISSION_ERROR",
      error: error.message,
    };
  }
};

module.exports = {
  isEmailConfigured,
  sendPasswordResetEmail,
  isTestPlaceholderEmail,
  generatePasswordResetEmailHtml,
};
