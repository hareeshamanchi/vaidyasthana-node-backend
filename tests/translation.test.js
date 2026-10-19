const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const app = require("../src/app");
const {
  SUPPORTED_LANGUAGES,
  MEDICAL_DISCLAIMER,
  clearCache,
  extractPreservedTerms,
} = require("../src/services/translationService");

let server;
let baseUrl;

test.before(async () => {
  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  clearCache();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
});

test.describe("Backend Translation API Suite (/api/translate)", () => {
  test("1. GET /api/translate/languages returns supported languages and medical disclaimer", async () => {
    const res = await fetch(`${baseUrl}/api/translate/languages`);
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(Array.isArray(data.languages));
    assert.ok(data.languages.length >= 5);

    const codes = data.languages.map((l) => l.code);
    assert.ok(codes.includes("en"), "English must be supported");
    assert.ok(codes.includes("te"), "Telugu must be supported");
    assert.ok(codes.includes("hi"), "Hindi must be supported");
    assert.ok(codes.includes("ta"), "Tamil must be supported");

    assert.ok(data.disclaimer.includes("Medical Translation Disclaimer"));
  });

  test("2. POST /api/translate rejects missing targetLanguage with 400", async () => {
    const res = await fetch(`${baseUrl}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello" }),
    });

    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.success, false);
    assert.ok(data.message.includes("targetLanguage"));
  });

  test("3. POST /api/translate rejects unsupported targetLanguage with 400", async () => {
    const res = await fetch(`${baseUrl}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello", targetLanguage: "xyz_invalid" }),
    });

    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.success, false);
    assert.ok(data.message.includes("Unsupported targetLanguage"));
  });

  test("4. POST /api/translate rejects request missing both text and texts with 400", async () => {
    const res = await fetch(`${baseUrl}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetLanguage: "te" }),
    });

    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.success, false);
    assert.ok(data.message.includes("required for translation"));
  });

  test("5. POST /api/translate rejects text exceeding 5000 characters with 400", async () => {
    const longText = "A".repeat(5001);
    const res = await fetch(`${baseUrl}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: longText, targetLanguage: "te" }),
    });

    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.success, false);
    assert.ok(data.message.includes("exceeds the maximum allowed limit"));
  });

  test("6. POST /api/translate rejects empty texts array with 400", async () => {
    const res = await fetch(`${baseUrl}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: [], targetLanguage: "te" }),
    });

    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.success, false);
    assert.ok(data.message.includes("cannot be empty"));
  });

  test("7. POST /api/translate returns original text when source and target are the same", async () => {
    const res = await fetch(`${baseUrl}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Vaidyasthana Dashboard", sourceLanguage: "en", targetLanguage: "en" }),
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.translatedText, "Vaidyasthana Dashboard");
  });

  test("8. POST /api/translate translates healthcare UI phrases to Telugu and caches response", async () => {
    clearCache();

    // First call (uncached)
    const res1 = await fetch(`${baseUrl}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Appointments", targetLanguage: "te" }),
    });

    assert.strictEqual(res1.status, 200);
    const data1 = await res1.json();
    assert.strictEqual(data1.success, true);
    assert.strictEqual(data1.targetLanguage, "te");
    assert.strictEqual(data1.translatedText, "అపాయింట్‌మెంట్లు");
    assert.strictEqual(data1.cached, false);
    assert.ok(data1.disclaimer.includes("Medical Translation Disclaimer"));

    // Second call should hit in-memory cache
    const res2 = await fetch(`${baseUrl}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Appointments", targetLanguage: "te" }),
    });

    assert.strictEqual(res2.status, 200);
    const data2 = await res2.json();
    assert.strictEqual(data2.success, true);
    assert.strictEqual(data2.translatedText, "అపాయింట్‌మెంట్లు");
    assert.strictEqual(data2.cached, true);
  });

  test("9. POST /api/translate translates healthcare UI phrases to Hindi", async () => {
    const res = await fetch(`${baseUrl}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Dashboard", targetLanguage: "hi" }),
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.targetLanguage, "hi");
    assert.strictEqual(data.translatedText, "डैशबोर्ड");
  });

  test("10. POST /api/translate preserves clinical dosages, units, and medicine names in preservedTerms", async () => {
    const clinicalText = "Take Metformin 500 mg twice daily. Blood pressure was 120/80 mmHg.";
    const res = await fetch(`${baseUrl}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: clinicalText, targetLanguage: "te", context: "clinical_report" }),
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(Array.isArray(data.preservedTerms));
    // Verify that "500 mg" and "Metformin" are detected in preserved terms
    const hasMetformin = data.preservedTerms.some((t) => t.includes("Metformin"));
    const hasDosage = data.preservedTerms.some((t) => t.includes("500 mg"));
    assert.ok(hasMetformin, "Metformin must be marked as preserved medical term");
    assert.ok(hasDosage, "500 mg must be marked as preserved dosage");
  });

  test("11. POST /api/translate supports batch translation array", async () => {
    const texts = ["Home", "Consultations", "Diet Plan"];
    const res = await fetch(`${baseUrl}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts, targetLanguage: "te" }),
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.count, 3);
    assert.strictEqual(data.translations.length, 3);
    assert.strictEqual(data.translations[0].translatedText, "హోమ్");
    assert.strictEqual(data.translations[1].translatedText, "సంప్రదింపులు");
    assert.strictEqual(data.translations[2].translatedText, "ఆహార ప్రణాళిక");
  });

  test("12. Unit test: extractPreservedTerms correctly identifies clinical entities", () => {
    const sample = "Patient prescribed Atorvastatin 20 mg and Amoxicillin 250 mg. Fasting glucose: 110 mg/dL.";
    const terms = extractPreservedTerms(sample);
    assert.ok(terms.includes("Atorvastatin"));
    assert.ok(terms.includes("Amoxicillin"));
    assert.ok(terms.includes("20 mg"));
    assert.ok(terms.includes("250 mg"));
    assert.ok(terms.includes("110 mg/dL"));
  });
});
