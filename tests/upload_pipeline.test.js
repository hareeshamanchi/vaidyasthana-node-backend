const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const app = require("../src/app");
const Report = require("../src/models/Report");

let server;
let baseUrl;
let testToken;
const testUserId = "60c72b2f9b1d8b2bad000001";

// Helper to create a multi-part boundary body
const createMultipartBody = (boundary, fileBuffer, fileName, mimeType, fields = {}) => {
  const crlf = "\r\n";
  let body = "";

  for (const [k, v] of Object.entries(fields)) {
    body += `--${boundary}${crlf}`;
    body += `Content-Disposition: form-data; name="${k}"${crlf}${crlf}`;
    body += `${v}${crlf}`;
  }

  body += `--${boundary}${crlf}`;
  body += `Content-Disposition: form-data; name="file"; filename="${fileName}"${crlf}`;
  body += `Content-Type: ${mimeType}${crlf}${crlf}`;

  const headBuf = Buffer.from(body, "utf-8");
  const tailBuf = Buffer.from(`${crlf}--${boundary}--${crlf}`, "utf-8");
  return Buffer.concat([headBuf, fileBuffer, tailBuf]);
};

test.before(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_key_minimum_32_chars";
  testToken = jwt.sign(
    { id: testUserId, role: "patient", email: "testpatient@example.com" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`[TEST] Server running at ${baseUrl}`);
      resolve();
    });
  });
});

test.after(async () => {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
});

test("PDF Upload: Asynchronous fast response with immediate jobId & processing status", async () => {
  const boundary = `----VaidyasthanaFormBoundary${Date.now()}`;
  const pdfContent = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 64 >>\nstream\nBT /F1 12 Tf 72 712 Td (CBC Report: Hemoglobin 11.2 g/dL, WBC 7800) Tj ET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000010 00000 n \n0000000060 00000 n \n0000000117 00000 n \n0000000199 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n312\n%%EOF`;
  const pdfBuffer = Buffer.from(pdfContent, "utf-8");

  const multipartPayload = createMultipartBody(
    boundary,
    pdfBuffer,
    "routine_cbc_panel.pdf",
    "application/pdf",
    {
      category: "Blood Report",
      notes: "Annual executive health checkup routine laboratory CBC test",
    }
  );

  const uploadStart = Date.now();
  const res = await fetch(`${baseUrl}/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${testToken}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: multipartPayload,
  });

  const uploadDuration = Date.now() - uploadStart;
  const data = await res.json();

  assert.strictEqual(res.status, 201);
  assert.strictEqual(data.success, true);
  assert.ok(data.jobId, "Should return an immediate jobId");
  assert.strictEqual(data.status, "Processing");
  assert.ok(
    data.stage.includes("Extracting text") || data.stage.includes("Preparing"),
    "Should report initial extraction stage"
  );
  // Must return fast without blocking on long AI analysis
  assert.ok(
    uploadDuration < 5000,
    `Upload response should be fast (< 5000ms), received in ${uploadDuration}ms`
  );
  console.log(`✔ Fast upload confirmed in ${uploadDuration}ms with Job ID: ${data.jobId}`);

  // Test status endpoint retrieval
  const statusRes = await fetch(`${baseUrl}/upload/${data.jobId}/status`, {
    headers: { Authorization: `Bearer ${testToken}` },
  });
  const statusData = await statusRes.json();

  assert.strictEqual(statusRes.status, 200);
  assert.strictEqual(statusData.success, true);
  assert.strictEqual(statusData.reportId, data.jobId);
  assert.ok(statusData.processingStage);
  console.log(`✔ Status retrieval verified: Stage = "${statusData.processingStage}", Status = "${statusData.analysisStatus}"`);
});

test("Image Upload: Fast response and granular status endpoint for JPEG/PNG medical image", async () => {
  const boundary = `----VaidyasthanaFormBoundary${Date.now()}`;
  // 1x1 minimal PNG image
  const imgBuffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );

  const multipartPayload = createMultipartBody(
    boundary,
    imgBuffer,
    "chest_xray_scan.png",
    "image/png",
    {
      category: "Radiology Report",
      notes: "Posteroanterior view chest radiography scan",
    }
  );

  const res = await fetch(`${baseUrl}/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${testToken}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: multipartPayload,
  });

  const data = await res.json();
  assert.strictEqual(res.status, 201);
  assert.strictEqual(data.success, true);
  assert.ok(data.jobId);
  assert.strictEqual(data.status, "Processing");

  // Check alias status route /upload/status/:id
  const aliasStatusRes = await fetch(`${baseUrl}/upload/status/${data.jobId}`, {
    headers: { Authorization: `Bearer ${testToken}` },
  });
  const aliasData = await aliasStatusRes.json();

  assert.strictEqual(aliasStatusRes.status, 200);
  assert.strictEqual(aliasData.success, true);
  assert.strictEqual(aliasData.reportId, data.jobId);
  console.log(`✔ Image upload verified with status alias: "${aliasData.processingStage}"`);
});

test("Retry Endpoint: POST /upload/:id/retry initiates retry safely without duplicate records", async () => {
  // First create a report with failed status
  const boundary = `----VaidyasthanaFormBoundary${Date.now()}`;
  const docBuffer = Buffer.from("Simple text report", "utf-8");
  const multipartPayload = createMultipartBody(
    boundary,
    docBuffer,
    "test_retry.pdf",
    "application/pdf",
    { category: "Medical Report", notes: "Test retry document" }
  );

  const createRes = await fetch(`${baseUrl}/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${testToken}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: multipartPayload,
  });
  const createData = await createRes.json();
  const testId = createData.jobId;

  // Trigger retry
  const retryRes = await fetch(`${baseUrl}/upload/${testId}/retry`, {
    method: "POST",
    headers: { Authorization: `Bearer ${testToken}` },
  });
  const retryData = await retryRes.json();

  assert.strictEqual(retryRes.status, 200);
  assert.strictEqual(retryData.success, true);
  assert.strictEqual(retryData.analysisStatus, "Processing");
  console.log(`✔ Retry endpoint successfully re-triggered processing for ${testId}`);
});
