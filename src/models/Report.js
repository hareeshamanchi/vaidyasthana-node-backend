const mongoose = require("mongoose");

const reportSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    fileName: {
      type: String,
      required: true,
    },

    originalName: {
      type: String,
      required: true,
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
    },

    // ==================================
    // OCR DATA
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
    // AI ANALYSIS
    // ==================================

    aiAnalysis: {
      summary: {
        type: String,
        default: "",
      },

      severity: {
        type: String,
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
      enum: [
        "Pending",
        "Processing",
        "Completed",
        "Failed",
      ],
      default: "Pending",
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

module.exports = mongoose.model("Report", reportSchema);