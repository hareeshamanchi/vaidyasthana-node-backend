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

let _client = null;

const getOpenAIClient = () => {
  if (!getApiKey() || !getEndpoint()) {
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

// Fallback classifier using keyword heuristics if OpenAI is not available
const heuristicClassify = (text = "") => {
  const lower = text.toLowerCase();
  if (lower.includes("blood") || lower.includes("hemoglobin") || lower.includes("cbc")) {
    return { documentType: "Blood Report", isMedical: true };
  }
  if (lower.includes("urine") || lower.includes("urinalysis")) {
    return { documentType: "Urine Report", isMedical: true };
  }
  if (lower.includes("rx") || lower.includes("prescription") || lower.includes("dosage")) {
    return { documentType: "Prescription", isMedical: true };
  }
  if (lower.includes("mri") || lower.includes("magnetic resonance")) {
    return { documentType: "MRI Report", isMedical: true };
  }
  if (lower.includes("x-ray") || lower.includes("radiology") || lower.includes("ct scan")) {
    return { documentType: "Radiology Report", isMedical: true };
  }
  if (lower.includes("discharge") || lower.includes("admission")) {
    return { documentType: "Discharge Summary", isMedical: true };
  }
  if (lower.includes("insurance") || lower.includes("claim") || lower.includes("policy")) {
    return { documentType: "Insurance Claim", isMedical: true };
  }
  return { documentType: "Medical Report", isMedical: true };
};

const classifyDocument = async (ocrText) => {
  const client = getOpenAIClient();
  if (!client || !ocrText) {
    return heuristicClassify(ocrText);
  }

  try {
    const response = await client.chat.completions.create({
      model: getDeployment(),
      temperature: 0,
      response_format: {
        type: "json_object",
      },
      messages: [
        {
          role: "system",
          content: `You are an expert hospital document classifier.
Read the OCR text and return ONLY a JSON object:
{
  "documentType": "string",
  "isMedical": true
}
Possible document types:
Blood Report, Prescription, Discharge Summary, Radiology Report, MRI Report, CT Scan, Ultrasound, ECG, Medical Certificate, Insurance Claim, Invoice, Lab Report, Urine Report, Biopsy Report, Vaccination Record, Other`,
        },
        {
          role: "user",
          content: ocrText.slice(0, 3000),
        },
      ],
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.warn("Classification fallback due to:", error.message);
    return heuristicClassify(ocrText);
  }
};

module.exports = classifyDocument;