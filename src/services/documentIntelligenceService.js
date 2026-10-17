const {
  DocumentAnalysisClient,
  AzureKeyCredential,
} = require("@azure/ai-form-recognizer");

const getEndpoint = () =>
  process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ||
  process.env.DOCUMENT_INTELLIGENCE_ENDPOINT ||
  "";

const getKey = () =>
  process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY ||
  process.env.DOCUMENT_INTELLIGENCE_KEY ||
  "";

const isDocumentIntelligenceConfigured = () => {
  return Boolean(getEndpoint() && getKey());
};

let _client = null;

const getClient = () => {
  if (!isDocumentIntelligenceConfigured()) {
    return null;
  }
  if (!_client) {
    _client = new DocumentAnalysisClient(
      getEndpoint(),
      new AzureKeyCredential(getKey())
    );
  }
  return _client;
};

const analyzeDocument = async (buffer) => {
  const client = getClient();
  if (!client) {
    const error = new Error("Azure Document Intelligence credentials are not configured.");
    error.code = "SERVICE_UNCONFIGURED";
    throw error;
  }

  const startTime = Date.now();
  try {
    const poller = await client.beginAnalyzeDocument(
      "prebuilt-layout",
      buffer,
      {
        updateIntervalInMs: 1000, // Poll every 1 second instead of default 5 seconds to reduce idle wait
      }
    );
    const result = await poller.pollUntilDone();
    const durationMs = Date.now() - startTime;
    return {
      ...result,
      durationMs,
    };
  } catch (error) {
    console.error("Azure Document Intelligence OCR Error:", error.message);
    throw error;
  }
};

module.exports = {
  isDocumentIntelligenceConfigured,
  analyzeDocument,
};