require("dotenv").config();
const assert = require("node:assert");
const { Resend } = require("resend");
const {
  getResendConfig,
  isEmailConfigured,
  getEmailProvider,
  sendViaResend,
  sendPasswordResetEmail,
  generatePasswordResetEmailHtml,
  maskSecret,
} = require("../src/services/emailService");
const {
  getFrontendBaseUrl,
  DEPLOYED_FRONTEND_URL,
  maskEmail,
} = require("../src/controllers/authController");

const runResendTestSuite = async () => {
  console.log("=================================================");
  console.log("   Vaidyasthana Resend Email & Security Tests   ");
  console.log("=================================================");

  // Save initial environment state
  const envSnapshot = { ...process.env };

  try {
    // -------------------------------------------------------------------
    // Test 1: Resend Configuration Sanitization & Defaults
    // -------------------------------------------------------------------
    console.log("Testing 1: Resend configuration parsing, trimming, and default sender... ");
    process.env.RESEND_API_KEY = ' "re_test_key_1234567890abcdef" ';
    delete process.env.RESEND_FROM_EMAIL;
    delete process.env.SMTP_FROM;

    let resendConfig = getResendConfig();
    assert.strictEqual(resendConfig.configured, true);
    assert.strictEqual(resendConfig.apiKey, "re_test_key_1234567890abcdef");
    assert.strictEqual(resendConfig.from, "Vaidyasthana Healthcare <onboarding@resend.dev>");

    // Custom sender email without angle brackets
    process.env.RESEND_FROM_EMAIL = ' "no-reply@vaidyasthana.com" ';
    resendConfig = getResendConfig();
    assert.strictEqual(resendConfig.from, "Vaidyasthana Healthcare <no-reply@vaidyasthana.com>");

    // Custom sender email with existing format
    process.env.RESEND_FROM_EMAIL = '"Vaidyasthana Vault" <security@vaidyasthana.com>';
    resendConfig = getResendConfig();
    assert.strictEqual(resendConfig.from, '"Vaidyasthana Vault" <security@vaidyasthana.com>');
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 2: Provider Selection & Active State
    // -------------------------------------------------------------------
    console.log("Testing 2: Resend active provider resolution... ");
    process.env.RESEND_API_KEY = "re_valid_api_key_sample";
    assert.strictEqual(isEmailConfigured(), true);
    assert.strictEqual(getEmailProvider(), "RESEND");

    delete process.env.RESEND_API_KEY;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    assert.strictEqual(isEmailConfigured(), false);
    assert.strictEqual(getEmailProvider(), "NONE");
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 3: Masking Sensitive Secrets & PII Redaction
    // -------------------------------------------------------------------
    console.log("Testing 3: Sensitive API key and recipient PII redaction... ");
    assert.strictEqual(maskSecret("re_1234567890"), "re****90");
    assert.strictEqual(maskSecret("short"), "sh****rt");
    assert.strictEqual(maskSecret(""), "[NOT_SET]");
    assert.strictEqual(maskSecret(null), "[NOT_SET]");

    assert.strictEqual(maskEmail("doctor.ramesh@gmail.com"), "d***h@gmail.com");
    assert.strictEqual(maskEmail("user@hospital.org"), "u***r@hospital.org");
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 4: Resend Upstream Dispatch & Acceptance (Mocked SDK)
    // -------------------------------------------------------------------
    console.log("Testing 4: Resend successful acceptance vs delivery distinction... ");
    process.env.RESEND_API_KEY = "re_mock_test_key_for_unit_tests";
    process.env.RESEND_FROM_EMAIL = "onboarding@resend.dev";

    // Spy/Mock Resend Emails prototype send method
    const dummyInstance = new Resend("dummy");
    const emailsProto = Object.getPrototypeOf(dummyInstance.emails);
    const originalSend = emailsProto.send;
    let interceptedSendCall = null;

    emailsProto.send = async function (payload) {
      interceptedSendCall = payload;
      return {
        data: { id: "re_msg_test_success_987654" },
        error: null,
      };
    };

    const resendSuccessResult = await sendViaResend({
      to: "verified.recipient@example-domain.org",
      name: "Dr. Ananya Rao",
      resetUrl: "https://vaidyasthana-frontend.onrender.com/reset-password/rawtoken123",
      expiresInMinutes: 15,
    });

    assert.strictEqual(resendSuccessResult.accepted, true);
    assert.strictEqual(resendSuccessResult.providerAccepted, true);
    assert.strictEqual(resendSuccessResult.delivered, false); // Crucial: Resend confirms acceptance, inbox delivery is async
    assert.strictEqual(resendSuccessResult.provider, "RESEND");
    assert.strictEqual(resendSuccessResult.messageId, "re_msg_test_success_987654");
    assert.ok(interceptedSendCall);
    assert.strictEqual(interceptedSendCall.from, "Vaidyasthana Healthcare <onboarding@resend.dev>");
    assert.deepStrictEqual(interceptedSendCall.to, ["verified.recipient@example-domain.org"]);
    assert.strictEqual(interceptedSendCall.subject, "Vaidyasthana - Password Reset Request");
    assert.ok(interceptedSendCall.html.includes("Dr. Ananya Rao"));
    assert.ok(interceptedSendCall.html.includes("rawtoken123"));
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 5: Resend Authentication Failure (HTTP 401 / Invalid Key)
    // -------------------------------------------------------------------
    console.log("Testing 5: Resend invalid API key (401) handling... ");
    emailsProto.send = async function () {
      return {
        data: null,
        error: {
          statusCode: 401,
          name: "authentication_error",
          message: "API key is invalid",
        },
      };
    };

    const resendAuthFail = await sendViaResend({
      to: "patient@hospital.org",
      name: "Patient",
      resetUrl: "https://vaidyasthana-frontend.onrender.com/reset-password/abc",
    });

    assert.strictEqual(resendAuthFail.accepted, false);
    assert.strictEqual(resendAuthFail.delivered, false);
    assert.strictEqual(resendAuthFail.providerAccepted, false);
    assert.strictEqual(resendAuthFail.reason, "RESEND_AUTHENTICATION_FAILED");
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 6: Resend Testing Domain Restriction (HTTP 403)
    // -------------------------------------------------------------------
    console.log("Testing 6: Resend testing domain restriction (403 unverified recipient) handling... ");
    emailsProto.send = async function () {
      return {
        data: null,
        error: {
          statusCode: 403,
          name: "forbidden",
          message:
            "You can only send testing emails to your own email address. Verify your domain at resend.com/domains",
        },
      };
    };

    const resendTestingDomainFail = await sendViaResend({
      to: "other_user@gmail.com",
      name: "Other User",
      resetUrl: "https://vaidyasthana-frontend.onrender.com/reset-password/abc",
    });

    assert.strictEqual(resendTestingDomainFail.accepted, false);
    assert.strictEqual(resendTestingDomainFail.delivered, false);
    assert.strictEqual(resendTestingDomainFail.reason, "RESEND_TESTING_DOMAIN_RESTRICTION");
    assert.ok(resendTestingDomainFail.diagnosticMessage.includes("Verify a custom domain in Resend dashboard"));
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 7: Resend Sender Domain Rejection (HTTP 422 / 403)
    // -------------------------------------------------------------------
    console.log("Testing 7: Resend unverified sender domain rejection handling... ");
    emailsProto.send = async function () {
      return {
        data: null,
        error: {
          statusCode: 422,
          name: "validation_error",
          message: "The domain 'unknown.org' is not verified.",
        },
      };
    };

    const resendSenderFail = await sendViaResend({
      to: "user@hospital.org",
      name: "User",
      resetUrl: "https://vaidyasthana-frontend.onrender.com/reset-password/abc",
    });

    assert.strictEqual(resendSenderFail.accepted, false);
    assert.strictEqual(resendSenderFail.reason, "RESEND_SENDER_REJECTED");
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 8: Resend Rate Limiting (HTTP 429)
    // -------------------------------------------------------------------
    console.log("Testing 8: Resend rate limit (429) handling... ");
    emailsProto.send = async function () {
      return {
        data: null,
        error: {
          statusCode: 429,
          name: "rate_limit_exceeded",
          message: "Too many requests. Please slow down.",
        },
      };
    };

    const resendRateLimitFail = await sendViaResend({
      to: "user@hospital.org",
      name: "User",
      resetUrl: "https://vaidyasthana-frontend.onrender.com/reset-password/abc",
    });

    assert.strictEqual(resendRateLimitFail.accepted, false);
    assert.strictEqual(resendRateLimitFail.reason, "RESEND_RATE_LIMITED");
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 9: Resend Network / TLS Timeout
    // -------------------------------------------------------------------
    console.log("Testing 9: Resend network/timeout exception handling... ");
    emailsProto.send = async function () {
      const timeoutErr = new Error("Connection timeout to api.resend.com:443");
      timeoutErr.code = "ETIMEDOUT";
      throw timeoutErr;
    };

    const resendTimeoutFail = await sendViaResend({
      to: "user@hospital.org",
      name: "User",
      resetUrl: "https://vaidyasthana-frontend.onrender.com/reset-password/abc",
    });

    assert.strictEqual(resendTimeoutFail.accepted, false);
    assert.strictEqual(resendTimeoutFail.reason, "RESEND_NETWORK_TIMEOUT");
    console.log("✔ PASSED");

    // Restore original prototype method
    emailsProto.send = originalSend;

    // -------------------------------------------------------------------
    // Test 10: Production Fail-Safe (No Silent Fallback to SMTP/Localhost)
    // -------------------------------------------------------------------
    console.log("Testing 10: Production fail-safe without RESEND_API_KEY... ");
    process.env.NODE_ENV = "production";
    delete process.env.RESEND_API_KEY;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GMAIL_SENDER_ADDRESS;
    // Set dummy SMTP credentials that must NOT be used in production
    process.env.SMTP_HOST = "smtp.gmail.com";
    process.env.SMTP_USER = "user@gmail.com";
    process.env.SMTP_PASS = "abcdefghijklmnop";

    const prodMissingResendResult = await sendPasswordResetEmail({
      to: "patient@hospital.org",
      name: "Patient",
      resetUrl: "https://vaidyasthana-frontend.onrender.com/reset-password/abc",
    });

    assert.strictEqual(prodMissingResendResult.accepted, false);
    assert.strictEqual(prodMissingResendResult.delivered, false);
    assert.strictEqual(prodMissingResendResult.reason, "RESEND_NOT_CONFIGURED");
    assert.strictEqual(prodMissingResendResult.provider, "NONE");
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 11: Production URL Origin Override & LAN IP Blocker
    // -------------------------------------------------------------------
    console.log("Testing 11: Render & Production URL override of local and private LAN IPs... ");
    process.env.NODE_ENV = "production";
    process.env.RENDER = "true";

    // Scenario A: Misconfigured LAN IP in environment
    process.env.FRONTEND_URL = "http://192.168.1.6:3000";
    assert.strictEqual(getFrontendBaseUrl({}), DEPLOYED_FRONTEND_URL);

    // Scenario B: Misconfigured localhost in environment
    process.env.FRONTEND_URL = "http://localhost:3000";
    assert.strictEqual(getFrontendBaseUrl({}), DEPLOYED_FRONTEND_URL);

    // Scenario C: Empty FRONTEND_URL
    delete process.env.FRONTEND_URL;
    assert.strictEqual(getFrontendBaseUrl({}), DEPLOYED_FRONTEND_URL);

    // Scenario D: Valid deployed HTTPS frontend URL
    process.env.FRONTEND_URL = "https://vaidyasthana-frontend.onrender.com";
    assert.strictEqual(getFrontendBaseUrl({}), DEPLOYED_FRONTEND_URL);

    // Scenario E: Deployed URL without https
    process.env.FRONTEND_URL = "http://vaidyasthana-frontend.onrender.com";
    assert.strictEqual(getFrontendBaseUrl({}), DEPLOYED_FRONTEND_URL);
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 12: HTML Email Template Generation
    // -------------------------------------------------------------------
    console.log("Testing 12: Password reset HTML email template structure... ");
    const htmlOutput = generatePasswordResetEmailHtml({
      name: "Dr. Sandeep Reddy",
      resetUrl: "https://vaidyasthana-frontend.onrender.com/reset-password/token_123_safe",
      expiresInMinutes: 15,
    });
    assert.ok(htmlOutput.includes("Vaidyasthana"));
    assert.ok(htmlOutput.includes("Hello, Dr. Sandeep Reddy"));
    assert.ok(htmlOutput.includes("https://vaidyasthana-frontend.onrender.com/reset-password/token_123_safe"));
    assert.ok(htmlOutput.includes("15 minutes"));
    assert.ok(htmlOutput.includes("Reset My Password"));
    console.log("✔ PASSED");

    console.log("\n=================================================");
    console.log("  ALL 12 RESEND EMAIL & SECURITY TESTS PASSED!   ");
    console.log("=================================================\n");
  } catch (err) {
    console.error("\n❌ RESEND TEST SUITE FAILED:", err);
    throw err;
  } finally {
    // Restore environment
    process.env = envSnapshot;
  }
};

runResendTestSuite().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
