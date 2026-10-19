const OpenAI = require("openai");

const SUPPORTED_LANGUAGES = [
  { code: "en", name: "English", nativeName: "English" },
  { code: "te", name: "Telugu", nativeName: "తెలుగు" },
  { code: "hi", name: "Hindi", nativeName: "हिन्दी" },
  { code: "ta", name: "Tamil", nativeName: "தமிழ்" },
  { code: "kn", name: "Kannada", nativeName: "ಕನ್ನಡ" },
  { code: "ml", name: "Malayalam", nativeName: "മലയാളം" },
  { code: "es", name: "Spanish", nativeName: "Español" },
];

const MEDICAL_DISCLAIMER =
  "Medical Translation Disclaimer: This translation is AI-assisted and provided for convenience. It does not replace the original clinical record or professional medical advice. Always consult a qualified physician or healthcare provider for medical interpretation.";

const getApiKey = () =>
  process.env.AZURE_OPENAI_KEY ||
  process.env.AZURE_OPENAI_API_KEY ||
  process.env.OPENAI_API_KEY ||
  "";

const getEndpoint = () => process.env.AZURE_OPENAI_ENDPOINT || "";

const getDeployment = () =>
  process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4";

const isAzureOpenAIConfigured = () => {
  return Boolean(getApiKey() && (getEndpoint() || process.env.OPENAI_API_KEY));
};

let _openAIClient = null;

const getClient = () => {
  if (!isAzureOpenAIConfigured()) {
    return null;
  }
  if (!_openAIClient) {
    const apiKey = getApiKey();
    const endpoint = getEndpoint();

    if (endpoint) {
      const rawEndpoint = endpoint.replace(/\/+$/, "");
      const baseURL = rawEndpoint.includes("/openai")
        ? rawEndpoint
        : `${rawEndpoint}/openai/v1`;

      _openAIClient = new OpenAI({
        apiKey,
        baseURL,
      });
    } else {
      _openAIClient = new OpenAI({
        apiKey,
      });
    }
  }
  return _openAIClient;
};

// In-memory cache for translated strings to prevent duplicate API calls
// Key: `${targetLang}:${sourceLang}:${normalizedText}`
const MAX_CACHE_ENTRIES = 2000;
const translationCache = new Map();

const getCacheKey = (targetLang, sourceLang, text) => {
  return `${targetLang.toLowerCase()}:${sourceLang.toLowerCase()}:${text.trim()}`;
};

const getFromCache = (targetLang, sourceLang, text) => {
  const key = getCacheKey(targetLang, sourceLang, text);
  return translationCache.get(key) || null;
};

const setInCache = (targetLang, sourceLang, text, value) => {
  if (translationCache.size >= MAX_CACHE_ENTRIES) {
    // Delete oldest entry (first key in iteration)
    const firstKey = translationCache.keys().next().value;
    translationCache.delete(firstKey);
  }
  const key = getCacheKey(targetLang, sourceLang, text);
  translationCache.set(key, value);
};

// Curated healthcare glossary and UI fallback phrases for offline or backup mode
const HEALTHCARE_FALLBACK_GLOSSARY = {
  te: {
    "Home": "హోమ్",
    "Appointments": "అపాయింట్‌మెంట్లు",
    "Consultations": "సంప్రదింపులు",
    "Medical Vault": "మెడికల్ వాల్ట్",
    "Health Timeline": "ఆరోగ్య టైమ్‌లైన్",
    "Timeline": "టైమ్‌లైన్",
    "Diet Plan": "ఆహార ప్రణాళిక",
    "Insurance": "భీమా",
    "Contact": "సంప్రదించండి",
    "Sign In": "లాగిన్",
    "Sign Out": "లాగ్ అవుట్",
    "Get Started": "ప్రారంభించండి",
    "Dashboard": "డాష్‌బోర్డ్",
    "Patient Dashboard": "రోగి డాష్‌బోర్డ్",
    "Doctor Dashboard": "వైద్యుల డాష్‌బోర్డ్",
    "Admin Portal": "అడ్మిన్ పోర్టల్",
    "Confirmed": "నిర్ధారించబడింది",
    "Scheduled": "షెడ్యూల్ చేయబడింది",
    "Completed": "పూర్తయింది",
    "Cancelled": "రద్దు చేయబడింది",
    "Pending": "పెండింగ్‌లో ఉంది",
    "Taken": "తీసుకున్నారు",
    "Skipped": "దాటవేయబడింది",
    "Abnormal": "అసాధారణం",
    "Normal": "సాధారణం",
    "High": "ఎక్కువ",
    "Low": "తక్కువ",
    "Laboratory Report": "ప్రయోగశాల నివేదిక (ల్యాబ్)",
    "Prescription": "ప్రిస్క్రిప్షన్ (మందుల చీటి)",
    "Cardiology": "కార్డియాలజీ (గుండె)",
    "Radiology": "రేడియాలజీ (స్కాన్లు/ఎక్స్-రే)",
    "Pathology": "పాథాలజీ",
    "General Medicine": "జనరల్ మెడిసిన్",
    "Severity": "తీవ్రత",
    "Recommendations": "సిఫార్సులు",
    "Possible Diseases": "సంభావ్య ఆరోగ్య పరిస్థితులు",
    "Doctor Advice": "వైద్యుల సలహా",
    "Follow-up Tests": "తదుపరి వైద్య పరీక్షలు",
    "Upload Medical Report": "మెడికల్ రిపోర్ట్‌ను అప్‌లోడ్ చేయండి",
  },
  hi: {
    "Home": "होम",
    "Appointments": "नियुक्तियां",
    "Consultations": "परामर्श",
    "Medical Vault": "मेडिकल वॉल्ट",
    "Health Timeline": "स्वास्थ्य समयरेखा",
    "Timeline": "समयरेखा",
    "Diet Plan": "आहार योजना",
    "Insurance": "बीमा",
    "Contact": "संपर्क करें",
    "Sign In": "साइन इन",
    "Sign Out": "साइन आउट",
    "Get Started": "शुरू करें",
    "Dashboard": "डैशबोर्ड",
    "Patient Dashboard": "रोगी डैशबोर्ड",
    "Doctor Dashboard": "डॉक्टर डैशबोर्ड",
    "Admin Portal": "एडमिन पोर्टल",
    "Confirmed": "पुष्टि की गई",
    "Scheduled": "शेड्यूल किया गया",
    "Completed": "पूर्ण हुआ",
    "Cancelled": "रद्द किया गया",
    "Pending": "लंबित",
    "Taken": "लिया गया",
    "Skipped": "छोड़ा गया",
    "Abnormal": "असामान्य",
    "Normal": "सामान्य",
    "High": "उच्च",
    "Low": "निम्न",
    "Laboratory Report": "प्रयोगशाला रिपोर्ट",
    "Prescription": "नुस्खा (प्रिस्क्रिप्शन)",
    "Cardiology": "कार्डियोलॉजी",
    "Radiology": "रेडियोलॉजी",
    "Pathology": "पैथोलॉजी",
    "General Medicine": "सामान्य चिकित्सा",
    "Severity": "गंभीरता",
    "Recommendations": "सिफारिशें",
    "Possible Diseases": "संभावित स्थितियां",
    "Doctor Advice": "चिकित्सक की सलाह",
    "Follow-up Tests": "अनुवर्ती परीक्षण",
    "Upload Medical Report": "मेडिकल रिपोर्ट अपलोड करें",
  },
  ta: {
    "Home": "முகப்பு",
    "Appointments": "சந்திப்புகள்",
    "Consultations": "ஆலோசனைகள்",
    "Medical Vault": "மருத்துவ பெட்டகம்",
    "Health Timeline": "சுகாதார காலவரிசை",
    "Timeline": "காலவரிசை",
    "Diet Plan": "உணவுத் திட்டம்",
    "Insurance": "காப்பீடு",
    "Contact": "தொடர்பு கொள்ள",
    "Sign In": "உள்நுழைய",
    "Sign Out": "வெளியேறு",
    "Get Started": "தொடங்குங்கள்",
    "Confirmed": "உறுதிப்படுத்தப்பட்டது",
    "Scheduled": "திட்டமிடப்பட்டது",
    "Completed": "முடிந்தது",
    "Cancelled": "ரத்து செய்யப்பட்டது",
    "Abnormal": "இயல்புக்கு மாறானது",
    "Normal": "இயல்பானது",
  },
  es: {
    "Home": "Inicio",
    "Appointments": "Citas",
    "Consultations": "Consultas",
    "Medical Vault": "Bóveda Médica",
    "Health Timeline": "Línea de Tiempo de Salud",
    "Timeline": "Línea de Tiempo",
    "Diet Plan": "Plan de Dieta",
    "Insurance": "Seguro",
    "Contact": "Contacto",
    "Sign In": "Iniciar Sesión",
    "Sign Out": "Cerrar Sesión",
    "Get Started": "Comenzar",
    "Confirmed": "Confirmado",
    "Scheduled": "Programado",
    "Completed": "Completado",
    "Cancelled": "Cancelado",
    "Abnormal": "Anormal",
    "Normal": "Normal",
  },
};

/**
 * Extracts clinically sensitive terms (medication names, lab units, dosages, numbers, dates)
 * that must be preserved exactly without alteration.
 */
const extractPreservedTerms = (text = "") => {
  const preserved = new Set();

  // Dosages & Units: longer multi-part units first so alternation doesn't prematurely match prefixes
  const unitRegex = /\b\d+(\.\d+)?(\/\d+(\.\d+)?)?\s*(mmol\/L|mg\/dL|g\/dL|cells\/mcL|tablets?|capsules?|mcg|µg|mg|kg|ml|IU|mmHg|bpm|fl|pg|%|g|l)\b/gi;
  let match;
  while ((match = unitRegex.exec(text)) !== null) {
    preserved.add(match[0].trim());
  }

  // Common medication patterns (generic/brand endings or uppercase words preceding dosages)
  const medRegex = /\b[A-Z][a-zA-Z]*(?:statin|formin|olol|pril|sartan|cillin|mycin|mab|prazole|oxacin|azole|zepam|pine|gliptin|gliflozin|vir|sone|dopa|mol|ide)\b/g;
  while ((match = medRegex.exec(text)) !== null) {
    preserved.add(match[0].trim());
  }

  // Capitalized medicine names directly preceding dosage (e.g. "Paracetamol 650 mg")
  const drugDosageRegex = /\b([A-Z][a-zA-Z]{2,})\s+\d+(\.\d+)?\s*(?:mg|mcg|ml|g|tablets?)\b/g;
  while ((match = drugDosageRegex.exec(text)) !== null) {
    if (match[1]) preserved.add(match[1].trim());
  }

  return Array.from(preserved);
};

/**
 * Validates whether the language code is supported.
 */
const isSupportedLanguage = (code = "") => {
  const normalized = code.trim().toLowerCase();
  return SUPPORTED_LANGUAGES.some((lang) => lang.code.toLowerCase() === normalized);
};

const getLanguageDetails = (code = "") => {
  const normalized = code.trim().toLowerCase();
  return SUPPORTED_LANGUAGES.find((lang) => lang.code.toLowerCase() === normalized) || null;
};

/**
 * Translates a single text string using Azure OpenAI with specialized healthcare prompt,
 * falling back gracefully to offline glossary or original text if service is unavailable.
 */
const translateSingle = async ({
  text,
  targetLanguage,
  sourceLanguage = "en",
  context = "general",
}) => {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) {
    return {
      originalText: text || "",
      translatedText: text || "",
      sourceLanguage,
      targetLanguage,
      preservedTerms: [],
      disclaimer: MEDICAL_DISCLAIMER,
      cached: false,
    };
  }

  const normTarget = targetLanguage.toLowerCase().trim();
  const normSource = (sourceLanguage || "en").toLowerCase().trim();

  // If source and target are identical, return immediately
  if (normTarget === normSource) {
    return {
      originalText: trimmed,
      translatedText: trimmed,
      sourceLanguage: normSource,
      targetLanguage: normTarget,
      preservedTerms: [],
      disclaimer: MEDICAL_DISCLAIMER,
      cached: false,
    };
  }

  // Check in-memory cache
  const cached = getFromCache(normTarget, normSource, trimmed);
  if (cached) {
    return {
      ...cached,
      cached: true,
    };
  }

  const preservedTerms = extractPreservedTerms(trimmed);
  const targetLangDetails = getLanguageDetails(normTarget);
  const targetLangName = targetLangDetails ? `${targetLangDetails.name} (${targetLangDetails.nativeName})` : normTarget;

  // Check if text is a known single word/phrase in healthcare fallback glossary
  const glossaryMap = HEALTHCARE_FALLBACK_GLOSSARY[normTarget];
  if (glossaryMap && glossaryMap[trimmed]) {
    const result = {
      originalText: trimmed,
      translatedText: glossaryMap[trimmed],
      sourceLanguage: normSource,
      targetLanguage: normTarget,
      preservedTerms,
      disclaimer: MEDICAL_DISCLAIMER,
      cached: false,
    };
    setInCache(normTarget, normSource, trimmed, result);
    return result;
  }

  const client = getClient();
  if (client) {
    try {
      const systemPrompt = `You are a specialized medical translation engine for the Vaidyasthana Healthcare Platform.
Translate user text from ${normSource} to ${targetLangName}.

STRICT CLINICAL TRANSLATION RULES:
1. MEDICAL TERMINOLOGY PRESERVATION:
   - Do NOT translate, transliterate, or alter generic or brand medicine names (e.g., Metformin, Atorvastatin, Amoxicillin, Paracetamol).
   - Keep medical abbreviations (e.g., CBC, HbA1c, ECG, MRI, CT, BP, SpO2) intact in Latin characters.
2. NUMBERS, DOSAGES & LAB VALUES:
   - Preserve all numbers, units (mg, mL, mmHg, etc.), reference ranges, dates, and times exactly as written.
3. CONTEXT & TONE:
   - Context: ${context}.
   - Provide natural, culturally respectful, and clear translation for patient instructions, symptoms, recommendations, and interface labels.
   - Do not add conversational fluff or introductory explanations.
4. JSON OUTPUT:
   Return strictly valid JSON:
   {
     "translatedText": "<translated string here>",
     "preservedTerms": ["<list of terms kept in original language>"]
   }`;

      const response = await client.chat.completions.create({
        model: getDeployment(),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: trimmed },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      const responseContent = response.choices?.[0]?.message?.content;
      if (responseContent) {
        const parsed = JSON.parse(responseContent);
        const translatedText = parsed.translatedText || trimmed;
        const combinedPreserved = Array.from(
          new Set([...preservedTerms, ...(parsed.preservedTerms || [])])
        );

        const result = {
          originalText: trimmed,
          translatedText,
          sourceLanguage: normSource,
          targetLanguage: normTarget,
          preservedTerms: combinedPreserved,
          disclaimer: MEDICAL_DISCLAIMER,
          cached: false,
        };

        setInCache(normTarget, normSource, trimmed, result);
        return result;
      }
    } catch (err) {
      console.warn("[SAFE_LOG] Azure OpenAI translation failed or timed out. Falling back to graceful translation:", err.message);
    }
  }

  // Graceful fallback when AI is not configured or fails
  // Uses word-by-word glossary mapping if available, or returns safe original with preserved terms
  let translatedText = trimmed;
  if (glossaryMap) {
    // Check if partial phrases can be replaced
    let textCopy = trimmed;
    for (const [enKey, transVal] of Object.entries(glossaryMap)) {
      const reg = new RegExp(`\\b${enKey}\\b`, "gi");
      textCopy = textCopy.replace(reg, transVal);
    }
    translatedText = textCopy;
  }

  const result = {
    originalText: trimmed,
    translatedText,
    sourceLanguage: normSource,
    targetLanguage: normTarget,
    preservedTerms,
    disclaimer: MEDICAL_DISCLAIMER,
    cached: false,
    fallbackUsed: true,
  };

  setInCache(normTarget, normSource, trimmed, result);
  return result;
};

/**
 * Translates an array of texts.
 */
const translateBatch = async ({
  texts,
  targetLanguage,
  sourceLanguage = "en",
  context = "general",
}) => {
  if (!Array.isArray(texts)) {
    return [];
  }

  const results = [];
  for (const item of texts) {
    const res = await translateSingle({
      text: item,
      targetLanguage,
      sourceLanguage,
      context,
    });
    results.push(res);
  }

  return results;
};

module.exports = {
  SUPPORTED_LANGUAGES,
  MEDICAL_DISCLAIMER,
  isSupportedLanguage,
  getLanguageDetails,
  extractPreservedTerms,
  translateSingle,
  translateBatch,
  clearCache: () => translationCache.clear(),
};
