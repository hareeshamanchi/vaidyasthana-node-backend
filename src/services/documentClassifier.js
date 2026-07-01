const OpenAI = require("openai");

const client = new OpenAI({
    apiKey: process.env.AZURE_OPENAI_KEY,
    baseURL:
    `${process.env.AZURE_OPENAI_ENDPOINT}/openai/v1`,
});

const classifyDocument = async (ocrText)=>{

    const response =
    await client.chat.completions.create({

        model:
        process.env.AZURE_OPENAI_DEPLOYMENT,

        temperature:0,

        response_format:{
            type:"json_object"
        },

        messages:[

        {
            role:"system",

            content:`
You are an expert hospital document classifier.

Read the OCR text.

Return ONLY JSON.

{
"documentType":"",
"isMedical":true
}

Possible document types

Blood Report
Prescription
Discharge Summary
Radiology Report
MRI Report
CT Scan
Ultrasound
ECG
Medical Certificate
Insurance Claim
Invoice
Lab Report
Urine Report
Biopsy Report
Vaccination Record
Other
`
        },

        {
            role:"user",

            content:ocrText
        }

        ]

    });

    return JSON.parse(
        response.choices[0].message.content
    );

}

module.exports = classifyDocument;