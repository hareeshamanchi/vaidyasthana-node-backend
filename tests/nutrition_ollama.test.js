require("dotenv").config();
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const app = require("../src/app");
const {
  validateNutritionResponse,
  checkOllamaAvailability,
} = require("../src/services/ollamaNutritionService");

describe("Phase 5: Ollama AI Nutrition Analysis Suite", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("GET /api/nutrition/status accurately reports Ollama configuration and live reachability", async () => {
    const res = await fetch(`${baseUrl}/api/nutrition/status`);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(typeof body.available, "boolean");
    assert.strictEqual(typeof body.baseUrl, "string");
    assert.strictEqual(typeof body.configuredModel, "string");
  });

  test("POST /api/nutrition/generate returns 503 OLLAMA_UNAVAILABLE when daemon is offline instead of fake data", async () => {
    // Point to an inactive test port to ensure unavailable behavior is verified
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:54321";

    const res = await fetch(`${baseUrl}/api/nutrition/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        biometrics: {
          age: 32,
          gender: "Male",
          height: 175,
          weight: 74,
          activityLevel: "1.375",
          dietaryPreference: "Vegetarian",
          healthGoal: "General Wellness & Immunity",
        },
      }),
    });

    assert.strictEqual(res.status, 503);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.error, "OLLAMA_UNAVAILABLE");
    assert.ok(body.message.includes("Ollama"));
    assert.ok(body.fallbackPlan);
    assert.strictEqual(body.fallbackPlan.engine, "Deterministic (Mifflin-St Jeor)");
    assert.ok(body.fallbackPlan.metabolicTargets.targetCalories > 0);
  });

  test("validateNutritionResponse enforces strict schema, portion sizes, macro ratios, and safety disclosures", () => {
    const rawSyntheticOllamaOutput = {
      summary: "Vegetarian diet targeting cardiovascular health and glycemic balance.",
      clinicalRationale: "Mifflin-St Jeor target caloric maintenance with high-fiber legumes.",
      metabolicTargets: {
        bmr: 1680,
        tdee: 2310,
        targetCalories: 2300,
        calorieAdjustmentReason: "Maintenance intake.",
      },
      macronutrients: {
        proteinGrams: 115,
        carbGrams: 285,
        fatGrams: 64,
        fiberGrams: 35,
        waterLiters: "2.8",
        macroRationale: "20% Protein, 50% Carbohydrates, 30% Healthy Unsaturated Fats.",
      },
      mealSchedule: [
        {
          timeSlot: "08:00 AM",
          mealName: "High-Fiber Breakfast",
          items: ["Steel-cut oats with chia seeds and almond milk", "1 bowl fresh papaya"],
          portionGrams: "300g total",
          clinicalPurpose: "Soluble beta-glucan fiber to support lipid profile.",
        },
      ],
      foodsToEmphasize: ["Lentils", "Spinach", "Walnuts"],
      foodsToLimit: ["Refined bakery items", "Excess table salt"],
      missingDataDisclosures: ["Fasting lipid panel not provided."],
    };

    const validated = validateNutritionResponse(rawSyntheticOllamaOutput, {
      age: 32,
      gender: "Male",
      height: 175,
      weight: 74,
    });

    assert.strictEqual(validated.engine, "Ollama Local LLM");
    assert.strictEqual(validated.metabolicTargets.bmr, 1680);
    assert.strictEqual(validated.macronutrients.proteinGrams, 115);
    assert.strictEqual(validated.mealSchedule.length, 1);
    assert.strictEqual(validated.mealSchedule[0].timeSlot, "08:00 AM");
    assert.ok(validated.disclaimer.includes("Nutritional Disclaimer"));
    assert.strictEqual(validated.sourceBiometrics.age, 32);
  });
});
