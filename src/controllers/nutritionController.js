const {
  checkOllamaAvailability,
  generateNutritionPlan,
  getOllamaBaseUrl,
  getOllamaModel,
} = require("../services/ollamaNutritionService");
const Report = require("../models/Report");
const mongoose = require("mongoose");
const { isDoctorAuthorizedForPatient } = require("../services/clinicalAuthorizationService");

const isDbConnected = () => mongoose.connection.readyState === 1;

/**
 * GET /api/nutrition/status
 * Check local Ollama AI service availability and installed models
 */
const getNutritionServiceStatus = async (req, res) => {
  try {
    const status = await checkOllamaAvailability();
    return res.status(200).json({
      success: true,
      service: "Ollama Clinical Nutrition Synthesis",
      ...status,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to query Ollama service status.",
      error: error.message,
    });
  }
};

/**
 * Deterministic Mifflin-St Jeor metabolic computation fallback
 */
const computeDeterministicMetabolicPlan = (biometrics = {}) => {
  const age = parseFloat(biometrics.age) || 30;
  const height = parseFloat(biometrics.height) || 170;
  const weight = parseFloat(biometrics.weight) || 70;
  const activity = parseFloat(biometrics.activityLevel) || 1.375;

  let bmr = 10 * weight + 6.25 * height - 5 * age;
  if (biometrics.gender === "Male") {
    bmr += 5;
  } else {
    bmr -= 161;
  }

  const tdee = Math.round(bmr * activity);
  let targetCalories = tdee;
  let reason = "Caloric intake calibrated to match maintenance energy expenditure.";

  if (biometrics.healthGoal === "Weight Loss / Calorie Deficit") {
    targetCalories = Math.max(1200, Math.round(tdee - 450));
    reason = "Target calibrated to a safe, sustainable caloric deficit of ~450 kcal/day.";
  } else if (biometrics.healthGoal === "Muscle Building / Hypertrophy") {
    targetCalories = Math.round(tdee + 350);
    reason = "Target calibrated to a mild hypertrophic caloric surplus of ~350 kcal/day.";
  }

  const proteinGrams = Math.round((targetCalories * 0.25) / 4);
  const carbGrams = Math.round((targetCalories * 0.5) / 4);
  const fatGrams = Math.round((targetCalories * 0.25) / 9);
  const waterLiters = (weight * 0.035).toFixed(1);

  const isVeg = (biometrics.dietaryPreference || "Vegetarian").toLowerCase().includes("veg");

  const mealSchedule = [
    {
      timeSlot: "08:00 AM - 09:00 AM",
      mealName: "Nutrient-Dense Breakfast",
      portionGrams: "Approx 350g",
      items: isVeg
        ? ["Rolled oats with chia seeds & almond milk", "1 bowl fresh papaya or apple slices"]
        : ["2 poached eggs with whole wheat toast", "1 cup fresh citrus fruit salad"],
      clinicalPurpose: "Glycemic stabilization and morning satiety",
    },
    {
      timeSlot: "11:00 AM",
      mealName: "Mid-Morning Micronutrient Booster",
      portionGrams: "Approx 200g",
      items: ["Fresh spiced buttermilk or coconut water (200ml)", "Handful of roasted pumpkin seeds (20g)"],
      clinicalPurpose: "Hydration, electrolytes and essential trace minerals",
    },
    {
      timeSlot: "01:00 PM - 02:00 PM",
      mealName: "Balanced High-Fiber Lunch",
      portionGrams: "Approx 450g",
      items: isVeg
        ? ["Fresh mixed salad with cucumber, tomato & lemon", "2 multigrain rotis with yellow dal tadka and green beans"]
        : ["Grilled herb chicken fillet (150g)", "1 cup brown rice with sautéed seasonal greens"],
      clinicalPurpose: "Sustained postprandial glucose control and complete amino acids",
    },
    {
      timeSlot: "05:00 PM",
      mealName: "Evening Protein Snack",
      portionGrams: "Approx 60g",
      items: ["Herbal green tea (unsweetened)", "Roasted lotus seeds (makhana) or steamed sprouts with cumin"],
      clinicalPurpose: "Antioxidant replenishment and craving prevention",
    },
    {
      timeSlot: "07:30 PM - 08:30 PM",
      mealName: "Light Restorative Dinner",
      portionGrams: "Approx 350g",
      items: isVeg
        ? ["Warm clear vegetable soup with ginger", "1 bowl moong dal khichdi with mixed vegetable raita"]
        : ["Pan-seared fish with steamed broccoli & zucchini", "Small baked sweet potato"],
      clinicalPurpose: "Digestive recovery and uninterrupted nocturnal sleep",
    },
  ];

  return {
    engine: "Deterministic (Mifflin-St Jeor)",
    metabolicTargets: {
      bmr: Math.round(bmr),
      tdee,
      targetCalories,
      calorieAdjustmentReason: reason,
    },
    macronutrients: {
      proteinGrams,
      carbGrams,
      fatGrams,
      fiberGrams: 30,
      waterLiters,
      macroRationale: "Standard clinical 25% Protein / 50% Carbohydrates / 25% Fat distribution.",
    },
    mealSchedule,
    foodsToEmphasize: [
      "Whole unrefined grains (Oats, Jowar, Quinoa)",
      "Cruciferous vegetables & dark leafy greens",
      "Lean protein sources (Pulses, Paneer, Fish, Eggs)",
      "Adequate hydration (minimum 2.5L clean water)",
    ],
    foodsToLimit: [
      "Ultra-processed convenience foods and refined flour",
      "Sugar-sweetened beverages and syrups",
      "Deep-fried items high in trans fats",
      "Excessive added sodium (> 2300 mg/day)",
    ],
    disclaimer:
      "Nutritional Disclaimer: Deterministic calculation based on standard Mifflin-St Jeor equation. Does not replace individualized clinical dietetic consultation.",
  };
};

/**
 * POST /api/nutrition/generate
 * Synthesize AI clinical nutrition plan using Ollama
 */
const generateNutrition = async (req, res) => {
  try {
    const {
      biometrics = {},
      reportId,
      labParameters: clientLabParams,
      clinicalNotes,
    } = req.body;

    let extractedLabParams = Array.isArray(clientLabParams) ? [...clientLabParams] : [];

    // If reportId provided, retrieve verified lab data from database
    if (reportId) {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required to link medical reports.",
        });
      }

      if (!mongoose.Types.ObjectId.isValid(reportId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid report ID format.",
        });
      }

      if (isDbConnected()) {
        const report = await Report.findById(reportId);
        if (!report) {
          return res.status(404).json({
            success: false,
            message: "Report not found.",
          });
        }

        const isOwner = report.userId.toString() === req.user.id.toString();
        const isAdmin = req.user.role === "admin";
        let isAuthorized = isOwner || isAdmin;

        if (req.user.role === "doctor") {
          isAuthorized = await isDoctorAuthorizedForPatient(req.user, report.userId);
        }

        if (!isAuthorized) {
          return res.status(403).json({
            success: false,
            message: "Forbidden: You are not authorized to access this patient's medical report for nutrition analysis.",
          });
        }

        if (report.aiAnalysis?.abnormalParameters?.length) {
          extractedLabParams = [
            ...extractedLabParams,
            ...report.aiAnalysis.abnormalParameters,
          ];
        }
      }
    }

    try {
      const plan = await generateNutritionPlan({
        biometrics,
        labParameters: extractedLabParams,
        clinicalNotes,
        sourceReportId: reportId || null,
      });

      return res.status(200).json({
        success: true,
        plan,
      });
    } catch (ollamaErr) {
      if (ollamaErr.code === "OLLAMA_UNAVAILABLE" || ollamaErr.code === "OLLAMA_NETWORK_ERROR") {
        return res.status(503).json({
          success: false,
          error: "OLLAMA_UNAVAILABLE",
          message:
            `Local Ollama AI service is not running or unreachable at ${getOllamaBaseUrl()}. ` +
            `To enable AI-powered nutrition synthesis, please start Ollama locally ('ollama serve') and ensure model '${getOllamaModel()}' is installed.`,
          configuredModel: getOllamaModel(),
          baseUrl: getOllamaBaseUrl(),
          fallbackPlan: computeDeterministicMetabolicPlan(biometrics),
        });
      }

      console.error("Nutrition Generation Error:", ollamaErr.message);
      return res.status(500).json({
        success: false,
        message: `Nutrition generation failed: ${ollamaErr.message}`,
      });
    }
  } catch (error) {
    console.error("Generate Nutrition Request Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error during nutrition plan generation.",
    });
  }
};

module.exports = {
  getNutritionServiceStatus,
  generateNutrition,
  computeDeterministicMetabolicPlan,
};
