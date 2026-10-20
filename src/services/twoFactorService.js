const crypto = require("crypto");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Base32 Encode Buffer
 */
const base32Encode = (buffer) => {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
};

/**
 * Base32 Decode String to Buffer
 */
const base32Decode = (str) => {
  const clean = String(str || "")
    .toUpperCase()
    .replace(/=+$/, "")
    .replace(/[\s-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

/**
 * Compute 6-digit TOTP code for a counter value
 */
const computeTotp = (secretBase32, counter = Math.floor(Date.now() / 30000)) => {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter), 0);
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, "0");
};

/**
 * Verify TOTP code with time-drift window of ±1 step (±30s)
 */
const verifyTotpCode = (secretBase32, candidateCode) => {
  if (!secretBase32 || !candidateCode) return false;
  const codeStr = String(candidateCode).trim();
  if (codeStr.length !== 6) return false;

  const currentCounter = Math.floor(Date.now() / 30000);
  // Check -1, 0, +1 steps to allow slight clock drift
  for (let window = -1; window <= 1; window++) {
    const expected = computeTotp(secretBase32, currentCounter + window);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(codeStr))) {
      return true;
    }
  }
  return false;
};

/**
 * Hash a recovery code for secure database storage
 */
const hashRecoveryCode = (code) => {
  const salt = process.env.JWT_SECRET || "vaidyasthana_recovery_salt_default";
  return crypto.createHash("sha256").update(`${code.trim().toUpperCase()}:${salt}`).digest("hex");
};

/**
 * Generate 8 cryptographic recovery codes (formatted as XXXX-XXXX)
 */
const generateRecoveryCodes = (count = 8) => {
  const plaintextCodes = [];
  const hashedCodes = [];

  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(4).toString("hex").toUpperCase();
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
    plaintextCodes.push(formatted);
    hashedCodes.push({
      codeHash: hashRecoveryCode(formatted),
      used: false,
    });
  }

  return { plaintextCodes, hashedCodes };
};

/**
 * Initialize 2FA Setup
 */
const setupTwoFactor = (userEmail) => {
  const randomBytes = crypto.randomBytes(20);
  const secretBase32 = base32Encode(randomBytes);
  const appName = "Vaidyasthana";
  const label = encodeURIComponent(`${appName}:${userEmail}`);
  const otpauthUrl = `otpauth://totp/${label}?secret=${secretBase32}&issuer=${appName}&algorithm=SHA1&digits=6&period=30`;

  const { plaintextCodes, hashedCodes } = generateRecoveryCodes(8);

  return {
    secret: secretBase32,
    otpauthUrl,
    recoveryCodes: plaintextCodes,
    hashedRecoveryCodes: hashedCodes,
  };
};

/**
 * Validate and consume a single-use recovery code
 */
const consumeRecoveryCode = async (user, candidateCode) => {
  if (!user || !user.twoFactorRecoveryCodes || !candidateCode) return false;

  const inputHash = hashRecoveryCode(candidateCode);
  const match = user.twoFactorRecoveryCodes.find(
    (rc) => rc.codeHash === inputHash && !rc.used
  );

  if (!match) return false;

  match.used = true;
  await user.save();
  return true;
};

module.exports = {
  base32Encode,
  base32Decode,
  computeTotp,
  verifyTotpCode,
  setupTwoFactor,
  hashRecoveryCode,
  generateRecoveryCodes,
  consumeRecoveryCode,
};
