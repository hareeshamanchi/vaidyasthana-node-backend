const mongoose = require("mongoose");
const { isAzureStorageConfigured } = require("../config/azureStorage");
const { isDocumentIntelligenceConfigured } = require("../services/documentIntelligenceService");
const { isAzureOpenAIConfigured } = require("../services/aiAnalysisService");
const { checkOllamaAvailability, getOllamaModel } = require("../services/ollamaNutritionService");

const getHealthStatus = async (req, res) => {
  const dbStatusMap = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
  };

  const dbState = mongoose.connection.readyState;
  const dbStatus = dbStatusMap[dbState] || "unknown";

  const storageConfigured = isAzureStorageConfigured();
  const docIntelConfigured = isDocumentIntelligenceConfigured();
  const openAIConfigured = isAzureOpenAIConfigured();
  const ollamaStatus = await checkOllamaAvailability();

  const services = {
    database: {
      status: dbStatus,
      isHealthy: dbState === 1,
    },
    azureBlobStorage: {
      configured: storageConfigured,
      status: storageConfigured ? "configured" : "pending_credentials",
      account: process.env.AZURE_STORAGE_ACCOUNT || "vaidyasthanastorage1",
      container: process.env.AZURE_CONTAINER_NAME || "medical-reports",
    },
    azureDocumentIntelligence: {
      configured: docIntelConfigured,
      status: docIntelConfigured ? "configured" : "pending_credentials",
    },
    azureOpenAI: {
      configured: openAIConfigured,
      status: openAIConfigured ? "configured" : "pending_credentials",
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT || "not_set",
    },
    ollamaAI: {
      configured: true,
      available: ollamaStatus.available,
      status: ollamaStatus.available ? "online" : "offline",
      configuredModel: getOllamaModel(),
      isModelInstalled: ollamaStatus.isModelInstalled,
      baseUrl: ollamaStatus.baseUrl,
    },
  };

  const isSystemOperational = true;

  res.status(200).json({
    success: true,
    platform: "Vaidyasthana Healthcare Platform API",
    status: isSystemOperational ? "operational" : "degraded",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    environment: process.env.NODE_ENV || "development",
    services,
  });
};

module.exports = {
  getHealthStatus,
};
