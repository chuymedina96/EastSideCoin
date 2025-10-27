// utils/encryption.js
import CryptoJS from "crypto-js";
import forge from "node-forge";

/** ------------- helpers ------------- */
const toB64 = (wordArray) => CryptoJS.enc.Base64.stringify(wordArray);
const fromB64 = (b64) => CryptoJS.enc.Base64.parse(b64);

// Some servers/clients add newlines/spaces to base64; strip them.
const normalizeB64 = (s) => (s || "").replace(/\s+/g, "");

/** ------------- AES-CBC + HMAC-SHA256 ------------- */
/**
 * Encrypt-then-MAC
 * Returns: { ciphertextB64, ivB64, keyB64, macB64 }
 */
export const encryptAES = (plaintext) => {
  const key = CryptoJS.lib.WordArray.random(32);  // 256-bit
  const iv  = CryptoJS.lib.WordArray.random(16);  // 128-bit block size

  const encrypted = CryptoJS.AES.encrypt(
    CryptoJS.enc.Utf8.parse(plaintext),
    key,
    { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
  );

  const ctWA = encrypted.ciphertext;
  const mac  = CryptoJS.HmacSHA256(iv.clone().concat(ctWA), key); // EtM

  return {
    ciphertextB64: toB64(ctWA),
    ivB64: toB64(iv),
    keyB64: toB64(key),
    macB64: toB64(mac),
  };
};

/**
 * Decrypt (authenticating).
 * - Preferred: decryptAES({ ciphertextB64, ivB64, macB64, keyB64 })
 * - Legacy:    decryptAES(encryptedOpenSSLString, keyHexOrB64)
 */
export const decryptAES = (arg1, arg2) => {
  try {
    if (typeof arg1 === "object" && arg1 !== null) {
      const { ciphertextB64, ivB64, macB64, keyB64 } = arg1;
      if (!ciphertextB64 || !ivB64 || !macB64 || !keyB64) {
        throw new Error("Missing fields for authenticated decryption");
      }

      const key = fromB64(normalizeB64(keyB64));
      const iv  = fromB64(normalizeB64(ivB64));
      const ct  = fromB64(normalizeB64(ciphertextB64));
      const macExpected = fromB64(normalizeB64(macB64));

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

      return decrypted.toString(CryptoJS.enc.Utf8) || "[Decryption Failed]";
    }

    // Legacy OpenSSL format
    if (typeof arg1 === "string" && typeof arg2 === "string") {
      const encryptedText = arg1;
      const keyStr = arg2;

      let key;
      try {
        key = CryptoJS.enc.Hex.parse(keyStr);
        if (key.sigBytes !== 32) throw new Error();
      } catch {
        key = fromB64(normalizeB64(keyStr));
      }

      const decrypted = CryptoJS.AES.decrypt(encryptedText, key);
      return decrypted.toString(CryptoJS.enc.Utf8) || "[Decryption Failed]";
    }

    throw new Error("Unsupported decryptAES call signature");
  } catch (error) {
    console.error("❌ AES Decryption Error:", error);
    return "[Decryption Failed]";
  }
};

/** ------------- RSA-OAEP (SHA-256 + MGF1-SHA256) ------------- */
// IMPORTANT: use the SAME hash for both OAEP and MGF1.
const oaepParams = {
  md: forge.md.sha256.create(),
  mgf1: forge.mgf1.create(forge.md.sha256.create()),
};

/**
 * Encrypt base64 payload with PEM public key.
 * @param {string} dataB64 - base64 of raw bytes (e.g., AES key)
 * @param {string} publicKeyPEM
 * @returns {string} base64 ciphertext
 */
export const encryptRSA = (dataB64, publicKeyPEM) => {
  const publicKey = forge.pki.publicKeyFromPem(publicKeyPEM);
  const raw = forge.util.decode64(normalizeB64(dataB64));
  const encrypted = publicKey.encrypt(raw, "RSA-OAEP", oaepParams);
  return forge.util.encode64(encrypted);
};

/**
 * Decrypt base64 ciphertext with PEM private key.
 * Returns decrypted bytes as base64.
 */
export const decryptRSA = (encryptedB64, privateKeyPEM) => {
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPEM);
  const encBytes = forge.util.decode64(normalizeB64(encryptedB64));
  const decryptedBytes = privateKey.decrypt(encBytes, "RSA-OAEP", oaepParams);
  return forge.util.encode64(decryptedBytes);
};

/**
 * Safe variant that returns null instead of throwing.
 */
export const tryDecryptRSA = (encryptedB64, privateKeyPEM) => {
  try {
    return decryptRSA(encryptedB64, privateKeyPEM);
  } catch (e) {
    return null;
  }
};
