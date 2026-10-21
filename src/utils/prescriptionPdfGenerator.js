const PDFDocument = require("pdfkit");

/**
 * Generate a professional, clean medical prescription PDF stream using PDFKit
 *
 * @param {Object} prescription - Populated Prescription document
 * @param {Object} stream - Writable stream (e.g. Express res)
 */
const generatePrescriptionPDF = (prescription, stream) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: 40,
        info: {
          Title: `Prescription - ${prescription.prescriptionNumber}`,
          Author: prescription.doctorName || "Vaidyasthana Healthcare",
          Subject: `Medical Prescription for ${prescription.patientName}`,
          Creator: "Vaidyasthana Multi-Hospital Platform",
        },
      });

      doc.pipe(stream);

      // Colors
      const primaryColor = "#0d9488"; // Teal
      const darkColor = "#1e293b";    // Slate 800
      const mutedColor = "#64748b";   // Slate 500
      const lightBg = "#f8fafc";      // Slate 50
      const borderColor = "#e2e8f0";  // Slate 200

      // ==========================================
      // 1. HOSPITAL / CLINIC HEADER
      // ==========================================
      const facilityName = prescription.hospitalName || "Vaidyasthana Clinical Practice";
      doc.fontSize(18).fillColor(primaryColor).font("Helvetica-Bold").text(facilityName.toUpperCase(), { align: "left" });

      doc.fontSize(9).fillColor(mutedColor).font("Helvetica");
      let subDetails = [];
      if (prescription.hospitalCode) subDetails.push(`Hospital Code: ${prescription.hospitalCode}`);
      if (prescription.hospitalAddress) subDetails.push(prescription.hospitalAddress);
      if (prescription.hospitalPhone) subDetails.push(`Tel: ${prescription.hospitalPhone}`);

      if (subDetails.length > 0) {
        doc.text(subDetails.join(" | "), { align: "left" });
      } else {
        doc.text("Verified Healthcare SaaS Facility • Unified Patient Care & Records", { align: "left" });
      }

      doc.moveDown(0.5);
      doc.strokeColor(primaryColor).lineWidth(1.5).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(0.8);

      // ==========================================
      // 2. DOCTOR & PATIENT DETAILS (2 COLUMNS)
      // ==========================================
      const startInfoY = doc.y;

      // Left Column: Doctor Info
      doc.fillColor(darkColor).fontSize(11).font("Helvetica-Bold");
      const doctorTitle = prescription.doctorName?.startsWith("Dr.")
        ? prescription.doctorName
        : `Dr. ${prescription.doctorName || "Doctor"}`;
      doc.text(doctorTitle, 40, startInfoY);

      doc.fillColor(mutedColor).fontSize(9).font("Helvetica");
      doc.text(`${prescription.doctorSpecialization || "General Medicine"} • ${prescription.doctorQualifications || "MBBS"}`);
      if (prescription.doctorRegistrationNumber) {
        doc.text(`Medical Reg No: ${prescription.doctorRegistrationNumber}`);
      }

      // Right Column: Patient & Rx Info
      const rightColX = 330;
      doc.fillColor(primaryColor).fontSize(10).font("Helvetica-Bold");
      doc.text(`Prescription No: ${prescription.prescriptionNumber}`, rightColX, startInfoY, { align: "right", width: 225 });

      doc.fillColor(mutedColor).fontSize(9).font("Helvetica");
      const issueDate = prescription.createdAt
        ? new Date(prescription.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
        : new Date().toLocaleDateString("en-US");
      doc.text(`Date of Issue: ${issueDate}`, rightColX, doc.y, { align: "right", width: 225 });

      doc.fillColor(darkColor).fontSize(10).font("Helvetica-Bold");
      doc.text(`Patient: ${prescription.patientName}`, rightColX, doc.y + 4, { align: "right", width: 225 });

      doc.fillColor(mutedColor).fontSize(9).font("Helvetica");
      let patientMeta = [];
      if (prescription.patientAge) patientMeta.push(`Age: ${prescription.patientAge}`);
      if (prescription.patientGender) patientMeta.push(`Gender: ${prescription.patientGender}`);
      if (prescription.patientPhone) patientMeta.push(`Ph: ${prescription.patientPhone}`);
      if (patientMeta.length > 0) {
        doc.text(patientMeta.join(" | "), rightColX, doc.y, { align: "right", width: 225 });
      }

      // Advance past the higher column
      doc.y = Math.max(doc.y, startInfoY + 60);
      doc.moveDown(0.5);

      // ==========================================
      // 3. VITALS STRIP (IF PRESENT)
      // ==========================================
      const vitals = prescription.vitals || {};
      const vitalsList = [];
      if (vitals.bloodPressure) vitalsList.push(`BP: ${vitals.bloodPressure}`);
      if (vitals.pulseRate) vitalsList.push(`Pulse: ${vitals.pulseRate} bpm`);
      if (vitals.temperature) vitalsList.push(`Temp: ${vitals.temperature}`);
      if (vitals.weight) vitalsList.push(`Weight: ${vitals.weight}`);
      if (vitals.spo2) vitalsList.push(`SpO2: ${vitals.spo2}%`);

      if (vitalsList.length > 0) {
        doc.rect(40, doc.y, 515, 22).fillAndStroke(lightBg, borderColor);
        doc.fillColor(darkColor).fontSize(8.5).font("Helvetica-Bold").text("Vitals: ", 48, doc.y - 17, { continued: true });
        doc.font("Helvetica").fillColor(mutedColor).text(vitalsList.join("   •   "));
        doc.moveDown(0.8);
      }

      // ==========================================
      // 4. DIAGNOSIS / CLINICAL INDICATION
      // ==========================================
      doc.fillColor(primaryColor).fontSize(10).font("Helvetica-Bold").text("Clinical Indication / Diagnosis: ", 40, doc.y, { continued: true });
      doc.fillColor(darkColor).font("Helvetica").text(prescription.diagnosis);
      doc.moveDown(0.8);

      // ==========================================
      // 5. RX / MEDICATIONS TABLE
      // ==========================================
      doc.strokeColor(borderColor).lineWidth(1).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(0.5);

      // Rx Symbol
      doc.fillColor(primaryColor).fontSize(18).font("Helvetica-Bold").text("Rx", 40, doc.y);
      doc.moveDown(0.2);

      // Medications Table Header
      const tableTop = doc.y;
      doc.rect(40, tableTop, 515, 22).fillAndStroke("#f1f5f9", borderColor);

      doc.fillColor(darkColor).fontSize(8.5).font("Helvetica-Bold");
      doc.text("#", 45, tableTop + 6, { width: 20 });
      doc.text("Medication & Form", 70, tableTop + 6, { width: 170 });
      doc.text("Dosage", 245, tableTop + 6, { width: 65 });
      doc.text("Frequency & Timing", 315, tableTop + 6, { width: 130 });
      doc.text("Duration", 450, tableTop + 6, { width: 65 });
      doc.text("Route", 515, tableTop + 6, { width: 40 });

      let currentY = tableTop + 22;

      const formatFreq = (freq) => {
        switch (freq) {
          case "once_daily": return "Once daily";
          case "twice_daily": return "Twice daily";
          case "thrice_daily": return "Thrice daily";
          case "four_times_daily": return "4 times daily";
          case "as_needed": return "As needed";
          default: return freq ? freq.replace(/_/g, " ") : "As directed";
        }
      };

      const formatTiming = (timing) => {
        switch (timing) {
          case "before_food": return "Before meals";
          case "after_food": return "After meals";
          case "with_food": return "With food";
          case "empty_stomach": return "Empty stomach";
          default: return "";
        }
      };

      const medications = Array.isArray(prescription.medications) ? prescription.medications : [];
      medications.forEach((med, idx) => {
        const rowHeight = med.instructions ? 34 : 24;

        // Alternate zebra shading
        if (idx % 2 === 1) {
          doc.rect(40, currentY, 515, rowHeight).fill("#fafafa");
        }

        doc.fillColor(darkColor).fontSize(8.5).font("Helvetica-Bold");
        doc.text(String(idx + 1), 45, currentY + 5, { width: 20 });
        doc.text(med.name, 70, currentY + 5, { width: 170 });

        doc.font("Helvetica").fillColor(darkColor);
        doc.text(`${med.dosage} ${med.dosageUnit || "mg"}`, 245, currentY + 5, { width: 65 });

        const freqTiming = [formatFreq(med.frequency), formatTiming(med.timing)].filter(Boolean).join(" - ");
        doc.text(freqTiming, 315, currentY + 5, { width: 130 });
        doc.text(med.duration, 450, currentY + 5, { width: 65 });
        doc.text(med.route || "Oral", 515, currentY + 5, { width: 40 });

        if (med.instructions) {
          doc.font("Helvetica-Oblique").fontSize(7.5).fillColor(mutedColor);
          doc.text(`Note: ${med.instructions}`, 70, currentY + 18, { width: 440 });
        }

        doc.strokeColor(borderColor).lineWidth(0.5).moveTo(40, currentY + rowHeight).lineTo(555, currentY + rowHeight).stroke();
        currentY += rowHeight;
      });

      doc.y = currentY + 15;

      // ==========================================
      // 6. ADVICE & FOLLOW-UP INSTRUCTIONS
      // ==========================================
      if (prescription.generalInstructions) {
        doc.fillColor(primaryColor).fontSize(9.5).font("Helvetica-Bold").text("General Advice & Dietary / Lifestyle Instructions:");
        doc.fillColor(darkColor).fontSize(8.5).font("Helvetica").text(prescription.generalInstructions);
        doc.moveDown(0.6);
      }

      if (prescription.followUpDate) {
        const fuStr = new Date(prescription.followUpDate).toLocaleDateString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "short",
          day: "numeric",
        });
        doc.fillColor(primaryColor).fontSize(9).font("Helvetica-Bold").text("Recommended Follow-Up Date: ", { continued: true });
        doc.fillColor(darkColor).font("Helvetica").text(fuStr);
        doc.moveDown(0.8);
      }

      // ==========================================
      // 7. CLINICIAN DIGITAL SIGNATURE & VERIFICATION
      // ==========================================
      doc.moveDown(1.5);
      const signY = doc.y;

      doc.rect(340, signY, 215, 65).fillAndStroke(lightBg, borderColor);
      doc.fillColor(primaryColor).fontSize(8).font("Helvetica-Bold").text("DIGITALLY SIGNED & VERIFIED", 348, signY + 8);
      doc.fillColor(darkColor).fontSize(9.5).font("Helvetica-Bold").text(doctorTitle, 348, signY + 20);
      doc.fillColor(mutedColor).fontSize(7.5).font("Helvetica");
      if (prescription.doctorRegistrationNumber) {
        doc.text(`Reg No: ${prescription.doctorRegistrationNumber}`, 348, signY + 34);
      }
      const signDate = prescription.signedAt
        ? new Date(prescription.signedAt).toLocaleString("en-US")
        : new Date().toLocaleString("en-US");
      doc.text(`Signed At: ${signDate}`, 348, signY + 46);

      // ==========================================
      // 8. FOOTER
      // ==========================================
      doc.fontSize(7.5).fillColor(mutedColor).font("Helvetica");
      doc.text(
        "This digital prescription is generated electronically and securely signed by an authorized healthcare clinician on the Vaidyasthana Multi-Hospital Platform. It constitutes a legally compliant electronic medical record.",
        40,
        760,
        { align: "center", width: 515 }
      );

      let resolved = false;
      const safeResolve = () => {
        if (!resolved) {
          resolved = true;
          resolve(true);
        }
      };

      if (stream && typeof stream.on === "function") {
        stream.on("finish", safeResolve);
        stream.on("error", (err) => reject(err));
      }
      doc.on("end", safeResolve);
      doc.on("error", (err) => reject(err));

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
};

module.exports = {
  generatePrescriptionPDF,
};
