const { v4: uuidv4 } = require("uuid");

const {
  BlobSASPermissions,
  generateBlobSASQueryParameters,
} = require("@azure/storage-blob");

const {
  containerClient,
  credential,
  accountName,
} = require("../config/azureStorage");

const Report = require("../models/Report");

const {
  analyzeDocument,
} = require("../services/documentIntelligenceService");

const analyzeMedicalReport = require("../services/aiAnalysisService");

// =======================================
// Upload Reports
// =======================================

const uploadReport = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No files uploaded",
      });
    }

    const uploadedFiles = [];

    for (const file of req.files) {

      const fileName =
        `${Date.now()}-${uuidv4()}-${file.originalname}`;

      const blobPath =
        `users/${req.user.id}/reports/${fileName}`;

      const blockBlobClient =
        containerClient.getBlockBlobClient(blobPath);

      // Upload to Azure Blob

      await blockBlobClient.uploadData(file.buffer, {
        blobHTTPHeaders: {
          blobContentType: file.mimetype,
        },
      });

      // =====================================
      // Azure OCR
      // =====================================

      let ocrText = "";
      let paragraphs = [];
      let tables = [];
      let keyValuePairs = [];
      let pageCount = 0;
      let analysisStatus = "Completed";

      try {

        console.log("Running Azure OCR...");

        const result =
          await analyzeDocument(file.buffer);

        ocrText =
          result.content || "";

        paragraphs =
          result.paragraphs || [];

        tables =
          result.tables || [];

        keyValuePairs =
          result.keyValuePairs || [];

        pageCount =
          result.pages
            ? result.pages.length
            : 0;

        console.log("OCR Completed");

      } catch (ocrError) {

        console.error(ocrError);

        analysisStatus = "Failed";

      }

      // =====================================
      // Azure OpenAI
      // =====================================

      let aiAnalysis = {
        summary: "",
        severity: "Unknown",
        abnormalParameters: [],
        possibleDiseases: [],
        recommendations: [],
        dietPlan: [],
        exercisePlan: [],
        doctorAdvice: "",
        followUpTests: [],
        generatedAt: null,
      };

      if (
        analysisStatus === "Completed" &&
        ocrText.trim() !== ""
      ) {

        try {

          console.log("Running Azure OpenAI...");

          aiAnalysis =
            await analyzeMedicalReport(
              ocrText
            );

          aiAnalysis.generatedAt =
            new Date();

          console.log(
            "AI Analysis Completed"
          );

        } catch (aiError) {

          console.error(
            "Azure OpenAI Error"
          );

          console.error(aiError);

        }

      }

      // =====================================
      // Save MongoDB
      // =====================================

      const report =
        await Report.create({

          userId:
            req.user.id,

          fileName,

          originalName:
            file.originalname,

          blobUrl:
            blockBlobClient.url,

          blobPath,

          fileType:
            file.mimetype,

          fileSize:
            file.size,

          ocrText,

          paragraphs,

          tables,

          keyValuePairs,

          pageCount,

          analysisStatus,

          aiAnalysis,

        });

      uploadedFiles.push(report);

    }

    res.status(201).json({

      success: true,

      message:
        "Reports uploaded successfully.",

      reports:
        uploadedFiles,

    });

  } catch (error) {

    console.error(error);

    res.status(500).json({

      success: false,

      message:
        "Upload failed",

    });

  }

};

// =======================================
// Get Reports
// =======================================

const getReports = async (req, res) => {

  try {

    const reports =
      await Report.find({

        userId:
          req.user.id,

      }).sort({

        createdAt: -1,

      });

    res.status(200).json(reports);

  } catch (error) {

    console.error(error);

    res.status(500).json({

      success: false,

      message:
        "Could not fetch reports",

    });

  }

};

// =======================================
// Generate Secure SAS URL
// =======================================

const viewReport = async (req, res) => {

  try {

    const report =
      await Report.findById(
        req.params.id
      );

    if (!report) {

      return res.status(404).json({

        success: false,

        message:
          "Report not found",

      });

    }

    if (
      report.userId.toString() !==
      req.user.id
    ) {

      return res.status(403).json({

        success: false,

        message:
          "Unauthorized",

      });

    }

    const expiresOn =
      new Date(
        Date.now() +
        10 * 60 * 1000
      );

    const sasToken =
      generateBlobSASQueryParameters(
        {

          containerName:
            process.env
              .AZURE_CONTAINER_NAME,

          blobName:
            report.blobPath,

          permissions:
            BlobSASPermissions.parse(
              "r"
            ),

          expiresOn,

        },
        credential
      ).toString();

    const secureUrl =
      `https://${accountName}.blob.core.windows.net/${process.env.AZURE_CONTAINER_NAME}/${report.blobPath}?${sasToken}`;

    res.status(200).json({

      success: true,

      url:
        secureUrl,

    });

  } catch (error) {

    console.error(error);

    res.status(500).json({

      success: false,

      message:
        "Server Error",

    });

  }

};

module.exports = {

  uploadReport,

  getReports,

  viewReport,

};