require("dotenv").config();
const assert = require("node:assert");
const http = require("node:http");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const app = require("../src/app");
const connectDB = require("../src/config/db");
const {
  getGoogleOAuthConfig,
  generateGmailAuthUrl,
  validateAndConsumeState,
  generateOAuthState,
  exchangeCodeAndVerifySender,
  getStoredRefreshToken,
  getGmailOAuthStatus,
  revokeGmailAuthorization,
  maskEmail,
  encryptSecret,
  decryptSecret,
  _resetOAuthStates,
  _setInMemoryRefreshToken,
  isGmailOAuthAuthorizedSync,
} = require("../src/services/gmailOAuthService");
const {
  sendViaGmailOAuth,
  sendPasswordResetEmail,
  buildRfc2822Message,
  isEmailConfigured,
  getEmailProvider,
} = require("../src/services/emailService");
const User = require("../src/models/User");


let server;
let baseUrl;

const runTestSuite = async () => {
  console.log("=================================================");
  console.log("   Vaidyasthana Google OAuth 2.0 Gmail Tests    ");
  console.log("=================================================");

  // Connect to Atlas if available
  if (mongoose.connection.readyState === 0) {
    try {
      await connectDB();
      console.log("✔ Connected to MongoDB Atlas.");
    } catch (e) {
      console.warn("⚠️ MongoDB Atlas connection skipped for mock test run:", e.message);
    }
  }

  // Spin up test HTTP server
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
  console.log(`✔ Test HTTP server listening on ${baseUrl}`);

  const envSnapshot = { ...process.env };

  try {
    // -------------------------------------------------------------------
    // Test 1: Configuration Resolution & Variable Parsing
    // -------------------------------------------------------------------
    console.log("Testing 1: Configuration resolution, missing vars, and trimming... ");
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GMAIL_SENDER_ADDRESS;
    delete process.env.GOOGLE_REDIRECT_URI;

    let config = getGoogleOAuthConfig();
    assert.strictEqual(config.configured, false);
    assert.ok(config.missingVars.includes("GOOGLE_CLIENT_ID"));
    assert.ok(config.missingVars.includes("GOOGLE_CLIENT_SECRET"));
    assert.ok(config.missingVars.includes("GMAIL_SENDER_ADDRESS"));

    process.env.GOOGLE_CLIENT_ID = ' "mock-client-id-12345.apps.googleusercontent.com" ';
    process.env.GOOGLE_CLIENT_SECRET = ' "GOCSPX-mock_secret_abc123" ';
    process.env.GMAIL_SENDER_ADDRESS = ' "Vaidyasthana.Clinical@gmail.com" ';
    process.env.GOOGLE_REDIRECT_URI = "http://localhost:5000/api/auth/google/callback";

    config = getGoogleOAuthConfig();
    assert.strictEqual(config.configured, true);
    assert.strictEqual(config.clientId, "mock-client-id-12345.apps.googleusercontent.com");
    assert.strictEqual(config.clientSecret, "GOCSPX-mock_secret_abc123");
    assert.strictEqual(config.senderAddress, "vaidyasthana.clinical@gmail.com");
    assert.strictEqual(config.redirectUri, "http://localhost:5000/api/auth/google/callback");
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 2: AES-256-GCM Encryption & Decryption at Rest
    // -------------------------------------------------------------------
    console.log("Testing 2: AES-256-GCM refresh token encryption & decryption... ");
    const sampleToken = "1//04mock_RefreshToken_Very_Secret_Long_Entropy_987654321";
    const encrypted = encryptSecret(sampleToken);
    assert.ok(encrypted.encrypted);
    assert.ok(encrypted.iv);
    assert.ok(encrypted.tag);
    assert.notStrictEqual(encrypted.encrypted, sampleToken);

    const decrypted = decryptSecret(encrypted.encrypted, encrypted.iv, encrypted.tag);
    assert.strictEqual(decrypted, sampleToken);
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 3: Cryptographic State Generation, TTL, and Replay Protection
    // -------------------------------------------------------------------
    console.log("Testing 3: Cryptographic OAuth state generation & single-use consumption... ");
    _resetOAuthStates();
    const stateToken = generateOAuthState({ adminId: "admin_test_1" });
    assert.strictEqual(typeof stateToken, "string");
    assert.strictEqual(stateToken.length, 64); // 32 bytes hex = 64 characters

    // Valid state can be consumed
    const firstCheck = validateAndConsumeState(stateToken);
    assert.strictEqual(firstCheck.valid, true);
    assert.strictEqual(firstCheck.metadata.adminId, "admin_test_1");

    // Replay attack: cannot consume the same state twice
    const replayCheck = validateAndConsumeState(stateToken);
    assert.strictEqual(replayCheck.valid, false);
    assert.strictEqual(replayCheck.reason, "INVALID_STATE");

    // Forged state rejected
    const forgedCheck = validateAndConsumeState("forged_state_value_12345");
    assert.strictEqual(forgedCheck.valid, false);
    assert.strictEqual(forgedCheck.reason, "INVALID_STATE");

    // Expired state rejected
    const expiredState = generateOAuthState({}, -1000); // Created in past
    const expiredCheck = validateAndConsumeState(expiredState);
    assert.strictEqual(expiredCheck.valid, false);
    assert.strictEqual(expiredCheck.reason, "EXPIRED_STATE");
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 4: Authorization URL Construction & Scope Verification
    // -------------------------------------------------------------------
    console.log("Testing 4: Authorization URL generation with minimum scope & explicit consent... ");
    const authData = generateGmailAuthUrl({ adminId: "admin_123" });
    assert.ok(authData.authUrl);
    assert.ok(authData.state);
    assert.ok(authData.authUrl.includes("accounts.google.com/o/oauth2/v2/auth"));
    assert.ok(authData.authUrl.includes("access_type=offline"));
    assert.ok(authData.authUrl.includes("prompt=consent"));
    assert.ok(authData.authUrl.includes("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.send"));
    assert.ok(authData.authUrl.includes(`state=${authData.state}`));
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 5: Authorization Initiation Endpoint Protection (Admin / Setup Secret)
    // -------------------------------------------------------------------
    console.log("Testing 5: Route protection on /api/auth/google/authorize... ");
    process.env.NODE_ENV = "production"; // Strict production mode
    process.env.GMAIL_SETUP_SECRET = "super_secure_setup_secret_passphrase_2026";

    // Scenario A: Unauthenticated public request without setup secret -> 403 Forbidden
    const resBlocked = await fetch(`${baseUrl}/api/auth/google/authorize`, {
      headers: { Accept: "application/json" },
    });
    assert.strictEqual(resBlocked.status, 403);
    const dataBlocked = await resBlocked.json();
    assert.strictEqual(dataBlocked.code, "SETUP_UNAUTHORIZED");

    // Scenario B: Request with valid GMAIL_SETUP_SECRET header -> 200 OK
    const resSecretHeader = await fetch(`${baseUrl}/api/auth/google/authorize`, {
      headers: {
        Accept: "application/json",
        "x-setup-secret": "super_secure_setup_secret_passphrase_2026",
      },
    });
    assert.strictEqual(resSecretHeader.status, 200);
    const dataSecretHeader = await resSecretHeader.json();
    assert.strictEqual(dataSecretHeader.success, true);
    assert.ok(dataSecretHeader.authUrl);

    // Scenario C: Request with authenticated Admin JWT -> 200 OK
    const jwtSecret = process.env.JWT_SECRET || "vaidyasthana_development_jwt_secret_key_32bytes";
    const adminToken = jwt.sign(
      { id: new mongoose.Types.ObjectId().toString(), role: "admin", name: "System Admin" },
      jwtSecret,
      { expiresIn: "1h" }
    );

    const resAdminJwt = await fetch(`${baseUrl}/api/auth/google/authorize`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
    });
    assert.strictEqual(resAdminJwt.status, 200);
    const dataAdminJwt = await resAdminJwt.json();
    assert.strictEqual(dataAdminJwt.success, true);
    assert.ok(dataAdminJwt.authUrl);

    // Scenario D: Request with patient JWT (not admin) -> 403 Forbidden
    const patientToken = jwt.sign(
      { id: new mongoose.Types.ObjectId().toString(), role: "patient", name: "Regular Patient" },
      jwtSecret,
      { expiresIn: "1h" }
    );
    const resPatientJwt = await fetch(`${baseUrl}/api/auth/google/authorize`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${patientToken}`,
      },
    });
    assert.strictEqual(resPatientJwt.status, 403);
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 6: Callback Error Handling (Google Access Denied)
    // -------------------------------------------------------------------
    console.log("Testing 6: Google OAuth callback user denial (access_denied) handling... ");
    const resAccessDenied = await fetch(
      `${baseUrl}/api/auth/google/callback?error=access_denied&error_description=User+declined+permission`,
      { headers: { Accept: "application/json" } }
    );
    assert.strictEqual(resAccessDenied.status, 400);
    const dataAccessDenied = await resAccessDenied.json();
    assert.strictEqual(dataAccessDenied.code, "GOOGLE_OAUTH_ERROR");
    assert.strictEqual(dataAccessDenied.error, "access_denied");
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 7: Callback Missing Parameters & Invalid State
    // -------------------------------------------------------------------
    console.log("Testing 7: Callback missing code or invalid state parameter... ");
    const resNoParams = await fetch(`${baseUrl}/api/auth/google/callback`, {
      headers: { Accept: "application/json" },
    });
    assert.strictEqual(resNoParams.status, 400);

    const resForgedState = await fetch(
      `${baseUrl}/api/auth/google/callback?code=mock_code_123&state=unrecognized_state_456`,
      { headers: { Accept: "application/json" } }
    );
    assert.strictEqual(resForgedState.status, 400);
    const dataForgedState = await resForgedState.json();
    assert.strictEqual(dataForgedState.code, "INVALID_STATE");
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 8: Code Exchange Failure (Missing Refresh Token)
    // -------------------------------------------------------------------
    console.log("Testing 8: Missing refresh token rejection & recovery explanation... ");
    _resetOAuthStates();
    const testState1 = generateOAuthState({ adminId: "admin_1" });

    // Mock OAuth2Client where Google only returns access_token without refresh_token
    const mockClientNoRefresh = {
      getToken: async () => ({
        tokens: {
          access_token: "mock_access_token_only",
          token_type: "Bearer",
          scope: "https://www.googleapis.com/auth/gmail.send",
          // refresh_token deliberately missing!
        },
      }),
    };

    let missingRefreshError = null;
    try {
      await exchangeCodeAndVerifySender({
        code: "mock_code_no_refresh",
        state: testState1,
        injectedOAuth2Client: mockClientNoRefresh,
      });
    } catch (err) {
      missingRefreshError = err;
    }

    assert.ok(missingRefreshError);
    assert.strictEqual(missingRefreshError.code, "MISSING_REFRESH_TOKEN");
    assert.ok(missingRefreshError.message.includes("Google did not issue a refresh token"));
    assert.ok(missingRefreshError.recoveryGuidance.includes("prompt=consent"));
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 9: Sender Account Mismatch Scenario
    // -------------------------------------------------------------------
    console.log("Testing 9: Sender account mismatch detection and masking... ");
    _resetOAuthStates();
    const testState2 = generateOAuthState({ adminId: "admin_1" });
    process.env.GMAIL_SENDER_ADDRESS = "vaidyasthana.clinical@gmail.com";

    // Mock OAuth2Client returning an authorized account that does NOT match GMAIL_SENDER_ADDRESS
    const mismatchedPayload = { email: "unauthorized.impostor@gmail.com" };
    const fakeIdToken = `header.${Buffer.from(JSON.stringify(mismatchedPayload)).toString("base64url")}.sig`;

    const mockClientMismatch = {
      getToken: async () => ({
        tokens: {
          access_token: "mock_access_token_ok",
          refresh_token: "1//04mock_refresh_token_ok",
          id_token: fakeIdToken,
          scope: "https://www.googleapis.com/auth/gmail.send",
        },
      }),
    };

    let mismatchError = null;
    try {
      await exchangeCodeAndVerifySender({
        code: "mock_code_mismatch",
        state: testState2,
        injectedOAuth2Client: mockClientMismatch,
      });
    } catch (err) {
      mismatchError = err;
    }

    assert.ok(mismatchError);
    assert.strictEqual(mismatchError.code, "SENDER_ACCOUNT_MISMATCH");
    assert.strictEqual(mismatchError.authorizedAccount, maskEmail("unauthorized.impostor@gmail.com"));
    assert.strictEqual(mismatchError.expectedAccount, maskEmail("vaidyasthana.clinical@gmail.com"));
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 10: Successful Token Acquisition & Sensitive Secret Redaction
    // -------------------------------------------------------------------
    console.log("Testing 10: Successful authorization, encryption, and zero secret leakage... ");
    _resetOAuthStates();
    const testStateSuccess = generateOAuthState({ adminId: "admin_1" });
    process.env.GMAIL_SENDER_ADDRESS = "vaidyasthana.clinical@gmail.com";

    const matchedPayload = { email: "vaidyasthana.clinical@gmail.com" };
    const validIdToken = `header.${Buffer.from(JSON.stringify(matchedPayload)).toString("base64url")}.sig`;
    const realMockRefreshToken = "1//04mock_Valid_Secret_RefreshToken_XYZ987654";

    const mockClientSuccess = {
      getToken: async () => ({
        tokens: {
          access_token: "mock_access_token_super_secret",
          refresh_token: realMockRefreshToken,
          id_token: validIdToken,
          scope: "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email",
        },
      }),
    };

    const successResult = await exchangeCodeAndVerifySender({
      code: "valid_auth_code_123",
      state: testStateSuccess,
      injectedOAuth2Client: mockClientSuccess,
    });

    assert.strictEqual(successResult.success, true);
    assert.strictEqual(successResult.provider, "GMAIL_OAUTH2");
    assert.strictEqual(successResult.authorizedEmail, maskEmail("vaidyasthana.clinical@gmail.com"));
    // CRITICAL SECURITY ASSERTIONS: Neither refresh token nor access token are present in result!
    assert.strictEqual(successResult.refreshToken, undefined);
    assert.strictEqual(successResult.access_token, undefined);
    assert.strictEqual(successResult.client_secret, undefined);

    // Verify stored token can be retrieved decrypted by internal service
    const storedDecrypted = await getStoredRefreshToken("vaidyasthana.clinical@gmail.com");
    assert.strictEqual(storedDecrypted, realMockRefreshToken);
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 11: Integration Status Endpoint (Safe Inspection)
    // -------------------------------------------------------------------
    console.log("Testing 11: Integration status reporting without secret leakage... ");
    const statusData = await getGmailOAuthStatus();
    assert.strictEqual(statusData.provider, "GMAIL_OAUTH2");
    assert.strictEqual(statusData.configured, true);
    assert.strictEqual(statusData.authorized, true);
    assert.strictEqual(statusData.senderAddress, maskEmail("vaidyasthana.clinical@gmail.com"));
    // No tokens leaked
    assert.strictEqual(statusData.refreshToken, undefined);
    assert.strictEqual(statusData.clientSecret, undefined);
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 12: Revocation Endpoint
    // -------------------------------------------------------------------
    console.log("Testing 12: Gmail OAuth token revocation... ");
    const revokeResult = await revokeGmailAuthorization();
    assert.strictEqual(revokeResult.success, true);

    const postRevokeStatus = await getGmailOAuthStatus();
    assert.strictEqual(postRevokeStatus.authorized, false);
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 13: Registered Route Paths & 404 Bypass Verification
    // -------------------------------------------------------------------
    console.log("Testing 13: Verifying all registered route paths and 404 bypass... ");
    process.env.GMAIL_SETUP_SECRET = "super_secure_setup_secret_passphrase_2026";

    // 13a: Direct GET /api/auth/google/authorize with query params (e.g. from chatgpt link)
    const resAuthWithUtm = await fetch(
      `${baseUrl}/api/auth/google/authorize?utm_source=chatgpt.com&setupSecret=super_secure_setup_secret_passphrase_2026`,
      { headers: { Accept: "application/json" } }
    );
    assert.strictEqual(resAuthWithUtm.status, 200);
    const dataAuthWithUtm = await resAuthWithUtm.json();
    assert.strictEqual(dataAuthWithUtm.success, true);
    assert.ok(dataAuthWithUtm.authUrl);

    // 13b: GET /api/auth/google root
    const resGoogleRoot = await fetch(
      `${baseUrl}/api/auth/google?setupSecret=super_secure_setup_secret_passphrase_2026`,
      { headers: { Accept: "application/json" } }
    );
    assert.strictEqual(resGoogleRoot.status, 200);
    const dataGoogleRoot = await resGoogleRoot.json();
    assert.strictEqual(dataGoogleRoot.success, true);

    // 13c: GET /api/auth/google/url
    const resGoogleUrl = await fetch(
      `${baseUrl}/api/auth/google/url?setupSecret=super_secure_setup_secret_passphrase_2026`,
      { headers: { Accept: "application/json" } }
    );
    assert.strictEqual(resGoogleUrl.status, 200);

    // 13d: GET /api/auth/google/status
    const resGoogleStatus = await fetch(
      `${baseUrl}/api/auth/google/status?setupSecret=super_secure_setup_secret_passphrase_2026`,
      { headers: { Accept: "application/json" } }
    );
    assert.strictEqual(resGoogleStatus.status, 200);

    // 13e: POST /api/auth/google/revoke
    const resGoogleRevoke = await fetch(
      `${baseUrl}/api/auth/google/revoke?setupSecret=super_secure_setup_secret_passphrase_2026`,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
      }
    );
    assert.strictEqual(resGoogleRevoke.status, 200);

    // 13f: Browser redirect mode (?redirect=true) returns HTTP 302 to accounts.google.com
    const resRedirect = await fetch(
      `${baseUrl}/api/auth/google/authorize?setupSecret=super_secure_setup_secret_passphrase_2026&redirect=true`,
      { redirect: "manual" }
    );
    assert.strictEqual(resRedirect.status, 302);
    const redirectLocation = resRedirect.headers.get("location");
    assert.ok(redirectLocation && redirectLocation.includes("accounts.google.com"));

    // 13g: Browser HTML card mode when no redirect=true
    const resBrowserHtml = await fetch(
      `${baseUrl}/api/auth/google/authorize?setupSecret=super_secure_setup_secret_passphrase_2026`,
      { headers: { Accept: "text/html" } }
    );
    assert.strictEqual(resBrowserHtml.status, 200);
    const htmlText = await resBrowserHtml.text();
    assert.ok(htmlText.includes("Google OAuth Authorization Ready"));
    assert.ok(htmlText.includes("Proceed to Google Account Authorization"));

    // 13h: Browser HTML card mode when unauthorized (403 HTML card)
    const resBrowserForbidden = await fetch(`${baseUrl}/api/auth/google/authorize`, {
      headers: { Accept: "text/html" },
    });
    assert.strictEqual(resBrowserForbidden.status, 403);
    const forbiddenHtml = await resBrowserForbidden.text();
    assert.ok(forbiddenHtml.includes("Administrative Setup Access Required"));

    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 14: MIME Message Construction (buildRfc2822Message) & Dispatch
    // -------------------------------------------------------------------
    console.log("Testing 14: RFC 2822 MIME message construction & base64url encoding... ");
    const mimeBase64 = buildRfc2822Message({
      from: '"Vaidyasthana Healthcare" <vaidyasthana.clinical@gmail.com>',
      to: "patient.anita@example.org",
      subject: "Vaidyasthana - Password Reset Request",
      text: "Plain text reset instructions",
      html: "<p>HTML reset instructions</p>",
    });

    assert.strictEqual(typeof mimeBase64, "string");
    // Decode from base64url and verify RFC 2822 headers
    const decodedMime = Buffer.from(mimeBase64, "base64url").toString("utf8");
    assert.ok(decodedMime.includes("From: \"Vaidyasthana Healthcare\" <vaidyasthana.clinical@gmail.com>"));
    assert.ok(decodedMime.includes("To: patient.anita@example.org"));
    assert.ok(decodedMime.includes("Subject: =?UTF-8?B?"));
    assert.ok(decodedMime.includes("MIME-Version: 1.0"));
    assert.ok(decodedMime.includes("Content-Type: multipart/alternative; boundary="));
    assert.ok(decodedMime.includes("Plain text reset instructions"));
    assert.ok(decodedMime.includes("<p>HTML reset instructions</p>"));

    // Mock Gmail API client for successful message dispatch
    let sentPayload = null;
    const mockGmailClientSuccess = {
      users: {
        messages: {
          send: async ({ userId, requestBody }) => {
            sentPayload = { userId, requestBody };
            return {
              data: {
                id: "gmail_msg_success_1234567890",
                threadId: "gmail_thread_0987654321",
                labelIds: ["SENT"],
              },
            };
          },
        },
      },
    };

    _setInMemoryRefreshToken({
      senderAddress: "vaidyasthana.clinical@gmail.com",
      refreshToken: "1//04mock_valid_refresh_token_for_sending",
    });

    const gmailSendResult = await sendViaGmailOAuth({
      to: "patient.anita@example.org",
      name: "Anita Sharma",
      resetUrl: "https://vaidyasthana-frontend.onrender.com/reset-password/sample_token_xyz",
      expiresInMinutes: 15,
      injectedGmailClient: mockGmailClientSuccess,
    });

    assert.strictEqual(gmailSendResult.accepted, true);
    assert.strictEqual(gmailSendResult.delivered, false);
    assert.strictEqual(gmailSendResult.providerAccepted, true);
    assert.strictEqual(gmailSendResult.provider, "GMAIL_OAUTH2");
    assert.strictEqual(gmailSendResult.messageId, "gmail_msg_success_1234567890");
    assert.strictEqual(gmailSendResult.reason, "PROVIDER_ACCEPTED");
    assert.ok(sentPayload);
    assert.strictEqual(sentPayload.userId, "me");
    assert.ok(sentPayload.requestBody.raw);
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 15: Outbound Provider Priority: Gmail OAuth Selected Over Resend
    // -------------------------------------------------------------------
    console.log("Testing 15: Outbound provider priority (Gmail OAuth prioritized over Resend)... ");
    process.env.RESEND_API_KEY = "re_mock_resend_key_that_should_not_be_chosen";
    process.env.GMAIL_SENDER_ADDRESS = "vaidyasthana.clinical@gmail.com";
    _setInMemoryRefreshToken({
      senderAddress: "vaidyasthana.clinical@gmail.com",
      refreshToken: "1//04mock_active_refresh_token",
    });

    // isEmailConfigured and getEmailProvider check
    assert.strictEqual(isEmailConfigured(), true);
    assert.strictEqual(getEmailProvider(), "GMAIL_OAUTH2");

    // sendPasswordResetEmail routes to Gmail OAuth
    const routedResult = await sendPasswordResetEmail({
      to: "patient.rohit@example.org",
      name: "Rohit Verma",
      resetUrl: "https://vaidyasthana-frontend.onrender.com/reset-password/token123",
      injectedGmailClient: mockGmailClientSuccess,
    });

    assert.strictEqual(routedResult.accepted, true);
    assert.strictEqual(routedResult.provider, "GMAIL_OAUTH2");
    assert.strictEqual(routedResult.messageId, "gmail_msg_success_1234567890");
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 16: Gmail API Failure Handling (Token Revoked / invalid_grant)
    // -------------------------------------------------------------------
    console.log("Testing 16: Gmail API token revocation handling (invalid_grant) and non-fallback... ");
    const mockGmailClientRevoked = {
      users: {
        messages: {
          send: async () => {
            const err = new Error("invalid_grant: Token has been expired or revoked.");
            err.code = 400;
            throw err;
          },
        },
      },
    };

    // Even though RESEND_API_KEY is present, Requirement 7 mandates:
    // Do NOT silently fall back to Resend testing domain for patient recipients!
    const revokedResult = await sendPasswordResetEmail({
      to: "patient.sunita@example.org",
      name: "Sunita Patel",
      resetUrl: "https://vaidyasthana-frontend.onrender.com/reset-password/token456",
      injectedGmailClient: mockGmailClientRevoked,
    });

    assert.strictEqual(revokedResult.accepted, false);
    assert.strictEqual(revokedResult.providerAccepted, false);
    assert.strictEqual(revokedResult.provider, "GMAIL_OAUTH2"); // Did NOT fall back to Resend!
    assert.strictEqual(revokedResult.reason, "GMAIL_TOKEN_REVOKED");
    assert.ok(revokedResult.diagnosticMessage.includes("re-authorize"));
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 17: Gmail API Rate Limit / Quota Exceeded Handling
    // -------------------------------------------------------------------
    console.log("Testing 17: Gmail API quota / rate limit (429) handling... ");
    _setInMemoryRefreshToken({
      senderAddress: "vaidyasthana.clinical@gmail.com",
      refreshToken: "1//04mock_valid_token_2",
    });

    const mockGmailClientQuota = {
      users: {
        messages: {
          send: async () => {
            const err = new Error("User Rate Limit Exceeded. Daily sending quota reached.");
            err.status = 429;
            throw err;
          },
        },
      },
    };

    const quotaResult = await sendViaGmailOAuth({
      to: "patient.amit@example.org",
      name: "Amit Kumar",
      resetUrl: "https://vaidyasthana-frontend.onrender.com/reset-password/token789",
      injectedGmailClient: mockGmailClientQuota,
    });

    assert.strictEqual(quotaResult.accepted, false);
    assert.strictEqual(quotaResult.provider, "GMAIL_OAUTH2");
    assert.strictEqual(quotaResult.reason, "GMAIL_QUOTA_EXCEEDED");
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 18: Missing or Unauthorized Refresh Token Safe Rejection
    // -------------------------------------------------------------------
    console.log("Testing 18: Missing or unauthorized refresh token handling... ");
    _resetOAuthStates(); // Clears in-memory cache
    if (mongoose.connection.readyState === 1) {
      await mongoose.model("EmailIntegration").deleteMany({
        provider: "GMAIL_OAUTH2",
        senderAddress: "vaidyasthana.clinical@gmail.com",
      });
    }

    const unauthResult = await sendViaGmailOAuth({
      to: "patient.deepa@example.org",
      name: "Deepa Nair",
      resetUrl: "https://vaidyasthana-frontend.onrender.com/reset-password/unauth123",
      injectedGmailClient: mockGmailClientSuccess,
    });

    assert.strictEqual(unauthResult.accepted, false);
    assert.strictEqual(unauthResult.reason, "GMAIL_NOT_AUTHORIZED");
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 19: Sender Identity Mismatch Protection
    // -------------------------------------------------------------------
    console.log("Testing 19: Sender identity mismatch protection... ");
    _setInMemoryRefreshToken({
      senderAddress: "old.authorized.doctor@gmail.com",
      refreshToken: "1//04mock_token_for_old_account",
    });
    // Environment configured with a different sender address
    process.env.GMAIL_SENDER_ADDRESS = "vaidyasthana.clinical@gmail.com";

    const mismatchSendResult = await sendViaGmailOAuth({
      to: "patient@example.org",
      name: "Patient",
      resetUrl: "https://vaidyasthana-frontend.onrender.com/reset-password/mismatch123",
      injectedGmailClient: mockGmailClientSuccess,
    });

    assert.strictEqual(mismatchSendResult.accepted, false);
    assert.strictEqual(mismatchSendResult.reason, "GMAIL_NOT_AUTHORIZED");
    console.log("✔ PASSED");

    // -------------------------------------------------------------------
    // Test 20: Full End-to-End Forgot-Password Route with Gmail OAuth Active
    // -------------------------------------------------------------------
    console.log("Testing 20: Full POST /api/auth/forgot-password route integration... ");
    process.env.GMAIL_SENDER_ADDRESS = "vaidyasthana.clinical@gmail.com";
    _setInMemoryRefreshToken({
      senderAddress: "vaidyasthana.clinical@gmail.com",
      refreshToken: "1//04mock_verified_e2e_token",
    });

    // Ensure a test user exists in Atlas
    const testEmail = `patient.e2e.${Date.now()}@vaidyasthana.internal`;
    if (mongoose.connection.readyState === 1) {
      await User.findOneAndUpdate(
        { email: testEmail },
        {
          name: "E2E Test Patient",
          email: testEmail,
          password: "HashedPassword123!",
          role: "patient",
          status: "active",
          phoneNumber: "9876543210",
          address: "123 Clinical Way",
        },
        { upsert: true, returnDocument: "after" }
      );
    }

    const resForgotPassword = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: testEmail }),
    });

    assert.strictEqual(resForgotPassword.status, 200);
    const dataForgot = await resForgotPassword.json();
    assert.strictEqual(dataForgot.success, true);
    assert.strictEqual(
      dataForgot.message,
      "If an account exists for this email, password reset instructions will be sent."
    );
    assert.strictEqual(dataForgot.emailDelivery.configured, true);
    assert.strictEqual(dataForgot.emailDelivery.provider, "GMAIL_OAUTH2");
    assert.strictEqual(dataForgot.emailDelivery.accepted, true);

    // Verify token was hashed with SHA-256 and has future expiry in MongoDB Atlas
    if (mongoose.connection.readyState === 1) {
      const dbUser = await User.findOne({ email: testEmail });
      assert.ok(dbUser);
      assert.ok(dbUser.resetPasswordToken);
      assert.strictEqual(dbUser.resetPasswordToken.length, 64); // SHA-256 hex is 64 chars
      assert.ok(dbUser.resetPasswordExpires);
      assert.ok(new Date(dbUser.resetPasswordExpires) > new Date());
      // Clean up test user
      await User.deleteOne({ email: testEmail });
    }
    console.log("✔ PASSED");

    console.log("\n=================================================");
    console.log("  ALL 20 GOOGLE OAUTH 2.0 GMAIL TESTS PASSED!    ");
    console.log("=================================================\n");
  } catch (err) {
    console.error("\n❌ GOOGLE OAUTH TEST SUITE FAILED:", err);
    throw err;
  } finally {
    process.env = envSnapshot;
    if (server) {
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  }
};

runTestSuite().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
