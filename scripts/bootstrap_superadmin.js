/**
 * Vaidyasthana Super Admin Bootstrap Script
 *
 * Secure, idempotent administrative bootstrap script to initialize
 * the primary Super Administrator account in MongoDB Atlas.
 *
 * Usage:
 *   node scripts/bootstrap_superadmin.js
 *
 * Optional Environment Variables:
 *   SUPERADMIN_EMAIL    - Target superadmin email (default: superadmin@vaidyasthana.com)
 *   SUPERADMIN_PASSWORD - Secure password (if omitted, a cryptographically strong password is generated)
 *   SUPERADMIN_NAME     - Display name (default: Super Administrator)
 *   SUPERADMIN_PHONE    - Contact phone number
 *
 * Flag:
 *   --reset-password    - Explicitly forces a password reset for the superadmin account
 */
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const User = require("../src/models/User");
const { recordAuditEvent } = require("../src/services/auditService");

const runBootstrap = async () => {
  try {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
      console.error("[ERROR] MONGODB_URI not found in environment variables.");
      process.exit(1);
    }

    console.log("Connecting to MongoDB Atlas...");
    await mongoose.connect(uri);
    console.log("✔ Connected to MongoDB Atlas.");

    const email = (process.env.SUPERADMIN_EMAIL || "superadmin@vaidyasthana.com").toLowerCase().trim();
    const name = process.env.SUPERADMIN_NAME || "Chief Medical Governance Administrator";
    const phoneNumber = process.env.SUPERADMIN_PHONE || "+91 99999 00001";
    const address = "Vaidyasthana National Healthcare Governance Center, Bengaluru, Karnataka";

    const isForceReset = process.argv.includes("--reset-password");

    let existingSuperadmin = await User.findOne({ email });

    if (existingSuperadmin && !isForceReset) {
      // Idempotent: ensure role and active status are preserved
      let updated = false;
      if (existingSuperadmin.role !== "superadmin") {
        existingSuperadmin.role = "superadmin";
        updated = true;
      }
      if (existingSuperadmin.status !== "active") {
        existingSuperadmin.status = "active";
        updated = true;
      }
      if (updated) {
        await existingSuperadmin.save();
        console.log(`✔ Updated existing account (${email}) to active 'superadmin' role.`);
      } else {
        console.log(`✔ Super Administrator already configured and active (${email}). No changes needed.`);
      }

      await mongoose.disconnect();
      return process.exit(0);
    }

    // Determine secure password
    let plainPassword = process.env.SUPERADMIN_PASSWORD;
    let isGenerated = false;

    if (!plainPassword) {
      // Generate cryptographically strong random password if none provided
      plainPassword = `Vaidya!${crypto.randomBytes(8).toString("hex")}#`;
      isGenerated = true;
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(plainPassword, salt);

    if (existingSuperadmin && isForceReset) {
      existingSuperadmin.password = hashedPassword;
      existingSuperadmin.role = "superadmin";
      existingSuperadmin.status = "active";
      await existingSuperadmin.save();

      await recordAuditEvent({
        eventType: "SUPERADMIN_PASSWORD_RESET_CLI",
        actor: existingSuperadmin,
        action: "Superadmin password reset via CLI bootstrap script",
        outcome: "success",
        details: { email },
      });

      console.log(`✔ Successfully reset password for Super Administrator: ${email}`);
      if (isGenerated) {
        console.log(`\n🔑 ONE-TIME GENERATED CREDENTIALS (SAVE SECURELY):\n   Email:    ${email}\n   Password: ${plainPassword}\n`);
      }
    } else {
      const superadmin = await User.create({
        name,
        email,
        password: hashedPassword,
        phoneNumber,
        address,
        city: "Bengaluru",
        state: "Karnataka",
        postalCode: "560001",
        role: "superadmin",
        status: "active",
        verificationStatus: "verified",
      });

      await recordAuditEvent({
        eventType: "SUPERADMIN_BOOTSTRAP",
        actor: superadmin,
        action: "Initial Super Administrator provisioned via bootstrap script",
        outcome: "success",
        details: { email, name },
      });

      console.log(`✔ Successfully provisioned Super Administrator: ${email}`);
      if (isGenerated) {
        console.log(`\n🔑 ONE-TIME GENERATED CREDENTIALS (SAVE SECURELY):\n   Email:    ${email}\n   Password: ${plainPassword}\n`);
      }
    }

    await mongoose.disconnect();
    console.log("✔ Disconnected cleanly from Atlas. Bootstrap complete.");
    process.exit(0);
  } catch (err) {
    console.error("[ERROR] Bootstrap failed:", err.message);
    process.exit(1);
  }
};

runBootstrap();
