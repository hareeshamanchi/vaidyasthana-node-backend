const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/v1`,
});

const analyzeMedicalReport = async (ocrText) => {
  try {

    const systemPrompt = `
You are an expert physician and laboratory report analyzer.

Analyze the medical report OCR text.

Return ONLY valid JSON.

{
  "summary":"",
  "severity":"Low | Medium | High",

  "abnormalParameters":[
    {
      "parameter":"",
      "value":"",
      "normalRange":"",
      "status":"",
      "reason":""
    }
  ],

  "possibleDiseases":[],

  "recommendations":[],

  "dietPlan":[],

  "exercisePlan":[],

  "doctorAdvice":"",

  "followUpTests":[]
}
`;

    console.log("\n==========================================");
    console.log("🚀 Sending Report to Azure OpenAI");
    console.log("==========================================\n");

    console.log("📝 SYSTEM PROMPT:\n");
    console.log(systemPrompt);

    console.log("\n==========================================\n");

    console.log("📄 OCR TEXT SENT TO GPT:\n");
    console.log(ocrText);

    console.log("\n==========================================\n");

    const response =
      await client.chat.completions.create({

        model:
          process.env.AZURE_OPENAI_DEPLOYMENT,

        temperature: 0.2,

        response_format: {
          type: "json_object",
        },

        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: ocrText,
          },
        ],
      });

    console.log("✅ Azure OpenAI Response Received");

    console.log("\n==========================================\n");

    const content =
      response.choices[0].message.content;

    console.log("🤖 RAW GPT RESPONSE:\n");
    console.log(content);

    console.log("\n==========================================\n");

    const parsed =
      JSON.parse(content);

    console.log("✅ PARSED JSON:\n");
    console.log(
      JSON.stringify(
        parsed,
        null,
        2
      )
    );

    console.log("\n==========================================\n");

    return parsed;

  } catch (error) {

    console.log("\n==========================================");
    console.log("❌ AZURE OPENAI ERROR");
    console.log("==========================================");

    console.error(error);

    if (error.response) {

      console.log("\nResponse Data:\n");

      console.log(error.response.data);

    }

    console.log("==========================================\n");

    return {

      summary:
        "Unable to generate AI analysis.",

      severity:
        "Unknown",

      abnormalParameters: [],

      possibleDiseases: [],

      recommendations: [],

      dietPlan: [],

      exercisePlan: [],

      doctorAdvice: "",

      followUpTests: [],

    };

  }
};

module.exports = analyzeMedicalReport;