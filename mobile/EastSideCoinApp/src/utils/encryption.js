// utils/encryption.js
import CryptoJS from "crypto-js";
import forge from "node-forge";

/* -------------------- Base64 helpers (tolerant) -------------------- */
// Convert WordArray <-> Base64 (standard)
const toB64 = (wordArray) => CryptoJS.enc.Base64.stringify(wordArray);
const fromB64 = (b64) => CryptoJS.enc.Base64.parse(b64);

/**
 * Normalize base64 from various sources:
 * - strips whitespace/newlines
 * - converts URL-safe (-, _) to standard (+, /)
 * - fixes missing padding
 */
export const b64FixPadding = (s) => {
  if (!s) return s;
  let v = String(s).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = v.length % 4;
  if (pad) v += "=".repeat(4 - pad);
  return v;
};

/** Produce URL-safe base64 without padding (handy for URLs/ids) */
export const toUrlSafeB64 = (b64) =>
  (b64 || "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

/* ---------------- AES-CBC + HMAC-SHA256 (Encrypt-then-MAC) ----------------
   - MAC over (iv || ciphertext) using the *same* 32-byte key (client/server aligned).
   - Returns/accepts base64 fields.
--------------------------------------------------------------------------- */

/**
 * Encrypts a UTF-8 string.
 * @returns {{ciphertextB64:string, ivB64:string, keyB64:string, macB64:string}}
 */
export const encryptAES = (plaintext) => {
  const key = CryptoJS.lib.WordArray.random(32); // 256-bit
  const iv  = CryptoJS.lib.WordArray.random(16); // 128-bit block size

  const encrypted = CryptoJS.AES.encrypt(
    CryptoJS.enc.Utf8.parse(plaintext),
    key,
    { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
  );

  const ctWA = encrypted.ciphertext;
  const mac  = CryptoJS.HmacSHA256(iv.clone().concat(ctWA), key);

  return {
    ciphertextB64: toB64(ctWA),
    ivB64: toB64(iv),
    keyB64: toB64(key),
    macB64: toB64(mac),
  };
};

/**
 * Authenticated decrypt.
 * Supports:
 *   decryptAES({ ciphertextB64, ivB64, macB64 | tagB64, keyB64 })
 *   decryptAES(opensslString, keyHexOrB64)  // legacy
 * @returns {string} plaintext or "[Auth Failed]" / "[Decryption Failed]"
 */
export const decryptAES = (arg1, arg2) => {
  try {
    // Preferred object form
    if (typeof arg1 === "object" && arg1 !== null) {
      const { ciphertextB64, ivB64, keyB64 } = arg1;
      // accept macB64 or tagB64 alias
      const macOrTag = arg1.macB64 || arg1.tagB64;

      if (!ciphertextB64 || !ivB64 || !keyB64 || !macOrTag) {
        throw new Error("Missing fields for authenticated decryption");
      }

      const key = fromB64(b64FixPadding(keyB64));
      const iv  = fromB64(b64FixPadding(ivB64));
      const ct  = fromB64(b64FixPadding(ciphertextB64));
      const macExpected = fromB64(b64FixPadding(macOrTag));

      const macComputed = CryptoJS.HmacSHA256(iv.clone().concat(ct), key);
      if (toB64(macComputed) !== toB64(macExpected)) {
        console.warn("⚠️ AES MAC validation failed");
        return "[Auth Failed]";
      }

      const decrypted = CryptoJS.AES.decrypt(
        { ciphertext: ct },
        key,
        { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
      );

      const out = decrypted.toString(CryptoJS.enc.Utf8);
      return out || "[Decryption Failed]";
    }

    // Legacy OpenSSL format (kept for backward compatibility)
    if (typeof arg1 === "string" && typeof arg2 === "string") {
      const encryptedText = arg1;
      const keyStr = arg2;

      let key;
      try {
        // try hex first
        key = CryptoJS.enc.Hex.parse(keyStr);
        if (key.sigBytes !== 32) throw new Error("not 32-byte hex");
      } catch {
        key = fromB64(b64FixPadding(keyStr));
      }

      const decrypted = CryptoJS.AES.decrypt(encryptedText, key);
      const out = decrypted.toString(CryptoJS.enc.Utf8);
      return out || "[Decryption Failed]";
    }

    throw new Error("Unsupported decryptAES call signature");
  } catch (error) {
    console.error("❌ AES Decryption Error:", error?.message || error);
    return "[Decryption Failed]";
  }
};

/* ---------------- RSA-OAEP (SHA-256 + MGF1-SHA256) ----------------
   Matches server (cryptography) and RN forge usage.
------------------------------------------------------------------- */
const oaepParams = {
  md: forge.md.sha256.create(),
  mgf1: forge.mgf1.create(forge.md.sha256.create()),
};

/**
 * Encrypt base64 payload (e.g., AES key) with PEM public key → base64 ciphertext.
 */
export const encryptRSA = (dataB64, publicKeyPEM) => {
  const publicKey = forge.pki.publicKeyFromPem(publicKeyPEM);
  const raw = forge.util.decode64(b64FixPadding(dataB64));
  const encrypted = publicKey.encrypt(raw, "RSA-OAEP", oaepParams);
  return forge.util.encode64(encrypted);
};

/**
 * Decrypt base64 ciphertext with PEM private key → base64 of decrypted raw bytes.
 */
export const decryptRSA = (encryptedB64, privateKeyPEM) => {
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPEM);
  const encBytes = forge.util.decode64(b64FixPadding(encryptedB64));
  const decryptedBytes = privateKey.decrypt(encBytes, "RSA-OAEP", oaepParams);
  return forge.util.encode64(decryptedBytes);
};

/** Safe variant that returns null instead of throwing. */
export const tryDecryptRSA = (encryptedB64, privateKeyPEM) => {
  try {
    return decryptRSA(encryptedB64, privateKeyPEM);
  } catch {
    return null;
  }
};

export default {
  encryptAES,
  decryptAES,
  encryptRSA,
  decryptRSA,
  tryDecryptRSA,
  b64FixPadding,
  toUrlSafeB64,
};
