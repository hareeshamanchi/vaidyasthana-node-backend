const {
  DocumentAnalysisClient,
  AzureKeyCredential,
} = require("@azure/ai-form-recognizer");

const endpoint =
  process.env.DOCUMENT_INTELLIGENCE_ENDPOINT;

const key =
  process.env.DOCUMENT_INTELLIGENCE_KEY;

const client =
  new DocumentAnalysisClient(
    endpoint,
    new AzureKeyCredential(key)
  );

const analyzeDocument = async (buffer) => {
  try {

    const poller =
      await client.beginAnalyzeDocument(
        "prebuilt-layout",
        buffer
      );

    const result =
      await poller.pollUntilDone();

    return result;

  } catch (error) {

    console.error(
      "OCR Error:",
      error.message
    );

    throw error;

  }
};

module.exports = {
  analyzeDocument,
};