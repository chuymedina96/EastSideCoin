import CryptoJS from "crypto-js";
import forge from "node-forge";

// ✅ AES Encryption
export const encryptAES = (plaintext) => {
  const key = CryptoJS.lib.WordArray.random(32); // 256-bit key
  const iv = CryptoJS.lib.WordArray.random(16);
  const encrypted = CryptoJS.AES.encrypt(plaintext, key, { iv });
  return { encryptedText: encrypted.toString(), key: key.toString() };
};

// ✅ AES Decryption
export const decryptAES = (encryptedText, key) => {
  try {
    const decrypted = CryptoJS.AES.decrypt(encryptedText, key);
    return decrypted.toString(CryptoJS.enc.Utf8);
  } catch (error) {
    console.error("❌ AES Decryption Error:", error);
    return "[Decryption Failed]";
  }
};

// ✅ RSA Encryption (Encrypts AES Key)
export const encryptRSA = (aesKey, publicKeyPEM) => {
  const publicKey = forge.pki.publicKeyFromPem(publicKeyPEM);
  return forge.util.encode64(publicKey.encrypt(aesKey));
};
