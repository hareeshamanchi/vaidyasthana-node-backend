const {
  SUPPORTED_LANGUAGES,
  MEDICAL_DISCLAIMER,
  isSupportedLanguage,
  translateSingle,
  translateBatch,
} = require("../services/translationService");

const MAX_SINGLE_TEXT_CHARS = 5000;
const MAX_BATCH_TEXT_CHARS = 10000;
const MAX_BATCH_ITEMS = 50;

/**
 * POST /api/translate
 * Translates clinical or interface text into the requested target language.
 */
const translate = async (req, res, next) => {
  try {
    const { text, texts, targetLanguage, sourceLanguage = "en", context = "general" } = req.body;

    if (!targetLanguage || typeof targetLanguage !== "string") {
      return res.status(400).json({
        success: false,
        message: "Field 'targetLanguage' is required and must be a valid language code (e.g., 'te', 'hi', 'en').",
      });
    }

    if (!isSupportedLanguage(targetLanguage)) {
      const allowed = SUPPORTED_LANGUAGES.map((l) => `${l.code} (${l.name})`).join(", ");
      return res.status(400).json({
        success: false,
        message: `Unsupported targetLanguage '${targetLanguage}'. Supported languages are: ${allowed}.`,
      });
    }

    // Handle batch texts array
    if (Array.isArray(texts)) {
      if (texts.length === 0) {
        return res.status(400).json({
          success: false,
          message: "The 'texts' array cannot be empty.",
        });
      }

      if (texts.length > MAX_BATCH_ITEMS) {
        return res.status(400).json({
          success: false,
          message: `The 'texts' array cannot contain more than ${MAX_BATCH_ITEMS} items per request.`,
        });
      }

      const totalChars = texts.reduce((sum, item) => sum + (typeof item === "string" ? item.length : 0), 0);
      if (totalChars > MAX_BATCH_TEXT_CHARS) {
        return res.status(400).json({
          success: false,
          message: `Total text length exceeds the maximum allowed limit of ${MAX_BATCH_TEXT_CHARS} characters for batch translation.`,
        });
      }

      const results = await translateBatch({
        texts,
        targetLanguage,
        sourceLanguage,
        context,
      });

      return res.status(200).json({
        success: true,
        targetLanguage,
        sourceLanguage,
        count: results.length,
        translations: results,
        disclaimer: MEDICAL_DISCLAIMER,
      });
    }

    // Handle single text string
    if (text === undefined || text === null) {
      return res.status(400).json({
        success: false,
        message: "Field 'text' or 'texts' is required for translation.",
      });
    }

    if (typeof text !== "string") {
      return res.status(400).json({
        success: false,
        message: "Field 'text' must be a string.",
      });
    }

    if (text.length > MAX_SINGLE_TEXT_CHARS) {
      return res.status(400).json({
        success: false,
        message: `Text length of ${text.length} characters exceeds the maximum allowed limit of ${MAX_SINGLE_TEXT_CHARS} characters.`,
      });
    }

    const result = await translateSingle({
      text,
      targetLanguage,
      sourceLanguage,
      context,
    });

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/translate/languages
 * Returns list of supported languages and translation safety guidance.
 */
const getSupportedLanguages = (req, res) => {
  return res.status(200).json({
    success: true,
    languages: SUPPORTED_LANGUAGES,
    disclaimer: MEDICAL_DISCLAIMER,
  });
};

module.exports = {
  translate,
  getSupportedLanguages,
};
