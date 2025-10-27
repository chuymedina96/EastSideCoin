// utils/keyManager.js
import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";
import { API_URL } from "../config";

// Optional deps (loaded defensively so the app runs even if not installed)
let forge = null;
try { forge = require("node-forge"); } catch (_) {}
let RSA_NATIVE = null;
try { RSA_NATIVE = require("react-native-rsa-native"); } catch (_) {}

const NAMESPACE = "esc_keys_v2";
const ns = (userId) => `${NAMESPACE}:${String(userId ?? "anon")}`;

async function saveKeypairForUser(userId, { publicKeyPem, privateKeyPem }) {
  if (!userId || !publicKeyPem || !privateKeyPem) return;
  const payload = JSON.stringify({
    publicKeyPem: publicKeyPem.trim(),
    privateKeyPem: privateKeyPem.trim(),
    version: 2,
    createdAt: Date.now(),
  });
  await AsyncStorage.setItem(ns(userId), payload);

  // Hydrate legacy slots for any old code paths still reading them
  await AsyncStorage.setItem(`privateKey_${userId}`, privateKeyPem);
  await AsyncStorage.setItem("privateKey", privateKeyPem);
  await AsyncStorage.setItem("publicKey", publicKeyPem);
}

export async function loadPrivateKeyForUser(userId) {
  if (!userId) return null;

  // v2 record first
  const v2 = await AsyncStorage.getItem(ns(userId));
  if (v2) {
    const parsed = JSON.parse(v2);
    const priv = parsed?.privateKeyPem ?? null;
    if (priv) {
      await AsyncStorage.setItem(`privateKey_${userId}`, priv);
      await AsyncStorage.setItem("privateKey", priv);
    }
    return priv;
  }

  // fallbacks (pre-migration)
  const perUser = await AsyncStorage.getItem(`privateKey_${userId}`);
  if (perUser) {
    await AsyncStorage.setItem("privateKey", perUser);
    return perUser;
  }
  return AsyncStorage.getItem("privateKey");
}

export async function loadPublicKeyForUser(userId) {
  if (!userId) return null;

  const v2 = await AsyncStorage.getItem(ns(userId));
  if (v2) {
    const parsed = JSON.parse(v2);
    const pub = parsed?.publicKeyPem ?? null;
    if (pub) await AsyncStorage.setItem("publicKey", pub);
    return pub;
  }

  return AsyncStorage.getItem("publicKey");
}

export async function isKeysReady(userId) {
  if (!userId) return false;
  const v2 = await AsyncStorage.getItem(ns(userId));
  if (v2) {
    const { privateKeyPem, publicKeyPem } = JSON.parse(v2) || {};
    return Boolean(privateKeyPem && publicKeyPem);
  }
  const priv = await AsyncStorage.getItem(`privateKey_${userId}`);
  const pub  = await AsyncStorage.getItem("publicKey");
  return Boolean(priv && pub);
}

/** Soft progress ticker so UI keeps moving during heavy steps */
function startTicker({ from = 10, to = 35, step = 1, intervalMs = 180, onProgress }) {
  let val = from;
  onProgress?.(val);
  const id = setInterval(() => {
    val = Math.min(val + step, to - 1);
    onProgress?.(val);
    if (val >= to - 1) clearInterval(id);
  }, intervalMs);
  return () => clearInterval(id);
}

/** RSA generation (prefers native async, falls back to forge) */
async function generateRsaKeypairAsync({ bits = 2048 } = {}) {
  if (RSA_NATIVE?.generateKeys) {
    const { public: publicKeyPem, private: privateKeyPem } = await RSA_NATIVE.generateKeys(bits);
    return { publicKeyPem, privateKeyPem };
  }
  if (!forge) throw new Error("RSA library not available (install node-forge or react-native-rsa-native)");
  // Let UI render initial progress before sync block
  await new Promise((r) => setTimeout(r, 0));
  const keyPair = forge.pki.rsa.generateKeyPair({ bits });
  const publicKeyPem  = forge.pki.publicKeyToPem(keyPair.publicKey);
  const privateKeyPem = forge.pki.privateKeyToPem(keyPair.privateKey);
  return { publicKeyPem, privateKeyPem };
}

/**
 * Migrates any existing legacy keys into the v2 namespaced record.
 * Safe to call repeatedly.
 */
async function migrateLegacyKeys(userId) {
  if (!userId) return null;

  const existing = await AsyncStorage.getItem(ns(userId));
  if (existing) return JSON.parse(existing);

  const privPerUser = await AsyncStorage.getItem(`privateKey_${userId}`);
  const privLegacy  = await AsyncStorage.getItem("privateKey");
  const pubLegacy   = await AsyncStorage.getItem("publicKey");

  const privateKeyPem = (privPerUser || privLegacy)?.trim();
  const publicKeyPem  = (pubLegacy)?.trim();

  if (privateKeyPem && publicKeyPem) {
    await saveKeypairForUser(userId, { privateKeyPem, publicKeyPem });
    return { privateKeyPem, publicKeyPem, version: 2, migratedFrom: "legacy" };
  }

  return null; // nothing to migrate
}

export async function generateAndUploadKeys({ userId, authToken, onProgress }) {
  const p = (v, msg) => onProgress?.(Math.max(0, Math.min(100, v)), msg);

  // If a migration is possible, do it and short-circuit
  const migrated = await migrateLegacyKeys(userId);
  if (migrated?.privateKeyPem && migrated?.publicKeyPem) {
    try {
      p?.(70, "Uploading public key…");
      const stop = startTicker({ from: 70, to: 85, step: 1, intervalMs: 120, onProgress: p });
      await axios.post(
        `${API_URL}/generate_keys/`,
        { public_key: migrated.publicKeyPem },
        { headers: { Authorization: `Bearer ${authToken}` } }
      );
      stop();
    } catch (e) {
      console.warn("Public key upload (post-migration) failed:", e?.message || e);
    }
    await AsyncStorage.setItem("keysGenerated", "true");
    p?.(100, "Key setup complete");
    return migrated;
  }

  // Fresh generation with smoother progress
  p?.(10, "Generating RSA key pair…");
  const stopGen = startTicker({ from: 10, to: 35, step: 1, intervalMs: 180, onProgress: p });
  const { publicKeyPem, privateKeyPem } = await generateRsaKeypairAsync({ bits: 2048 });
  stopGen?.();

  p?.(40, "Saving keys locally…");
  await saveKeypairForUser(userId, { publicKeyPem, privateKeyPem });

  p?.(55, "Uploading public key…");
  const stopUp = startTicker({ from: 55, to: 85, step: 1, intervalMs: 140, onProgress: p });
  try {
    await axios.post(
      `${API_URL}/generate_keys/`,
      { public_key: publicKeyPem.trim() },
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
  } catch (e) {
    console.warn("Public key upload failed:", e?.message || e);
    // Keep going; local keys exist. You can re-upload later.
  } finally {
    stopUp?.();
  }

  await AsyncStorage.setItem("keysGenerated", "true");
  p?.(100, "Key setup complete");
  return { publicKeyPem, privateKeyPem, version: 2 };
}

/**
 * Ensures keys exist for the current user. Stays API-compatible with your old callsite.
 * Also hydrates legacy slots so older code that still reads them won’t break.
 */
export async function ensureKeysForCurrentUser({ background = true, setKeysReady }) {
  const rawUser   = await AsyncStorage.getItem("user");
  const authToken = await AsyncStorage.getItem("authToken");
  const user = rawUser ? JSON.parse(rawUser) : null;

  if (!user?.id || !authToken) {
    setKeysReady?.(false);
    return;
  }

  if (await isKeysReady(user.id)) {
    await loadPrivateKeyForUser(user.id);
    await loadPublicKeyForUser(user.id);
    setKeysReady?.(true);
    return;
  }

  const runner = async () => {
    try {
      await generateAndUploadKeys({
        userId: user.id,
        authToken,
        onProgress: () => {}, // background mode doesn’t need UI progress
      });
      setKeysReady?.(true);
    } catch (e) {
      console.warn("Key ensure failed:", e?.message || e);
      setKeysReady?.(false);
    }
  };

  if (background) setTimeout(runner, 0);
  else await runner();
}
