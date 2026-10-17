const OpenAI = require("openai");

const getApiKey = () =>
  process.env.AZURE_OPENAI_KEY ||
  process.env.AZURE_OPENAI_API_KEY ||
  "";

const getEndpoint = () =>
  process.env.AZURE_OPENAI_ENDPOINT ||
  "";

const getDeployment = () =>
  process.env.AZURE_OPENAI_DEPLOYMENT ||
  "gpt-4";

const isAzureOpenAIConfigured = () => {
  return Boolean(getApiKey() && getEndpoint());
};

let _client = null;

const getOpenAIClient = () => {
  if (!isAzureOpenAIConfigured()) {
    return null;
  }
  if (!_client) {
    const rawEndpoint = getEndpoint().replace(/\/+$/, "");
    const baseURL = rawEndpoint.includes("/openai")
      ? rawEndpoint
      : `${rawEndpoint}/openai/v1`;

    _client = new OpenAI({
      apiKey: getApiKey(),
      baseURL,
    });
  }
  return _client;
};

const defaultAnalysisResult = (reason = "Azure OpenAI service is not configured.") => ({
  summary: reason,
  severity: "Unknown",
  abnormalParameters: [],
  possibleDiseases: [],
  recommendations: [
    "Consult your healthcare provider to review your laboratory and diagnostic findings.",
  ],
  dietPlan: [
    "Maintain a balanced, nutrient-rich diet appropriate for your general health status.",
  ],
  exercisePlan: [
    "Engage in moderate physical activity according to your physician's guidance.",
  ],
  doctorAdvice:
    "Always discuss medical test results directly with your certified physician before taking any action.",
  followUpTests: [],
  disclaimer:
    "Medical Disclaimer: This AI-assisted analysis is for informational educational purposes only. It is not a clinical diagnosis or treatment prescription. Always consult a qualified medical professional.",
  generatedAt: new Date(),
});

const cleanOcrText = (text = "") => {
  if (!text) return "";
  return text
    // Replace 3+ consecutive newlines with 2
    .replace(/\n{3,}/g, "\n\n")
    // Replace excessive horizontal whitespace with a single space
    .replace(/[ \t]{3,}/g, " ")
    .trim();
};

const analyzeMedicalReport = async (ocrText) => {
  const cleanedText = cleanOcrText(ocrText);

  if (!cleanedText) {
    return defaultAnalysisResult("No readable text found in document for analysis.");
  }

  const client = getOpenAIClient();
  if (!client) {
    console.warn("⚠️ Azure OpenAI credentials are not configured. Returning safe baseline guidance.");
    return defaultAnalysisResult("Azure OpenAI credentials are not configured in environment.");
  }

  const systemPrompt = `
You are a cautious, clinical-grade medical document analysis assistant.
Analyze the provided medical report text carefully, concisely, and objectively.
Strict Rules:
1. Distinguish documented lab values from conjecture. Do not fabricate values or reference ranges not mentioned.
2. Flag values explicitly reported as high, low, or abnormal.
3. Provide plain-language explanations of complex terminology.
4. Provide structured lifestyle and dietary suggestions that are safe and non-prescriptive.
5. Emphasize medical safety and encourage direct consultation with a certified doctor.
6. Keep summary and field descriptions clear, informative, and clinically focused without redundant filler.

Return ONLY a valid JSON object matching this exact structure:
{
  "summary": "Clear, objective plain-language overview of the report findings",
  "severity": "Low | Medium | High | Unknown",
  "abnormalParameters": [
    {
      "parameter": "Parameter Name",
      "value": "Measured Value with units",
      "normalRange": "Normal reference range if stated or standard",
      "status": "High | Low | Critical | Abnormal",
      "reason": "Brief clinical explanation of why this parameter matters"
    }
  ],
  "possibleDiseases": ["Identified health conditions or risks to discuss"],
  "recommendations": ["Key preventive steps or discussion points for the clinician"],
  "dietPlan": ["General nutritional recommendations supported by the findings"],
  "exercisePlan": ["Appropriate lifestyle or physical activity considerations"],
  "doctorAdvice": "Specific questions and recommendations to bring to the next doctor appointment",
  "followUpTests": ["Standard follow-up monitoring tests suggested for these indicators"]
}
`;

  const startTime = Date.now();
  try {
    console.log("🚀 Submitting document OCR to Azure OpenAI for clinical evaluation...");

    const response = await client.chat.completions.create({
      model: getDeployment(),
      temperature: 0.1,
      max_tokens: 1500,
      response_format: {
        type: "json_object",
      },
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: `Here is the medical report text:\n\n${cleanedText}`,
        },
      ],
    });

    const durationMs = Date.now() - startTime;
    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("Empty response received from Azure OpenAI");
    }

    const parsed = JSON.parse(content);
    parsed.generatedAt = new Date();
    parsed.durationMs = durationMs;
    parsed.disclaimer =
      "Medical Disclaimer: This AI analysis is intended solely for patient understanding and preparation for consultation with a healthcare professional. It is not an official diagnostic report.";

    return parsed;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    console.error(`❌ Azure OpenAI Analysis Error (${durationMs}ms):`, error.message);
    const fallback = defaultAnalysisResult(
      `AI analysis could not complete: ${error.message}`
    );
    fallback.durationMs = durationMs;
    return fallback;
  }
};

module.exports = {
  isAzureOpenAIConfigured,
  analyzeMedicalReport,
  defaultAnalysisResult,
};