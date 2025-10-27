// context/AuthProvider.js
import React, { createContext, useEffect, useState, useRef } from "react";
import { Text, Alert, AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";
import "react-native-get-random-values";
import Web3 from "web3";
import { navigationRef, resetNavigation } from "../navigation/NavigationService";
import { API_URL } from "../config";
import { loadPrivateKeyForUser } from "../utils/keyManager";

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

const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [authToken, setAuthToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const inactivityTimerRef = useRef(null);
  const [keysReady, setKeysReady] = useState(false);

  useEffect(() => {
    checkUserSession();
    const appStateListener = AppState.addEventListener("change", handleAppStateChange);
    return () => {
      appStateListener.remove();
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    };
  }, []);

  const checkUserSession = async () => {
    setLoading(true);
    try {
      const storedToken = await AsyncStorage.getItem("authToken");
      const storedUser = await AsyncStorage.getItem("user");

      if (storedToken && storedUser) {
        const u = JSON.parse(storedUser);
        setAuthToken(storedToken);
        setUser(u);
        resetInactivityTimer();

        // Hydrate default slot from per-user key (if present)
        const priv = await loadPrivateKeyForUser(u.id); // this copies privateKey_{id} -> privateKey
        const pub = (await AsyncStorage.getItem("publicKey")) || u.public_key || null;

        const ready = Boolean(priv && pub);
        setKeysReady(ready);

        if (ready) {
          // already have keys, go to app
          if (navigationRef?.isReady()) resetNavigation("HomeTabs");
        } else {
          // no keys -> go to setup
          if (navigationRef?.isReady()) resetNavigation("KeyScreenSetup");
        }
      } else {
        setKeysReady(false);
      }
    } catch (error) {
      console.log("❌ Error restoring session:", error);
      setKeysReady(false);
    } finally {
      setLoading(false);
    }
  };

  const handleAppStateChange = (nextAppState) => {
    if (nextAppState === "active") resetInactivityTimer();
  };

  const resetInactivityTimer = () => {
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    inactivityTimerRef.current = setTimeout(() => {
      console.log("⏳ Auto-logout triggered.");
      Alert.alert("Session Expired", "You have been logged out due to inactivity.", [
        { text: "OK", onPress: logoutUser },
      ]);
    }, AUTO_LOGOUT_TIME);
  };

  const register = async (firstName, lastName, email, password) => {
    try {
      console.log("🚀 Attempting Registration...");
      const web3 = new Web3();
      const newWallet = web3.eth.accounts.create();
      console.log("🔑 Generated Wallet Address:", newWallet.address);

      const userData = {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: email.trim().toLowerCase(),
        password,
        wallet_address: newWallet.address,
      };

      console.log("📡 Hitting API:", `${API_URL}/register/`);
      const response = await axios.post(`${API_URL}/register/`, userData);
      console.log("✅ Registration Successful:", response.data);

      await AsyncStorage.setItem("wallet_privateKey", newWallet.privateKey);

      console.log("🚀 Auto-Logging In...");
      const ok = await login(email, password, true);

      if (ok) {
        // After login we decide where to go based on keys presence in login()
        return true;
      }
      return false;
    } catch (error) {
      console.error("❌ Registration Failed:", error.response?.data || error.message);
      Alert.alert("Registration Error", "Something went wrong. Try again.");
      return false;
    }
  };

  const login = async (email, password, skipRedirect = false) => {
    try {
      console.log("🚀 Attempting Login...");
      const response = await axios.post(`${API_URL}/login/`, { email, password });

      const { access, refresh, user: u } = response.data || {};
      if (!access || !u) {
        Alert.alert("Login Error", "Unexpected server response.");
        return false;
      }

      await Promise.all([
        AsyncStorage.setItem("authToken", access),
        AsyncStorage.setItem("refreshToken", refresh),
        AsyncStorage.setItem("user", JSON.stringify(u)),
      ]);

      // Cache server public key (if any)
      if (u.public_key) await AsyncStorage.setItem("publicKey", u.public_key);

      // Hydrate default privateKey from namespaced store (if present)
      const perUserKey = await AsyncStorage.getItem(`privateKey_${u.id}`);
      if (perUserKey) await AsyncStorage.setItem("privateKey", perUserKey);

      const pub = (await AsyncStorage.getItem("publicKey")) || u.public_key || null;
      const ready = Boolean(perUserKey && pub);

      setAuthToken(access);
      setUser(u);
      setKeysReady(ready);

      if (!skipRedirect) {
        if (ready) {
          resetNavigation("HomeTabs");
        } else {
          resetNavigation("KeyScreenSetup");
        }
      }

      return true;
    } catch (error) {
      console.error("❌ Login Failed:", error.response ? error.response.data : error.message);
      if (error.response?.status === 401) Alert.alert("Login Error", "Invalid email or password.");
      else Alert.alert("Login Error", "Server error. Check API.");
      return false;
    }
  };

  const logoutUser = async () => {
    try {
      console.log("📡 Sending Logout Request to API...");
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

      // Preserve per-user private key before clearing session
      if (userData) {
        const { id } = JSON.parse(userData);
        if (privateKey && id) {
          await AsyncStorage.setItem(`privateKey_${id}`, privateKey);
          console.log(`💾 Ensured privateKey_${id} stored.`);
        }
      }

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

  return (
    <AuthContext.Provider
      value={{
        user,
        authToken,
        setAuthToken,
        register,
        login,
        logoutUser,
        resetInactivityTimer,
        keysReady, // screens can still read this if needed
      }}
    >
      {loading ? <Text>Loading...</Text> : children}
    </AuthContext.Provider>
  );
};

export default AuthProvider;
