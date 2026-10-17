const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const app = require("../src/app");

let server;
let baseUrl;

test.before(async () => {
  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`Test server running at ${baseUrl}`);
      resolve();
    });
  });
});

test.after(async () => {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
});

test("GET / - returns platform info and available endpoints", async () => {
  const res = await fetch(`${baseUrl}/`);
  const data = await res.json();

  assert.strictEqual(res.status, 200);
  assert.strictEqual(data.name, "Vaidyasthana Healthcare Platform API");
  assert.strictEqual(data.status, "online");
  assert.ok(data.endpoints);
});

test("GET /api/health - returns system and cloud service configurations", async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  const data = await res.json();

  assert.strictEqual(res.status, 200);
  assert.strictEqual(data.success, true);
  assert.ok(data.services);
  assert.ok("database" in data.services);
  assert.ok("azureBlobStorage" in data.services);
  assert.ok("azureDocumentIntelligence" in data.services);
  assert.ok("azureOpenAI" in data.services);
});

test("POST /api/auth/register - rejects registration with missing required fields", async () => {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "test@example.com" }),
  });
  const data = await res.json();

  assert.strictEqual(res.status, 400);
  assert.strictEqual(data.success, false);
});

test("POST /api/auth/login - handles offline database gracefully with 503 or rejects invalid credentials with 401", async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "nonexistent@user.com", password: "wrongpassword" }),
  });
  const data = await res.json();

  assert.ok(res.status === 503 || res.status === 401);
  assert.strictEqual(data.success, false);
});

test("Protected route access - rejects /api/reports without token", async () => {
  const res = await fetch(`${baseUrl}/api/reports`);
  const data = await res.json();

  assert.strictEqual(res.status, 401);
  assert.strictEqual(data.success, false);
});

test("Protected route access - rejects /api/appointments without token", async () => {
  const res = await fetch(`${baseUrl}/api/appointments`);
  const data = await res.json();

  assert.strictEqual(res.status, 401);
  assert.strictEqual(data.success, false);
});

test("POST /api/contact - rejects submission with missing fields", async () => {
  const res = await fetch(`${baseUrl}/api/contact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Alice" }),
  });
  const data = await res.json();

  assert.strictEqual(res.status, 400);
  assert.strictEqual(data.success, false);
});

test("Protected route access - rejects /upload/status/:id without token", async () => {
  const res = await fetch(`${baseUrl}/upload/status/60c72b2f9b1d8b2bad000001`);
  const data = await res.json();

  assert.strictEqual(res.status, 401);
  assert.strictEqual(data.success, false);
});

test("Protected route access - rejects POST /upload/retry/:id without token", async () => {
  const res = await fetch(`${baseUrl}/upload/retry/60c72b2f9b1d8b2bad000001`, {
    method: "POST",
  });
  const data = await res.json();

  assert.strictEqual(res.status, 401);
  assert.strictEqual(data.success, false);
});

test("404 Route - returns consistent JSON 404 response", async () => {
  const res = await fetch(`${baseUrl}/api/non-existent-endpoint`);
  const data = await res.json();

  assert.strictEqual(res.status, 404);
  assert.strictEqual(data.success, false);
});
