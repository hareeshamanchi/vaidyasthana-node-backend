const mongoose = require("mongoose");

const reportSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    familyMemberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FamilyMember",
      default: null,
      index: true,
    },

    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      default: null,
      index: true,
    },

    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    uploadedByRole: {
      type: String,
      enum: [
        "patient",
        "doctor",
        "nurse",
        "receptionist",
        "lab_technician",
        "pharmacist",
        "billing_staff",
        "hospital_admin",
        "admin",
        "superadmin",
      ],
      default: "patient",
    },

    uploaderName: {
      type: String,
      default: "",
      trim: true,
    },

    fileName: {
      type: String,
      required: true,
    },

    originalName: {
      type: String,
      required: true,
      trim: true,
    },

    blobUrl: {
      type: String,
      required: true,
    },

    blobPath: {
      type: String,
      required: true,
    },

    fileType: {
      type: String,
      required: true,
    },

    fileSize: {
      type: Number,
      required: true,
    },

    category: {
      type: String,
      default: "Medical Report",
      trim: true,
    },

    notes: {
      type: String,
      default: "",
    },

    // ==================================
    // OCR DATA (Document Intelligence)
    // ==================================

    ocrText: {
      type: String,
      default: "",
    },

    paragraphs: {
      type: Array,
      default: [],
    },

    tables: {
      type: Array,
      default: [],
    },

    keyValuePairs: {
      type: Array,
      default: [],
    },

    pageCount: {
      type: Number,
      default: 0,
    },

    // ==================================
    // AI ANALYSIS (Azure OpenAI)
    // ==================================

    aiAnalysis: {
      summary: {
        type: String,
        default: "",
      },

      severity: {
        type: String,
        enum: ["Low", "Medium", "High", "Critical", "Unknown"],
        default: "Unknown",
      },

      abnormalParameters: [
        {
          parameter: {
            type: String,
            default: "",
          },

          value: {
            type: String,
            default: "",
          },

          normalRange: {
            type: String,
            default: "",
          },

          status: {
            type: String,
            default: "",
          },

          reason: {
            type: String,
            default: "",
          },
        },
      ],

      possibleDiseases: {
        type: [String],
        default: [],
      },

      recommendations: {
        type: [String],
        default: [],
      },

      dietPlan: {
        type: [String],
        default: [],
      },

      exercisePlan: {
        type: [String],
        default: [],
      },

      doctorAdvice: {
        type: String,
        default: "",
      },

      followUpTests: {
        type: [String],
        default: [],
      },

      disclaimer: {
        type: String,
        default:
          "Medical Disclaimer: This AI-assisted analysis is for informational educational purposes only. It is not a clinical diagnosis. Always consult a qualified medical professional.",
      },

      generatedAt: {
        type: Date,
        default: null,
      },
    },

    // ==================================
    // PROCESS STATUS
    // ==================================

    analysisStatus: {
      type: String,
      enum: ["Pending", "Processing", "Completed", "Failed"],
      default: "Pending",
    },

    processingStage: {
      type: String,
      enum: [
        "Preparing your report",
        "Uploading your medical report",
        "Extracting text from your document",
        "AI is analyzing your report",
        "Saving your analysis",
        "Analysis complete",
        "Failed",
      ],
      default: "Preparing your report",
    },

    errorMessage: {
      type: String,
      default: "",
    },

    timings: {
      type: Object,
      default: {},
    },

    uploadedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

reportSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("Report", reportSchema);