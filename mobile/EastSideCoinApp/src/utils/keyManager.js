// utils/keyManager.js
import AsyncStorage from "@react-native-async-storage/async-storage";
import forge from "node-forge";
import axios from "axios";
import { API_URL } from "../config";

export async function savePrivateKeyForUser(userId, privateKeyPem) {
  if (!userId || !privateKeyPem) return;
  await AsyncStorage.setItem(`privateKey_${userId}`, privateKeyPem);
  await AsyncStorage.setItem("privateKey", privateKeyPem); // legacy slot hydration
}

export async function loadPrivateKeyForUser(userId) {
  if (!userId) return null;
  const perUser = await AsyncStorage.getItem(`privateKey_${userId}`);
  if (perUser) {
    await AsyncStorage.setItem("privateKey", perUser);
    return perUser;
  }
  return AsyncStorage.getItem("privateKey");
}

export async function isKeysReady(userId) {
  const priv = await AsyncStorage.getItem(`privateKey_${userId}`);
  const pub  = await AsyncStorage.getItem("publicKey");
  return Boolean(priv && pub);
}

export async function generateAndUploadKeys({ userId, authToken, onProgress }) {
  const p = (v, msg) => onProgress?.(v, msg);

  p(10, "Generating RSA key pair…");
  const keyPair = forge.pki.rsa.generateKeyPair({ bits: 2048 });

  const publicKeyPem  = forge.pki.publicKeyToPem(keyPair.publicKey);
  const privateKeyPem = forge.pki.privateKeyToPem(keyPair.privateKey);

  p(40, "Saving keys locally…");
  await savePrivateKeyForUser(userId, privateKeyPem);
  await AsyncStorage.setItem("publicKey", publicKeyPem);

  p(70, "Uploading public key…");
  await axios.post(
    `${API_URL}/generate_keys/`,
    { public_key: publicKeyPem.trim() },
    { headers: { Authorization: `Bearer ${authToken}` } }
  );

  await AsyncStorage.setItem("keysGenerated", "true");
  p(100, "Key setup complete");
}

export async function ensureKeysForCurrentUser({ background = true, setKeysReady }) {
  const rawUser = await AsyncStorage.getItem("user");
  const authToken = await AsyncStorage.getItem("authToken");
  const user = rawUser ? JSON.parse(rawUser) : null;

  if (!user?.id || !authToken) {
    setKeysReady?.(false);
    return;
  }

  // Already ready?
  if (await isKeysReady(user.id)) {
    await loadPrivateKeyForUser(user.id); // hydrate legacy slot
    setKeysReady?.(true);
    return;
  }

  const runner = async () => {
    try {
      await generateAndUploadKeys({
        userId: user.id,
        authToken,
        onProgress: () => {}
      });
      setKeysReady?.(true);
    } catch (e) {
      console.warn("Key ensure failed:", e?.message || e);
      setKeysReady?.(false);
    }
  };

  if (background) {
    // Defer so UI stays responsive
    setTimeout(runner, 0);
  } else {
    await runner();
  }
}
