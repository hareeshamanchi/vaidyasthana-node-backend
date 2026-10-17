const { v4: uuidv4 } = require("uuid");
const {
  BlobSASPermissions,
  generateBlobSASQueryParameters,
} = require("@azure/storage-blob");

const {
  isAzureStorageConfigured,
  getContainerClient,
  getCredential,
  accountName,
  containerName,
} = require("../config/azureStorage");

const Report = require("../models/Report");
const User = require("../models/User");
const { createNotification } = require("../services/notificationService");

const {
  isDocumentIntelligenceConfigured,
  analyzeDocument,
} = require("../services/documentIntelligenceService");

const {
  isAzureOpenAIConfigured,
  analyzeMedicalReport,
} = require("../services/aiAnalysisService");

const {
  isDoctorAuthorizedForPatient,
  resolvePatientUser,
} = require("../services/clinicalAuthorizationService");

// Allowed MIME types for healthcare records
const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const mongoose = require("mongoose");

const isDbConnected = () => mongoose.connection.readyState === 1;

// In-memory fallback repository when MongoDB connection is offline
const inMemoryReports = new Map();

const createReportDoc = async (reportData) => {
  if (isDbConnected()) {
    return await Report.create(reportData);
  }
  const id = new mongoose.Types.ObjectId().toString();
  const doc = {
    _id: id,
    ...reportData,
    createdAt: new Date(),
    updatedAt: new Date(),
    save: async function () {
      this.updatedAt = new Date();
      inMemoryReports.set(this._id.toString(), this);
      return this;
    },
  };
  inMemoryReports.set(id, doc);
  return doc;
};

const findReportById = async (id) => {
  if (!id) return null;
  const strId = id.toString();
  if (isDbConnected()) {
    try {
      const found = await Report.findById(id);
      if (found) return found;
    } catch {
      // Fall through to memory lookup
    }
  }
  return inMemoryReports.get(strId) || null;
};

const updateReportDoc = async (id, update) => {
  if (!id) return null;
  const strId = id.toString();
  if (isDbConnected()) {
    try {
      return await Report.findByIdAndUpdate(id, update, { new: true });
    } catch {
      // Fall through
    }
  }
  const existing = inMemoryReports.get(strId);
  if (existing) {
    Object.assign(existing, update, { updatedAt: new Date() });
    inMemoryReports.set(strId, existing);
    return existing;
  }
  return null;
};

// =======================================
// Asynchronous Document Processing Pipeline
// =======================================
const processReportPipeline = async (
  reportId,
  buffer,
  fileMimeType,
  originalName,
  fileSize
) => {
  const jobId = reportId.toString();
  const startTime = Date.now();
  const timings = {
    blobMs: 0,
    ocrMs: 0,
    aiMs: 0,
    dbMs: 0,
    totalMs: 0,
  };

  try {
    const report = await findReportById(reportId);
    if (!report) {
      console.error(`[SAFE_LOG] Job ${jobId}: Report not found for pipeline processing.`);
      return;
    }

    // ----------------------------------------
    // Stage 3: Extracting text from document
    // ----------------------------------------
    report.processingStage = "Extracting text from your document";
    report.analysisStatus = "Processing";
    await report.save();

    let ocrText = "";
    let paragraphs = [];
    let tables = [];
    let keyValuePairs = [];
    let pageCount = 1;

    if (isDocumentIntelligenceConfigured()) {
      const ocrStart = Date.now();
      try {
        console.log(`[SAFE_LOG] Job ${jobId}: Initiating Azure Document Intelligence extraction`);
        const result = await analyzeDocument(buffer);
        timings.ocrMs = Date.now() - ocrStart;

        ocrText = result.content || "";
        paragraphs = (result.paragraphs || []).map((p) => p.content || "");
        tables = (result.tables || []).map((t) => ({
          rowCount: t.rowCount,
          columnCount: t.columnCount,
          cells: (t.cells || []).map((c) => ({
            content: c.content,
            rowIndex: c.rowIndex,
            columnIndex: c.columnIndex,
          })),
        }));
        keyValuePairs = (result.keyValuePairs || []).map((kv) => ({
          key: kv.key ? kv.key.content : "",
          value: kv.value ? kv.value.content : "",
        }));
        pageCount = result.pages ? result.pages.length : 1;
        console.log(`[SAFE_LOG] Job ${jobId}: OCR extraction completed in ${timings.ocrMs}ms (Pages: ${pageCount})`);
      } catch (ocrErr) {
        timings.ocrMs = Date.now() - ocrStart;
        console.error(`[SAFE_LOG] Job ${jobId}: OCR extraction failed in ${timings.ocrMs}ms:`, ocrErr.message);
      }
    } else {
      console.warn(`[SAFE_LOG] Job ${jobId}: Document Intelligence not configured. Using metadata/notes fallback.`);
    }

    // Persist extracted OCR fields
    report.ocrText = ocrText;
    report.paragraphs = paragraphs;
    report.tables = tables;
    report.keyValuePairs = keyValuePairs;
    report.pageCount = pageCount;

    // ----------------------------------------
    // Stage 4: AI is analyzing your report
    // ----------------------------------------
    report.processingStage = "AI is analyzing your report";
    await report.save();

    const textToAnalyze =
      ocrText && ocrText.trim() !== ""
        ? ocrText
        : (report.notes && report.notes.trim() !== ""
            ? `Clinical Document Notes: ${report.notes}\nDocument: ${originalName}\nCategory: ${report.category}`
            : `Document: ${originalName}\nCategory: ${report.category}`);

    let aiAnalysis;
    const aiStart = Date.now();
    try {
      console.log(`[SAFE_LOG] Job ${jobId}: Submitting text to Azure OpenAI clinical model`);
      aiAnalysis = await analyzeMedicalReport(textToAnalyze);
      timings.aiMs = Date.now() - aiStart;
      console.log(`[SAFE_LOG] Job ${jobId}: Azure OpenAI clinical analysis completed in ${timings.aiMs}ms`);
    } catch (aiErr) {
      timings.aiMs = Date.now() - aiStart;
      console.error(`[SAFE_LOG] Job ${jobId}: Azure OpenAI analysis error in ${timings.aiMs}ms:`, aiErr.message);
      aiAnalysis = {
        summary: `AI clinical evaluation pending configuration: ${aiErr.message}`,
        severity: "Unknown",
        abnormalParameters: [],
        possibleDiseases: [],
        recommendations: ["Consult your healthcare provider for evaluation."],
        dietPlan: ["Follow standard balanced nutrition tailored to your health."],
        exercisePlan: ["Engage in moderate physical activity as approved by a doctor."],
        doctorAdvice: "Discuss your laboratory findings directly with a physician.",
        followUpTests: [],
        disclaimer: "Medical Disclaimer: For educational purposes only.",
        generatedAt: new Date(),
      };
    }

    // ----------------------------------------
    // Stage 5: Saving your analysis
    // ----------------------------------------
    report.processingStage = "Saving your analysis";
    const dbStart = Date.now();
    report.aiAnalysis = aiAnalysis;
    report.analysisStatus = "Completed";
    report.processingStage = "Analysis complete";
    timings.dbMs = Date.now() - dbStart;
    timings.totalMs = Date.now() - startTime;
    report.timings = timings;
    await report.save();

    // Safe structured metrics log — Never logs patient document contents or credentials
    console.log(
      `[SAFE_METRICS] Job: ${jobId} | FileSize: ${fileSize}B | OCR: ${timings.ocrMs}ms | OpenAI: ${timings.aiMs}ms | DB: ${timings.dbMs}ms | Total: ${timings.totalMs}ms`
    );
  } catch (err) {
    timings.totalMs = Date.now() - startTime;
    console.error(`[SAFE_LOG] Job ${jobId}: Pipeline error (${timings.totalMs}ms):`, err.message);
    try {
      await updateReportDoc(reportId, {
        analysisStatus: "Failed",
        processingStage: "Failed",
        errorMessage: err.message || "Failed during document processing pipeline.",
        timings,
      });
    } catch (dbUpdateErr) {
      console.error("Failed to update report error state:", dbUpdateErr.message);
    }
  }
};

// =======================================
// Upload Reports
// =======================================
// Upload Medical Reports
// POST /upload or POST /api/reports
// =======================================
const uploadReport = async (req, res) => {
  const requestStartTime = Date.now();
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No files provided. Please select at least one document to upload.",
      });
    }

    // Resolve target patient ownership
    const requestedPatientId =
      req.body.patientId ||
      req.body.targetPatientId ||
      req.body.selectedPatientId ||
      req.query.patientId;

    let targetUserId = req.user.id;
    let targetPatient = null;
    const isDoctorOrAdmin = req.user.role === "doctor" || req.user.role === "admin";

    if (requestedPatientId && String(requestedPatientId).trim() !== "") {
      const cleanId = String(requestedPatientId).trim();

      if (!isDoctorOrAdmin && cleanId !== String(req.user.id)) {
        return res.status(403).json({
          success: false,
          message: "Only verified healthcare professionals can upload reports on behalf of another patient.",
        });
      }

      targetPatient = await resolvePatientUser(cleanId);

      if (!targetPatient) {
        return res.status(404).json({
          success: false,
          message: `Target patient not found with identifier '${cleanId}'. Verify the Patient ID.`,
        });
      }

      // Check clinical authorization: Doctor must have an established appointment with the patient
      if (req.user.role === "doctor") {
        const isAuthorized = await isDoctorAuthorizedForPatient(req.user, targetPatient._id);
        if (!isAuthorized) {
          return res.status(403).json({
            success: false,
            message: "Forbidden: You are not authorized to upload medical documents to this patient's vault without an established appointment or clinical assignment.",
          });
        }
      }

      targetUserId = targetPatient._id.toString();
      console.log(`[SAFE_LOG] Doctor ${req.user.id} uploading report for patient ${targetUserId}`);
    } else if (req.user.role === "doctor") {
      return res.status(400).json({
        success: false,
        message: "Patient ID is required. Please specify the target patient before uploading medical documents.",
      });
    }

    const uploadedBy = req.user.id;
    const uploadedByRole = req.user.role || "patient";
    const uploaderName = req.user.name || (uploadedByRole === "doctor" ? "Physician" : "Patient");

    const containerClient = getContainerClient();
    const storageConfigured = isAzureStorageConfigured() && containerClient;

    const uploadedFiles = [];
    const isSyncMode = req.query.sync === "true";

    for (const file of req.files) {
      // Validate file type
      if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        return res.status(400).json({
          success: false,
          message: `Unsupported file format '${file.mimetype}'. Only PDF, JPEG, PNG, and DOC/DOCX are permitted.`,
        });
      }

      const safeOriginalName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
      const fileName = `${Date.now()}-${uuidv4()}-${safeOriginalName}`;
      const blobPath = `users/${targetUserId}/reports/${fileName}`;

      let blobUrl = `https://${accountName || "vaidyasthanastorage1"}.blob.core.windows.net/${containerName}/${blobPath}`;
      let blobDurationMs = 0;

      // Upload to Azure Blob Storage if configured
      if (storageConfigured) {
        const blobStart = Date.now();
        try {
          const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
          await blockBlobClient.uploadData(file.buffer, {
            blobHTTPHeaders: {
              blobContentType: file.mimetype,
            },
          });
          blobUrl = blockBlobClient.url;
          blobDurationMs = Date.now() - blobStart;
          console.log(`[SAFE_LOG] Uploaded to Azure Blob: ${blobPath} in ${blobDurationMs}ms`);
        } catch (storageError) {
          console.error("❌ Azure Blob upload error:", storageError.message);
          return res.status(500).json({
            success: false,
            message: `Failed to upload to Azure Blob Storage: ${storageError.message}`,
          });
        }
      } else {
        console.warn("[SAFE_LOG] Azure Blob Storage not configured. Recording file metadata in database.");
      }

      // Initial Report Record Creation in MongoDB or In-Memory Fallback
      // userId is set to target patient, uploadedBy is set to doctor
      const report = await createReportDoc({
        userId: targetUserId,
        uploadedBy,
        uploadedByRole,
        uploaderName,
        fileName,
        originalName: file.originalname,
        blobUrl,
        blobPath,
        fileType: file.mimetype,
        fileSize: file.size,
        category: req.body.category || "Medical Report",
        notes: req.body.notes || "",
        ocrText: "",
        paragraphs: [],
        tables: [],
        keyValuePairs: [],
        pageCount: 1,
        analysisStatus: "Processing",
        processingStage: "Extracting text from your document",
        timings: {
          blobMs: blobDurationMs,
        },
      });

      if (isSyncMode) {
        // Synchronous execution mode (for testing or clients requesting sync=true)
        await processReportPipeline(
          report._id,
          file.buffer,
          file.mimetype,
          file.originalname,
          file.size
        );
        const updated = await findReportById(report._id);
        uploadedFiles.push(updated);
      } else {
        // Asynchronous non-blocking background execution
        processReportPipeline(
          report._id,
          file.buffer,
          file.mimetype,
          file.originalname,
          file.size
        ).catch((err) => {
          console.error(`[SAFE_LOG] Async pipeline uncaught error for ${report._id}:`, err.message);
        });
        uploadedFiles.push(report);
      }

      // Notify target patient (and doctor if uploaded on patient's behalf)
      const isDoctorUploader = String(uploadedBy) !== String(targetUserId);
      if (isDoctorUploader) {
        createNotification({
          userId: targetUserId,
          title: "New Clinical Report Received",
          message: `Dr. ${uploaderName || "Your physician"} added "${file.originalname}" to your Medical Vault.`,
          type: "report_uploaded",
          relatedId: report._id,
          relatedModel: "Report",
          link: "/dashboard",
        }).catch((e) => console.error("Report patient notify error:", e.message));

        createNotification({
          userId: uploadedBy,
          title: "Report Uploaded to Vault",
          message: `"${file.originalname}" was successfully uploaded to patient vault.`,
          type: "report_uploaded",
          relatedId: report._id,
          relatedModel: "Report",
          link: "/doctor-dashboard",
        }).catch((e) => console.error("Report doctor notify error:", e.message));
      } else {
        createNotification({
          userId: targetUserId,
          title: "Report Uploaded Successfully",
          message: `"${file.originalname}" was securely uploaded to your Medical Vault.`,
          type: "report_uploaded",
          relatedId: report._id,
          relatedModel: "Report",
          link: "/dashboard",
        }).catch((e) => console.error("Report self notify error:", e.message));
      }
    }

    const uploadElapsed = Date.now() - requestStartTime;
    console.log(`[SAFE_LOG] Upload request completed in ${uploadElapsed}ms for ${uploadedFiles.length} file(s).`);

    return res.status(201).json({
      success: true,
      message: `${uploadedFiles.length} report(s) uploaded successfully. Processing started.`,
      reports: uploadedFiles,
      jobId: uploadedFiles[0]?._id,
      status: uploadedFiles[0]?.analysisStatus || "Processing",
      stage: uploadedFiles[0]?.processingStage || "Extracting text from your document",
      patientId: targetUserId,
      uploadedBy,
      uploadedByRole,
    });
  } catch (error) {
    console.error("Upload handler error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error during document upload.",
    });
  }
};

// =======================================
// Get Reports (with search & filtering)
// GET /upload/all or GET /api/reports
// =======================================
const getReports = async (req, res) => {
  try {
    let targetUserId = req.user.id;

    // If caller is doctor or admin and requested a specific patient's reports
    if (req.query.patientId && req.user.role === "doctor") {
      const isAuthorized = await isDoctorAuthorizedForPatient(req.user, req.query.patientId);
      if (!isAuthorized) {
        return res.status(403).json({
          success: false,
          message: "Forbidden: You are not authorized to access this patient's medical records.",
        });
      }
      targetUserId = req.query.patientId;
    } else if (req.query.patientId && req.user.role === "admin") {
      targetUserId = req.query.patientId;
    } else if (req.query.patientId && String(req.query.patientId) !== String(req.user.id)) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: Patients can only access their own medical records.",
      });
    }

    const query = { userId: targetUserId };

    if (req.query.search) {
      query.$or = [
        { originalName: { $regex: req.query.search, $options: "i" } },
        { category: { $regex: req.query.search, $options: "i" } },
      ];
    }

    if (req.query.category && req.query.category !== "All") {
      query.category = req.query.category;
    }

    if (req.query.status) {
      query.analysisStatus = req.query.status;
    }

    let reports = [];
    if (isDbConnected()) {
      reports = await Report.find(query).sort({ createdAt: -1 });
    } else {
      reports = Array.from(inMemoryReports.values())
        .filter((r) => r.userId?.toString() === targetUserId?.toString())
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    return res.status(200).json(reports);
  } catch (error) {
    console.error("Fetch reports error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to retrieve medical reports.",
    });
  }
};

// =======================================
// Get Single Report by ID
// GET /upload/:id or GET /api/reports/:id
// =======================================
const getReportById = async (req, res) => {
  try {
    const report = await findReportById(req.params.id);

    if (!report) {
      return res.status(404).json({
        success: false,
        message: "Report not found.",
      });
    }

    // Verify ownership or doctor authorization
    const isOwner = report.userId.toString() === req.user.id;
    const isAdmin = req.user.role === "admin";
    let isAuthorizedDoctor = false;

    if (req.user.role === "doctor") {
      isAuthorizedDoctor = await isDoctorAuthorizedForPatient(req.user, report.userId);
    }

    if (!isOwner && !isAdmin && !isAuthorizedDoctor) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You do not own this report.",
      });
    }

    return res.status(200).json({
      success: true,
      report,
    });
  } catch (error) {
    console.error("Get report by ID error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching report details.",
    });
  }
};

// =======================================
// Generate Secure SAS URL for Viewing/Downloading
// =======================================
// Generate Secure SAS URL for Viewing/Downloading
// GET /upload/view/:id or GET /api/reports/:id/view
// =======================================
const viewReport = async (req, res) => {
  try {
    let report = await findReportById(req.params.id);

    if (!report && isDbConnected()) {
      report = await Report.findOne({ fileName: req.params.id });
    }

    if (!report) {
      return res.status(404).json({
        success: false,
        message: "Medical report not found.",
      });
    }

    // Verify ownership or doctor authorization
    const isOwner = report.userId.toString() === req.user.id;
    const isAdmin = req.user.role === "admin";
    let isAuthorizedDoctor = false;

    if (req.user.role === "doctor") {
      isAuthorizedDoctor = await isDoctorAuthorizedForPatient(req.user, report.userId);
    }

    if (!isOwner && !isAdmin && !isAuthorizedDoctor) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized to access this patient's report.",
      });
    }

    // Check if Azure Storage is fully configured
    const credential = getCredential();
    if (!isAzureStorageConfigured() || !credential) {
      // In unconfigured environments, return blobUrl or informative message
      return res.status(200).json({
        success: true,
        url: report.blobUrl,
        message: "Note: Live Azure SAS generation requires active AZURE_STORAGE_KEY configuration.",
      });
    }

    // Generate short-lived SAS token (15 minutes)
    const expiresOn = new Date(Date.now() + 15 * 60 * 1000);
    const sasToken = generateBlobSASQueryParameters(
      {
        containerName: containerName || "medical-reports",
        blobName: report.blobPath,
        permissions: BlobSASPermissions.parse("r"),
        expiresOn,
      },
      credential
    ).toString();

    const secureUrl = `https://${accountName}.blob.core.windows.net/${containerName}/${report.blobPath}?${sasToken}`;

    return res.status(200).json({
      success: true,
      url: secureUrl,
      expiresAt: expiresOn,
    });
  } catch (error) {
    console.error("View report error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error generating secure document access token.",
    });
  }
};

// =======================================
// Delete Medical Report
// DELETE /upload/:id or DELETE /api/reports/:id
// =======================================
const deleteReport = async (req, res) => {
  try {
    const report = await findReportById(req.params.id);

    if (!report) {
      return res.status(404).json({
        success: false,
        message: "Report not found.",
      });
    }

    // Verify ownership
    if (report.userId.toString() !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied. You cannot delete this record.",
      });
    }

    // Attempt to delete blob from Azure Storage if configured
    const containerClient = getContainerClient();
    if (isAzureStorageConfigured() && containerClient && report.blobPath) {
      try {
        const blockBlobClient = containerClient.getBlockBlobClient(report.blobPath);
        await blockBlobClient.deleteIfExists();
        console.log(`🗑️ Deleted Azure Blob: ${report.blobPath}`);
      } catch (blobErr) {
        console.warn("Could not delete Azure Blob:", blobErr.message);
      }
    }

    if (isDbConnected()) {
      await Report.findByIdAndDelete(req.params.id);
    }
    inMemoryReports.delete(req.params.id.toString());

    return res.status(200).json({
      success: true,
      message: "Report and associated storage record deleted successfully.",
    });
  } catch (error) {
    console.error("Delete report error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error deleting medical report.",
    });
  }
};

// =======================================
// Trigger or Re-run AI Analysis
// POST /upload/analyze/:id or POST /api/reports/:id/analyze
// =======================================
const analyzeReport = async (req, res) => {
  try {
    const report = await findReportById(req.params.id);

    if (!report) {
      return res.status(404).json({
        success: false,
        message: "Report not found.",
      });
    }

    const isOwner = report.userId.toString() === req.user.id.toString();
    const isAdmin = req.user.role === "admin";
    let isAuthorizedDoctor = false;

    if (req.user.role === "doctor") {
      isAuthorizedDoctor = await isDoctorAuthorizedForPatient(req.user, report.userId);
    }

    if (!isOwner && !isAdmin && !isAuthorizedDoctor) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You are not authorized to analyze this patient's medical records.",
      });
    }

    const textToAnalyze =
      report.ocrText && report.ocrText.trim() !== ""
        ? report.ocrText
        : (report.notes && report.notes.trim() !== ""
            ? `Clinical Document Notes: ${report.notes}\nDocument: ${report.originalName || report.fileName}\nCategory: ${report.category}`
            : `Document: ${report.originalName || report.fileName}\nCategory: ${report.category}`);

    report.analysisStatus = "Processing";
    report.processingStage = "AI is analyzing your report";
    await report.save();

    const analysis = await analyzeMedicalReport(textToAnalyze);
    report.aiAnalysis = analysis;
    report.analysisStatus = "Completed";
    report.processingStage = "Analysis complete";
    await report.save();

    return res.status(200).json({
      success: true,
      message: "AI analysis updated successfully.",
      aiAnalysis: report.aiAnalysis,
    });
  } catch (error) {
    console.error("Analyze report error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to generate AI analysis.",
    });
  }
};

// =======================================
// Get Granular Processing Status of a Report
// GET /upload/:id/status or GET /upload/status/:id
// =======================================
const getReportStatus = async (req, res) => {
  try {
    const report = await findReportById(req.params.id);

    if (!report) {
      return res.status(404).json({
        success: false,
        message: "Report not found.",
      });
    }

    // Verify ownership or doctor authorization
    const isOwner = report.userId.toString() === req.user.id.toString();
    const isAdmin = req.user.role === "admin";
    let isAuthorizedDoctor = false;

    if (req.user.role === "doctor") {
      isAuthorizedDoctor = await isDoctorAuthorizedForPatient(req.user, report.userId);
    }

    if (!isOwner && !isAdmin && !isAuthorizedDoctor) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You do not own this report.",
      });
    }

    return res.status(200).json({
      success: true,
      reportId: report._id,
      analysisStatus: report.analysisStatus,
      processingStage: report.processingStage,
      errorMessage: report.errorMessage,
      timings: report.timings,
      aiAnalysis: report.aiAnalysis,
      updatedAt: report.updatedAt,
      report,
    });
  } catch (error) {
    console.error("Get report status error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error retrieving report processing status.",
    });
  }
};

// =======================================
// Retry Failed Processing for a Report
// POST /upload/:id/retry or POST /upload/retry/:id
// =======================================
const retryReportAnalysis = async (req, res) => {
  try {
    const report = await findReportById(req.params.id);

    if (!report) {
      return res.status(404).json({
        success: false,
        message: "Report not found.",
      });
    }

    const isOwner = report.userId.toString() === req.user.id.toString();
    const isAdmin = req.user.role === "admin";
    let isAuthorizedDoctor = false;

    if (req.user.role === "doctor") {
      isAuthorizedDoctor = await isDoctorAuthorizedForPatient(req.user, report.userId);
    }

    if (!isOwner && !isAdmin && !isAuthorizedDoctor) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You are not authorized to retry processing for this report.",
      });
    }

    report.analysisStatus = "Processing";
    report.processingStage = "AI is analyzing your report";
    report.errorMessage = "";
    await report.save();

    const textToAnalyze =
      report.ocrText && report.ocrText.trim() !== ""
        ? report.ocrText
        : (report.notes && report.notes.trim() !== ""
            ? `Clinical Notes: ${report.notes}\nDocument: ${report.originalName || report.fileName}\nCategory: ${report.category}`
            : `Document: ${report.originalName || report.fileName}\nCategory: ${report.category}`);

    // Asynchronously retry without blocking client
    (async () => {
      try {
        const analysis = await analyzeMedicalReport(textToAnalyze);
        report.aiAnalysis = analysis;
        report.analysisStatus = "Completed";
        report.processingStage = "Analysis complete";
        await report.save();
        console.log(`[SAFE_LOG] Retry completed for report ${report._id}`);
      } catch (retryErr) {
        report.analysisStatus = "Failed";
        report.errorMessage = retryErr.message;
        report.processingStage = "Failed";
        await report.save();
        console.error(`[SAFE_LOG] Retry failed for report ${report._id}:`, retryErr.message);
      }
    })();

    return res.status(200).json({
      success: true,
      message: "Analysis retry initiated.",
      reportId: report._id,
      analysisStatus: report.analysisStatus,
      processingStage: report.processingStage,
    });
  } catch (error) {
    console.error("Retry analysis error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error initiating report retry.",
    });
  }
};

module.exports = {
  uploadReport,
  getReports,
  getReportById,
  getReportStatus,
  retryReportAnalysis,
  viewReport,
  deleteReport,
  analyzeReport,
  inMemoryReports,
  isDbConnected,
};