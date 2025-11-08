// context/AuthProvider.js
import React, { createContext, useEffect, useState, useRef, useCallback } from "react";
import { Text, Alert, AppState, Keyboard } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";
import "react-native-get-random-values";
import Web3 from "web3";
import { API_URL, WS_URL } from "../config";
import { setAuthToken as apiSetAuthToken, setTokenRefreshHandler } from "../utils/api";
import { createOrGetChatSocket, getExistingChatSocket, destroyAllChatSockets } from "../utils/wsClient";
import { resetNavigation } from "../navigation/NavigationService";

export const AuthContext = createContext();

const AUTO_LOGOUT_TIME = 15 * 60 * 1000;
const IDLE_POLL_MS = 15 * 1000;

const LOGOUT_REMOVE_KEYS = ["authToken", "refreshToken", "user", "privateKey", "keysGenerated", "publicKey_upload_pending"];

const STORAGE_PREFIXES_TO_WIPE = [
  "privateKey_",
  "publicKey_",
  "esc_keys_v2:",
  "chat_msgs_",
  "chat_threads_index_v1",
  "wallet_privateKey",
  "publicKey",
];

// small helper to yield a tick
const defer = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---- JWT helpers ----
function base64UrlDecode(str) {
  try {
    let s = (str || "").replace(/-/g, "+").replace(/_/g, "/");
    const pad = s.length % 4;
    if (pad) s += "=".repeat(4 - pad);
    if (typeof atob === "function") {
      const txt = decodeURIComponent(
        Array.prototype.map
          .call(atob(s), (c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
          .join("")
      );
      return txt;
    }
    if (typeof Buffer !== "undefined") return Buffer.from(s, "base64").toString("utf8");
  } catch {}
  return null;
}

function getJwtExp(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const json = base64UrlDecode(parts[1]);
    if (!json) return null;
    const payload = JSON.parse(json);
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [authToken, setAuthToken] = useState(null);
  const [refreshToken, setRefreshToken] = useState(null);
  const [tokenExp, setTokenExp] = useState(null); // unix seconds
  const [loading, setLoading] = useState(true);
  const [keysReady, setKeysReady] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // ws status for UI (peeked)
  const [wsReady, setWsReady] = useState(false);

  // activity + app state
  const appStateRef = useRef(AppState.currentState);
  const lastActivityAtRef = useRef(Date.now());
  const idlePollRef = useRef(null);

  const markActivity = useCallback(() => {
    lastActivityAtRef.current = Date.now();
  }, []);

  const resetInactivityTimer = useCallback(() => {
    markActivity();
  }, [markActivity]);

  const maybeRefreshToken = useCallback(
    async (force = false) => {
      if (!authToken || !refreshToken) return null;
      const now = Math.floor(Date.now() / 1000);
      const secondsLeft = (tokenExp ?? getJwtExp(authToken) ?? 0) - now;

      if (!force && secondsLeft > 30) return authToken;

      try {
        const { data } = await axios.post(`${API_URL}/refresh/`, { refresh: refreshToken });
        const newAccess = data?.access;
        const newExp = data?.exp ?? getJwtExp(newAccess);
        if (!newAccess) throw new Error("No access token in refresh response");

        setAuthToken(newAccess);
        setTokenExp(newExp);
        await AsyncStorage.setItem("authToken", newAccess);
        if (newExp) await AsyncStorage.setItem("authToken_exp", String(newExp));

        markActivity();
        return newAccess;
      } catch (e) {
        console.log("Token refresh failed:", e?.response?.data || e?.message || e);
        const now2 = Math.floor(Date.now() / 1000);
        if ((tokenExp ?? 0) <= now2) {
          await logoutUser();
        }
        return null;
      }
    },
    [authToken, refreshToken, tokenExp, markActivity]
  );

  const handleAppStateChange = useCallback(
    (next) => {
      appStateRef.current = next;
      if (next === "active") {
        markActivity();
        maybeRefreshToken(true);
        if (user?.id && authToken) {
          tryPreconnectSocket();
        }
      }
    },
    [markActivity, user?.id, authToken, maybeRefreshToken]
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", handleAppStateChange);
    const k1 = Keyboard.addListener("keyboardDidShow", markActivity);
    const k2 = Keyboard.addListener("keyboardDidHide", markActivity);
    return () => {
      sub.remove();
      k1.remove();
      k2.remove();
    };
  }, [handleAppStateChange, markActivity]);

  // ----- Session restore -----
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [storedToken, storedRefresh, storedUser] = await Promise.all([
          AsyncStorage.getItem("authToken"),
          AsyncStorage.getItem("refreshToken"),
          AsyncStorage.getItem("user"),
        ]);

        if (storedToken && storedUser) {
          const u = JSON.parse(storedUser);
          setAuthToken(storedToken);
          setRefreshToken(storedRefresh);
          setUser(u);

          const decodedExp = getJwtExp(storedToken);
          setTokenExp(decodedExp);

          const perUserKey = await AsyncStorage.getItem(`privateKey_${u.id}`);
          if (perUserKey) await AsyncStorage.setItem("privateKey", perUserKey);
          setKeysReady(!!perUserKey);

          markActivity();
        } else {
          setUser(null);
          setAuthToken(null);
          setRefreshToken(null);
          setTokenExp(null);
          setKeysReady(false);
        }
      } catch (err) {
        console.log("Error restoring session:", err?.message || err);
        setUser(null);
        setAuthToken(null);
        setRefreshToken(null);
        setTokenExp(null);
        setKeysReady(false);
      } finally {
        setLoading(false);
        setHydrated(true);
      }
    })();
  }, [markActivity]);

  // ----- Idle polling -----
  useEffect(() => {
    if (idlePollRef.current) clearInterval(idlePollRef.current);
    idlePollRef.current = setInterval(() => {
      const now = Date.now();
      const idleMs = now - lastActivityAtRef.current;

      const appBg = appStateRef.current !== "active";
      if (appBg && idleMs >= AUTO_LOGOUT_TIME) {
        logoutUser();
        return;
      }

      if (!appBg && idleMs >= AUTO_LOGOUT_TIME) {
        Alert.alert("Session Expiring", "You were inactive for a while. Stay signed in?", [
          { text: "Stay Signed In", onPress: markActivity },
          { text: "Log Out", style: "destructive", onPress: logoutUser },
        ]);
        lastActivityAtRef.current = now - (AUTO_LOGOUT_TIME - 60 * 1000);
      }
    }, IDLE_POLL_MS);

    return () => {
      if (idlePollRef.current) clearInterval(idlePollRef.current);
      idlePollRef.current = null;
    };
  }, [logoutUser, markActivity]);

  // ----- Background refresh ticker -----
  const refreshTickRef = useRef(null);
  useEffect(() => {
    refreshTickRef.current = setInterval(() => maybeRefreshToken(false), 4000);
    return () => {
      if (refreshTickRef.current) clearInterval(refreshTickRef.current);
      refreshTickRef.current = null;
    };
  }, [maybeRefreshToken]);

  const persistSession = useCallback(
    async ({ access, refresh, user: u, exp }) => {
      setAuthToken(access || null);
      setRefreshToken(refresh || null);
      setUser(u || null);
      setTokenExp(exp ?? getJwtExp(access));
      markActivity();

      await Promise.all([
        access ? AsyncStorage.setItem("authToken", access) : AsyncStorage.removeItem("authToken"),
        refresh ? AsyncStorage.setItem("refreshToken", refresh) : AsyncStorage.removeItem("refreshToken"),
        u ? AsyncStorage.setItem("user", JSON.stringify(u)) : AsyncStorage.removeItem("user"),
      ]);
    },
    [markActivity]
  );

  const getAccessToken = useCallback(async () => {
    if (!hydrated) {
      await new Promise((r) => {
        const i = setInterval(() => {
          if (hydrated) {
            clearInterval(i);
            r();
          }
        }, 25);
      });
    }
    if (!authToken) {
      console.log("Invalid Token: Token is invalid or expired");
      return null;
    }
    markActivity();
    const tok = await maybeRefreshToken(false);
    return tok || authToken;
  }, [hydrated, authToken, maybeRefreshToken, markActivity]);

  const refreshUser = useCallback(async () => {
    try {
      const tok = await getAccessToken();
      if (!tok) return null;
      const { data } = await axios.get(`${API_URL}/me/`, { headers: { Authorization: `Bearer ${tok}` } });
      if (data) {
        setUser(data);
        await AsyncStorage.setItem("user", JSON.stringify(data));
      }
      return data;
    } catch (e) {
      console.warn("refreshUser error:", e?.response?.data || e?.message || e);
      return null;
    }
  }, [getAccessToken]);

  useEffect(() => {
    apiSetAuthToken(() => getAccessToken());
    setTokenRefreshHandler(async () => {
      const tok = await maybeRefreshToken(true);
      return tok || null;
    });
  }, [getAccessToken, maybeRefreshToken]);

  // ====== WebSocket preconnect (singleton) ======
  const tryPreconnectSocket = useCallback(async () => {
    if (!user?.id) return;
    const token = await getAccessToken();
    if (!token) return;

    const sub = createOrGetChatSocket({
      token: () => getAccessToken(),
      baseUrl: WS_URL,
      path: "/chat/",
      userId: user.id,
      prefer: "query",
      onOpen: () => {
        setWsReady(true);
        markActivity();
      },
      onClose: () => setWsReady(false),
      onError: () => setWsReady(false),
      onMessage: () => {
        try { markActivity(); } catch {}
      },
    });

    try {
      await sub.ready();
      setWsReady(!!sub?.socket?.ready);
    } catch {
      setWsReady(false);
    }
  }, [user?.id, getAccessToken, markActivity]);

  useEffect(() => {
    if (hydrated && user?.id && authToken) {
      tryPreconnectSocket();
    }
  }, [hydrated, user?.id, authToken, tryPreconnectSocket]);

  useEffect(() => {
    const id = setInterval(() => {
      const api = getExistingChatSocket();
      const ready = !!api?.socket?.ready;
      setWsReady(ready);
    }, 1500);
    return () => clearInterval(id);
  }, []);

  // ----- Auth flows (no manual nav except logout/delete) -----
  const register = useCallback(
    async (firstName, lastName, email, password) => {
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

        await axios.post(`${API_URL}/register/`, payload);
        await AsyncStorage.setItem("wallet_privateKey", newWallet.privateKey);
        return await login(email, password);
      } catch (error) {
        console.error("Registration Failed:", error.response?.data || error.message);
        Alert.alert("Registration Error", "Something went wrong. Try again.");
        return false;
      }
    },
    [login]
  );

  const login = useCallback(
    async (email, password) => {
      try {
        const { data } = await axios.post(`${API_URL}/login/`, { email, password });
        const { access, refresh, user: u, exp } = data || {};
        if (!access || !u) {
          Alert.alert("Login Error", "Unexpected server response.");
          return false;
        }

        await persistSession({ access, refresh, user: u, exp });

        if (u.public_key) await AsyncStorage.setItem("publicKey", u.public_key);

        const perUserKey = await AsyncStorage.getItem(`privateKey_${u.id}`);
        if (perUserKey) await AsyncStorage.setItem("privateKey", perUserKey);
        setKeysReady(!!perUserKey);

        markActivity();
        tryPreconnectSocket();
        return true;
      } catch (error) {
        console.error("Login Failed:", error.response ? error.response.data : error.message);
        if (error.response?.status === 401) {
          Alert.alert("Login Error", "Invalid email or password.");
        } else {
          Alert.alert("Login Error", "Server error. Check API.");
        }
        return false;
      }
    },
    [persistSession, tryPreconnectSocket, markActivity]
  );

  const removeByPrefixes = useCallback(async (prefixes) => {
    try {
      const keys = await AsyncStorage.getAllKeys();
      if (!Array.isArray(keys) || keys.length === 0) return;
      const toRemove = keys.filter((k) => prefixes.some((p) => k === p || k.startsWith(p)));
      if (toRemove.length) await AsyncStorage.multiRemove(toRemove);
    } catch (e) {
      console.warn("removeByPrefixes error:", e?.message || e);
    }
  }, []);

  const purgeUserChatCaches = useCallback(async (uid) => {
    if (!uid) return;
    try {
      const prefix = `u${uid}:`;
      const keys = await AsyncStorage.getAllKeys();
      const toRemove = keys.filter(
        (k) => k.startsWith(prefix + "chat_threads_index_v1") || k.startsWith(prefix + "chat_msgs_")
      );
      if (toRemove.length) await AsyncStorage.multiRemove(toRemove);
    } catch (e) {
      console.warn("purgeUserChatCaches error:", e?.message || e);
    }
  }, []);

  const logoutUser = useCallback(async () => {
    try {
      const [refreshTok, accessTok, privateKeyVal, userData] = await Promise.all([
        AsyncStorage.getItem("refreshToken"),
        AsyncStorage.getItem("authToken"),
        AsyncStorage.getItem("privateKey"),
        AsyncStorage.getItem("user"),
      ]);

      if (refreshTok && accessTok) {
        try {
          await axios.post(`${API_URL}/logout/`, { token: refreshTok }, { headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessTok}` } });
        } catch (apiError) {
          console.warn("Logout API Error:", apiError.response?.data || apiError.message);
        }
      }

      let currentId = null;
      if (userData) {
        try { currentId = JSON.parse(userData)?.id; } catch {}
        if (privateKeyVal && currentId) await AsyncStorage.setItem(`privateKey_${currentId}`, privateKeyVal);
      }

      if (currentId) await purgeUserChatCaches(currentId);
      await AsyncStorage.multiRemove(LOGOUT_REMOVE_KEYS);

      setUser(null);
      setAuthToken(null);
      setRefreshToken(null);
      setTokenExp(null);
      setKeysReady(false);

      apiSetAuthToken(null);

      try { destroyAllChatSockets(); } catch {}
      setWsReady(false);

      // Let the tree flip to AuthNavigator, then hard-reset to Landing to clear any nested state
      await defer(0);
      resetNavigation("Landing");
    } catch (error) {
      console.error("Logout Failed:", error.message);
    }
  }, [purgeUserChatCaches]);

  const deleteAccountAndLogout = useCallback(async () => {
    try {
      const [accessTokenLocal, rawUser] = await Promise.all([
        AsyncStorage.getItem("authToken"),
        AsyncStorage.getItem("user"),
      ]);
      const currentUser = rawUser ? JSON.parse(rawUser) : null;
      const uid = currentUser?.id;

      if (!accessTokenLocal || !uid) {
        await wipeLocalAfterDelete(null);
        return;
      }

      const res = await axios.delete(`${API_URL}/delete_account/`, { headers: { Authorization: `Bearer ${accessTokenLocal}` } });
      if (!(res.status === 204 || res.status === 200)) throw new Error(`Delete failed (status ${res.status})`);

      await wipeLocalAfterDelete(uid);
    } catch (err) {
      console.error("Delete account error:", err?.response?.data || err?.message || err);
      Alert.alert("Delete Failed", "We couldn’t delete your account. Please try again.");
      throw err;
    }
  }, []);

  const wipeLocalAfterDelete = useCallback(
    async (uid) => {
      const removal = [...LOGOUT_REMOVE_KEYS, "wallet_privateKey", "chat_threads_index_v1", "publicKey"];
      if (uid) {
        removal.push(`privateKey_${uid}`);
        removal.push(`publicKey_${uid}`);
        removal.push(`esc_keys_v2:${String(uid)}`);
      }

      try {
        await AsyncStorage.multiRemove(removal);
      } catch (e) {
        console.warn("multiRemove baseline error:", e?.message || e);
      }

      if (uid) await purgeUserChatCaches(uid);
      await removeByPrefixes(STORAGE_PREFIXES_TO_WIPE);

      setUser(null);
      setAuthToken(null);
      setRefreshToken(null);
      setTokenExp(null);
      setKeysReady(false);

      apiSetAuthToken(null);

      try { destroyAllChatSockets(); } catch {}
      setWsReady(false);

      // Same safety reset after the tree flips
      await defer(0);
      resetNavigation("Landing");
    },
    [purgeUserChatCaches, removeByPrefixes]
  );

  return (
    <AuthContext.Provider
      value={{
        hydrated,
        user,
        authToken,
        getAccessToken,
        refreshUser,
        register,
        login,
        logoutUser,
        deleteAccountAndLogout,
        resetInactivityTimer,
        keysReady,
        setKeysReady,
        wsReady,
      }}
    >
      {loading ? <Text>Loading...</Text> : children}
    </AuthContext.Provider>
  );
};

export default AuthProvider;
