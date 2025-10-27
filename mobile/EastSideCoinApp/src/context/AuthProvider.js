// context/AuthProvider.js
import React, { createContext, useEffect, useState, useRef } from "react";
import { Text, Alert, AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";
import "react-native-get-random-values";
import Web3 from "web3";
import { navigationRef, resetNavigation } from "../navigation/NavigationService";
import { API_URL } from "../config";
// If you later move secrets to SecureStore, you can use it here:
// import * as SecureStore from "expo-secure-store";

export const AuthContext = createContext();

const AUTO_LOGOUT_TIME = 15 * 60 * 1000; // 15 minutes

const LOGOUT_REMOVE_KEYS = [
  "authToken",
  "refreshToken",
  "user",
  "privateKey",
  "keysGenerated",
  "publicKey_upload_pending",
];

// Global wipes (used in delete) — broad to guarantee a clean device.
const STORAGE_PREFIXES_TO_WIPE = [
  "privateKey_",            // per-user private keys (e.g., privateKey_3)
  "publicKey_",             // cached server pubkeys per user
  "esc_keys_v2:",           // any namespaced key bundles
  "chat_msgs_",             // (legacy, non-namespaced) per-thread message caches
  "chat_threads_index_v1",  // (legacy, non-namespaced) threads list cache
  "wallet_privateKey",      // wallet key generated on register
  "publicKey",              // global cached server public key
];

const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [authToken, setAuthToken] = useState(null);
  const [loading, setLoading] = useState(true);

  // UI hint (disable chat input until keys exist). Navigation does NOT depend on this.
  const [keysReady, setKeysReady] = useState(false);

  const inactivityTimerRef = useRef(null);

  useEffect(() => {
    restoreSession();
    const appStateListener = AppState.addEventListener("change", handleAppStateChange);
    return () => {
      appStateListener.remove();
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    };
  }, []);

  const handleAppStateChange = (next) => {
    if (next === "active") resetInactivityTimer();
  };

  const resetInactivityTimer = () => {
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    inactivityTimerRef.current = setTimeout(() => {
      Alert.alert("Session Expired", "You have been logged out due to inactivity.", [
        { text: "OK", onPress: logoutUser },
      ]);
    }, AUTO_LOGOUT_TIME);
  };

  const restoreSession = async () => {
    setLoading(true);
    try {
      const [storedToken, storedUser] = await Promise.all([
        AsyncStorage.getItem("authToken"),
        AsyncStorage.getItem("user"),
      ]);

      if (storedToken && storedUser) {
        setAuthToken(storedToken);
        setUser(JSON.parse(storedUser));
        resetInactivityTimer();
        // Do NOT navigate or generate keys here. KeyScreenSetup owns that.
        setKeysReady(false);
      } else {
        setUser(null);
        setAuthToken(null);
        setKeysReady(false);
      }
    } catch (err) {
      console.log("❌ Error restoring session:", err?.message || err);
      setUser(null);
      setAuthToken(null);
      setKeysReady(false);
    } finally {
      setLoading(false);
    }
  };

  const register = async (firstName, lastName, email, password) => {
    try {
      const web3 = new Web3();
      const newWallet = web3.eth.accounts.create();

      const payload = {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: email.trim().toLowerCase(),
        password,
        wallet_address: newWallet.address,
      };

      const res = await axios.post(`${API_URL}/register/`, payload);
      console.log("✅ Registration Successful:", res.data);

      await AsyncStorage.setItem("wallet_privateKey", newWallet.privateKey);

      // Immediately log in, but do not navigate; KeyScreenSetup will handle flow.
      const ok = await login(email, password, /* skipRedirect */ true);
      return !!ok;
    } catch (error) {
      console.error("❌ Registration Failed:", error.response?.data || error.message);
      Alert.alert("Registration Error", "Something went wrong. Try again.");
      return false;
    }
  };

  const login = async (email, password, skipRedirect = false) => {
    try {
      const { data } = await axios.post(`${API_URL}/login/`, { email, password });
      const { access, refresh, user: u } = data || {};

      if (!access || !u) {
        Alert.alert("Login Error", "Unexpected server response.");
        return false;
      }

      await Promise.all([
        AsyncStorage.setItem("authToken", access),
        AsyncStorage.setItem("refreshToken", refresh),
        AsyncStorage.setItem("user", JSON.stringify(u)),
      ]);

      // Cache server-side public key if present (client keygen/upload happens later on KeyScreenSetup)
      if (u.public_key) await AsyncStorage.setItem("publicKey", u.public_key);

      setAuthToken(access);
      setUser(u);
      resetInactivityTimer();

      // Do NOT generate keys or route to HomeTabs here.
      if (!skipRedirect && navigationRef?.isReady()) {
        // Safe nudge to KeyScreenSetup (your App stack initialRouteName is already KeyScreenSetup).
        resetNavigation("KeyScreenSetup");
      }

      return true;
    } catch (error) {
      console.error("❌ Login Failed:", error.response ? error.response.data : error.message);
      if (error.response?.status === 401) {
        Alert.alert("Login Error", "Invalid email or password.");
      } else {
        Alert.alert("Login Error", "Server error. Check API.");
      }
      return false;
    }
  };

  // Remove any keys that start with a given set of prefixes, or equal an exact key
  const removeByPrefixes = async (prefixes) => {
    try {
      const keys = await AsyncStorage.getAllKeys();
      if (!Array.isArray(keys) || keys.length === 0) return;
      const toRemove = keys.filter((k) => prefixes.some((p) => k === p || k.startsWith(p)));
      if (toRemove.length) {
        await AsyncStorage.multiRemove(toRemove);
        console.log("🧹 Removed keys:", toRemove);
      }
    } catch (e) {
      console.warn("⚠️ removeByPrefixes error:", e?.message || e);
    }
  };

  // Purge *namespaced* chat caches for the specific user (matches ChatScreen's `u<uid>:` scheme)
  const purgeUserChatCaches = async (uid) => {
    if (!uid) return;
    try {
      const prefix = `u${uid}:`;
      const keys = await AsyncStorage.getAllKeys();
      const toRemove = keys.filter(
        (k) =>
          k.startsWith(prefix + "chat_threads_index_v1") ||
          k.startsWith(prefix + "chat_msgs_")
      );
      if (toRemove.length) {
        await AsyncStorage.multiRemove(toRemove);
        console.log("🧼 Purged namespaced chat caches:", toRemove);
      }
    } catch (e) {
      console.warn("⚠️ purgeUserChatCaches error:", e?.message || e);
    }
  };

  const logoutUser = async () => {
    try {
      const [refreshToken, accessToken, privateKey, userData] = await Promise.all([
        AsyncStorage.getItem("refreshToken"),
        AsyncStorage.getItem("authToken"),
        AsyncStorage.getItem("privateKey"),
        AsyncStorage.getItem("user"),
      ]);

      if (refreshToken && accessToken) {
        try {
          await axios.post(
            `${API_URL}/logout/`,
            { token: refreshToken },
            { headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` } }
          );
        } catch (apiError) {
          console.warn("⚠️ Logout API Error:", apiError.response?.data || apiError.message);
        }
      }

      // Preserve per-user private key ONLY on logout (helps dev/login flow).
      let currentId = null;
      if (userData) {
        try { currentId = JSON.parse(userData)?.id; } catch {}
        if (privateKey && currentId) await AsyncStorage.setItem(`privateKey_${currentId}`, privateKey);
      }

      // Also purge this user's namespaced chat caches so a different user never sees stale previews.
      if (currentId) await purgeUserChatCaches(currentId);

      await AsyncStorage.multiRemove(LOGOUT_REMOVE_KEYS);

      setUser(null);
      setAuthToken(null);
      setKeysReady(false);

      if (navigationRef?.isReady()) resetNavigation("Landing");
      console.log("✅ User logged out cleanly.");
    } catch (error) {
      console.error("❌ Logout Failed:", error.message);
    }
  };

  // Full account deletion (server + local wipe)
  const deleteAccountAndLogout = async () => {
    try {
      const [accessToken, rawUser] = await Promise.all([
        AsyncStorage.getItem("authToken"),
        AsyncStorage.getItem("user"),
      ]);
      const currentUser = rawUser ? JSON.parse(rawUser) : null;
      const uid = currentUser?.id;

      if (!accessToken || !uid) {
        await wipeLocalAfterDelete(null);
        return;
      }

      const url = `${API_URL}/delete_account/`;
      const res = await axios.delete(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!(res.status === 204 || res.status === 200)) throw new Error(`Delete failed (status ${res.status})`);

      await wipeLocalAfterDelete(uid);
      console.log("✅ Account deleted and device data wiped.");
    } catch (err) {
      console.error("❌ Delete account error:", err?.response?.data || err?.message || err);
      Alert.alert("Delete Failed", "We couldn’t delete your account. Please try again.");
      throw err;
    }
  };

  const wipeLocalAfterDelete = async (uid) => {
    // Base removal list (auth/session + known fixed keys)
    const removal = [
      ...LOGOUT_REMOVE_KEYS,
      "wallet_privateKey",
      "chat_threads_index_v1",
      "publicKey",
    ];
    if (uid) {
      removal.push(`privateKey_${uid}`);
      removal.push(`publicKey_${uid}`);
      removal.push(`esc_keys_v2:${String(uid)}`);
    }

    try {
      await AsyncStorage.multiRemove(removal);
    } catch (e) {
      console.warn("⚠️ multiRemove baseline error:", e?.message || e);
    }

    // Purge namespaced chat caches for this user (u<uid>:chat_…)
    if (uid) await purgeUserChatCaches(uid);

    // Aggressive wipe: remove any remaining device keys & legacy chat caches (all users)
    await removeByPrefixes(STORAGE_PREFIXES_TO_WIPE);

    // OPTIONAL: If you store secrets in SecureStore, also clear here:
    // try {
    //   await SecureStore.deleteItemAsync("privateKey");
    //   if (uid) await SecureStore.deleteItemAsync(`privateKey_${uid}`);
    // } catch (e) {
    //   console.warn("⚠️ SecureStore wipe error:", e?.message || e);
    // }

    setUser(null);
    setAuthToken(null);
    setKeysReady(false);

    if (navigationRef?.isReady()) resetNavigation("Landing");
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        authToken,
        setAuthToken,
        register,
        login,
        logoutUser,
        deleteAccountAndLogout,
        resetInactivityTimer,
        keysReady,          // UI hint only; navigation is handled elsewhere
        setKeysReady,       // let KeyScreenSetup toggle after keygen/migration
      }}
    >
      {loading ? <Text>Loading...</Text> : children}
    </AuthContext.Provider>
  );
};

export default AuthProvider;
