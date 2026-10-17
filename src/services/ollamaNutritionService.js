const http = require("http");
const https = require("https");

const getOllamaBaseUrl = () =>
  (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");

const getOllamaModel = () =>
  process.env.OLLAMA_MODEL || "llama3";

const getOllamaTimeout = () =>
  parseInt(process.env.OLLAMA_TIMEOUT_MS || "30000", 10);

/**
 * Check if the local Ollama service is reachable and has the target model installed.
 */
const checkOllamaAvailability = async () => {
  const baseUrl = getOllamaBaseUrl();
  const configuredModel = getOllamaModel();
  const timeoutMs = 5000;

  return new Promise((resolve) => {
    try {
      const url = new URL(`${baseUrl}/api/tags`);
      const client = url.protocol === "https:" ? https : http;

      const req = client.get(url, { timeout: timeoutMs }, (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const data = JSON.parse(raw);
              const models = (data.models || []).map((m) => m.name || m.model);
              const isInstalled = models.some(
                (m) => m === configuredModel || m.startsWith(`${configuredModel}:`)
              );
              return resolve({
                available: true,
                baseUrl,
                configuredModel,
                models,
                isModelInstalled: isInstalled,
                status: isInstalled
                  ? "ready"
                  : `Model '${configuredModel}' not found in installed models. Run 'ollama pull ${configuredModel}'`,
              });
            } catch {
              return resolve({
                available: true,
                baseUrl,
                configuredModel,
                models: [],
                isModelInstalled: false,
                status: "Ollama responded with invalid tags JSON",
              });
            }
          }
          return resolve({
            available: false,
            baseUrl,
            configuredModel,
            models: [],
            isModelInstalled: false,
            error: `Ollama service returned HTTP ${res.statusCode}`,
          });
        });
      });

      req.on("error", (err) => {
        resolve({
          available: false,
          baseUrl,
          configuredModel,
          models: [],
          isModelInstalled: false,
          error: `Ollama service unreachable at ${baseUrl}: ${err.message}`,
        });
      });

      req.on("timeout", () => {
        req.destroy();
        resolve({
          available: false,
          baseUrl,
          configuredModel,
          models: [],
          isModelInstalled: false,
          error: `Connection to Ollama service at ${baseUrl} timed out (${timeoutMs}ms)`,
        });
      });
    } catch (err) {
      resolve({
        available: false,
        baseUrl,
        configuredModel,
        models: [],
        isModelInstalled: false,
        error: `Invalid Ollama URL configuration: ${err.message}`,
      });
    }
  });
};

/**
 * Validates and normalizes structured nutrition JSON returned by Ollama.
 */
const validateNutritionResponse = (rawJson, biometrics = {}) => {
  if (!rawJson || typeof rawJson !== "object") {
    throw new Error("Invalid or empty JSON structure returned by model");
  }

  // Ensure mandatory clinical nutrition fields
  const validated = {
    summary:
      typeof rawJson.summary === "string" && rawJson.summary.trim()
        ? rawJson.summary.trim()
        : "Evidence-based nutritional regimen synthesized from physiological parameters.",
    clinicalRationale:
      typeof rawJson.clinicalRationale === "string"
        ? rawJson.clinicalRationale
        : "Plan formulated using metabolic equations and nutritional safety limits.",
    metabolicTargets: {
      bmr: Number(rawJson.metabolicTargets?.bmr) || 0,
      tdee: Number(rawJson.metabolicTargets?.tdee) || 0,
      targetCalories: Number(rawJson.metabolicTargets?.targetCalories) || 0,
      calorieAdjustmentReason:
        rawJson.metabolicTargets?.calorieAdjustmentReason ||
        "Caloric balance based on selected wellness objective.",
    },
    macronutrients: {
      proteinGrams: Number(rawJson.macronutrients?.proteinGrams) || 0,
      carbGrams: Number(rawJson.macronutrients?.carbGrams) || 0,
      fatGrams: Number(rawJson.macronutrients?.fatGrams) || 0,
      fiberGrams: Number(rawJson.macronutrients?.fiberGrams) || 30,
      waterLiters:
        typeof rawJson.macronutrients?.waterLiters === "string" ||
        typeof rawJson.macronutrients?.waterLiters === "number"
          ? String(rawJson.macronutrients.waterLiters)
          : "2.5 - 3.0",
      macroRationale:
        rawJson.macronutrients?.macroRationale ||
        "Macronutrient partitioning balanced for optimal glycemic index and lean mass.",
    },
    mealSchedule: Array.isArray(rawJson.mealSchedule)
      ? rawJson.mealSchedule.map((meal) => ({
          timeSlot: meal.timeSlot || "Scheduled Time",
          mealName: meal.mealName || "Nutrient-Dense Meal",
          items: Array.isArray(meal.items) ? meal.items : [meal.items || "Balanced meal"],
          portionGrams: meal.portionGrams || "Standard portion",
          clinicalPurpose: meal.clinicalPurpose || "General nourishment",
        }))
      : [],
    foodsToEmphasize: Array.isArray(rawJson.foodsToEmphasize)
      ? rawJson.foodsToEmphasize
      : ["Whole grains", "Green leafy vegetables", "Lean proteins", "Hydration"],
    foodsToLimit: Array.isArray(rawJson.foodsToLimit)
      ? rawJson.foodsToLimit
      : ["Refined sugars", "Excess sodium", "Trans fats", "Ultra-processed foods"],
    missingDataDisclosures: Array.isArray(rawJson.missingDataDisclosures)
      ? rawJson.missingDataDisclosures
      : [
          "Recent fasting glucose / HbA1c not provided (assumed normoglycemic).",
          "Lipid profile not provided (cholesterol values not factored into plan).",
          "Renal function panel not provided (standard safe protein intake applied).",
        ],
    disclaimer:
      "Nutritional Disclaimer: This AI-generated dietary framework is for general wellness and educational purposes. It does not replace medical nutrition therapy for acute or chronic conditions (diabetes, chronic kidney disease, cardiac disease). Consult a certified clinical dietitian before making significant dietary changes.",
    generatedAt: new Date(),
    engine: "Ollama Local LLM",
    model: getOllamaModel(),
    sourceBiometrics: {
      age: biometrics.age,
      gender: biometrics.gender,
      heightCm: biometrics.height,
      weightKg: biometrics.weight,
      activityLevel: biometrics.activityLevel,
      dietaryPreference: biometrics.dietaryPreference,
      healthGoal: biometrics.healthGoal,
    },
  };

  return validated;
};

/**
 * Generate a personalized, clinical-grade nutrition and diet plan using local Ollama.
 */
const generateNutritionPlan = async ({
  biometrics = {},
  labParameters = [],
  clinicalNotes = "",
  sourceReportId = null,
} = {}) => {
  // Step 1: Pre-flight check availability of Ollama
  const availability = await checkOllamaAvailability();
  if (!availability.available) {
    const error = new Error(
      `Local Ollama AI service is unreachable at ${availability.baseUrl}. Please start the Ollama daemon with 'ollama serve' and ensure model '${availability.configuredModel}' is installed.`
    );
    error.code = "OLLAMA_UNAVAILABLE";
    error.details = availability;
    throw error;
  }

  const model = availability.configuredModel;
  const baseUrl = availability.baseUrl;
  const timeoutMs = getOllamaTimeout();

  // Step 2: Build rigorous clinical prompt
  const biometricsDesc = `
- Age: ${biometrics.age || "Not specified (assumed 30)"} years
- Biological Gender: ${biometrics.gender || "Not specified"}
- Height: ${biometrics.height || "Not specified"} cm
- Weight: ${biometrics.weight || "Not specified"} kg
- Physical Activity Level: ${biometrics.activityLevel || "1.375 (Light)"}
- Dietary Preference: ${biometrics.dietaryPreference || "Balanced / Omnivore"}
- Health & Wellness Goal: ${biometrics.healthGoal || "General Wellness & Immunity"}
`.trim();

  const labFindingsDesc =
    Array.isArray(labParameters) && labParameters.length > 0
      ? `Documented Lab Parameters:\n${labParameters
          .map(
            (p) =>
              `- ${p.parameter}: ${p.value} (Ref: ${p.normalRange || "N/A"}) [Status: ${p.status || "Recorded"}]`
          )
          .join("\n")}`
      : "No documented laboratory values provided.";

  const prompt = `
You are a certified Clinical Nutrition Specialist and Metabolic Health Physician.
Formulate a precise, evidence-based nutrition and meal plan customized to the patient's biometrics and documented lab findings.

CRITICAL CLINICAL & SCIENTIFIC RULES:
1. NEVER invent or fabricate lab values, diagnoses, medical history, or allergies not documented above.
2. If certain clinical biomarkers (e.g. lipid panel, fasting blood glucose, renal function eGFR/creatinine) are missing, EXPLICITLY state them under "missingDataDisclosures".
3. Use reliable food-composition databases and provide defined portion sizes (grams, household measures) for every meal.
4. Calculate energy expenditure using the Mifflin-St Jeor equation. Clearly label all estimated caloric and macronutrient numbers.
5. Respect the patient's dietary preference (${biometrics.dietaryPreference || "Standard"}).
6. Return ONLY valid JSON adhering strictly to the schema below. No markdown fences, no conversational text.

Required JSON Structure:
{
  "summary": "Clinical overview of dietary focus and caloric rationale",
  "clinicalRationale": "Detailed physiological justification for recommended nutrient distribution",
  "metabolicTargets": {
    "bmr": 1600,
    "tdee": 2200,
    "targetCalories": 1900,
    "calorieAdjustmentReason": "Specific metabolic rationale"
  },
  "macronutrients": {
    "proteinGrams": 110,
    "carbGrams": 220,
    "fatGrams": 55,
    "fiberGrams": 32,
    "waterLiters": "2.8",
    "macroRationale": "Rationale for protein, carbohydrate, and fat splits"
  },
  "mealSchedule": [
    {
      "timeSlot": "07:30 AM - 08:30 AM",
      "mealName": "Breakfast",
      "items": ["Specific food item 1 with description", "Specific food item 2"],
      "portionGrams": "Approx 350g total (e.g., 2 slices whole wheat toast, 2 eggs)",
      "clinicalPurpose": "Sustained morning glycemic stability and amino acid replenishment"
    }
  ],
  "foodsToEmphasize": ["Food 1", "Food 2", "Food 3"],
  "foodsToLimit": ["Food 1", "Food 2", "Food 3"],
  "missingDataDisclosures": ["Disclosure 1", "Disclosure 2"]
}

Patient Information:
${biometricsDesc}

${labFindingsDesc}

${clinicalNotes ? `Clinical Notes: ${clinicalNotes}` : ""}
`.trim();

  // Step 3: Dispatch HTTP request to Ollama
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(`${baseUrl}/api/generate`);
      const client = url.protocol === "https:" ? https : http;

      const payload = JSON.stringify({
        model,
        prompt,
        format: "json",
        stream: false,
        options: {
          temperature: 0.2,
          num_predict: 2048,
        },
      });

      const req = client.request(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
          timeout: timeoutMs,
        },
        (res) => {
          let responseText = "";
          res.on("data", (chunk) => (responseText += chunk));
          res.on("end", () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(
                new Error(
                  `Ollama responded with HTTP ${res.statusCode}: ${responseText.slice(0, 300)}`
                )
              );
            }

            try {
              const parsedWrapper = JSON.parse(responseText);
              const generatedContent = parsedWrapper.response;
              if (!generatedContent) {
                return reject(new Error("Ollama returned an empty response body"));
              }

              const parsedNutrition = JSON.parse(generatedContent);
              const validatedPlan = validateNutritionResponse(parsedNutrition, biometrics);
              if (sourceReportId) {
                validatedPlan.sourceReportId = sourceReportId;
              }
              resolve(validatedPlan);
            } catch (parseErr) {
              reject(
                new Error(
                  `Failed to parse structured JSON from Ollama output: ${parseErr.message}`
                )
              );
            }
          });
        }
      );

      req.on("error", (err) => {
        const error = new Error(`Network failure communicating with Ollama: ${err.message}`);
        error.code = "OLLAMA_NETWORK_ERROR";
        reject(error);
      });

      req.on("timeout", () => {
        req.destroy();
        const error = new Error(`Ollama generation timed out after ${timeoutMs}ms`);
        error.code = "OLLAMA_TIMEOUT";
        reject(error);
      });

      req.write(payload);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
};

module.exports = {
  getOllamaBaseUrl,
  getOllamaModel,
  checkOllamaAvailability,
  validateNutritionResponse,
  generateNutritionPlan,
};
