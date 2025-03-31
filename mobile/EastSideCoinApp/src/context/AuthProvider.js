import React, { createContext, useEffect, useState, useRef } from "react";
import { Text, Alert, AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";
import "react-native-get-random-values";
import Web3 from "web3";
import { navigationRef, resetNavigation } from "../navigation/NavigationService";
import { API_URL } from "../config";

export const AuthContext = createContext();

const AUTO_LOGOUT_TIME = 15 * 60 * 1000; // 15 minutes

const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [authToken, setAuthToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const inactivityTimerRef = useRef(null);

  useEffect(() => {
    checkUserSession();
    const appStateListener = AppState.addEventListener("change", handleAppStateChange);
    return () => {
      appStateListener.remove();
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    };
  }, []);

  // Restore session when app loads
  const checkUserSession = async () => {
    setLoading(true);
    try {
      const storedToken = await AsyncStorage.getItem("authToken");
      const storedUser = await AsyncStorage.getItem("user");
      if (storedToken && storedUser) {
        setAuthToken(storedToken);
        setUser(JSON.parse(storedUser));
        resetInactivityTimer();
      }
    } catch (error) {
      console.log("❌ Error restoring session:", error);
    } finally {
      setLoading(false);
    }
  };

  // Handle App State Changes
  const handleAppStateChange = (nextAppState) => {
    if (nextAppState === "active") {
      resetInactivityTimer();
    }
  };

  // Reset inactivity timer using a ref for persistence
  const resetInactivityTimer = () => {
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    inactivityTimerRef.current = setTimeout(() => {
      console.log("⏳ Auto-logout triggered.");
      Alert.alert("Session Expired", "You have been logged out due to inactivity.", [
        { text: "OK", onPress: logoutUser },
      ]);
    }, AUTO_LOGOUT_TIME);
  };

  // Register User & Auto-Login
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
        wallet_address: newWallet.address, // No public_key here
      };

      console.log("📡 Hitting API:", `${API_URL}/register/`);
      const response = await axios.post(`${API_URL}/register/`, userData);
      console.log("✅ Registration Successful:", response.data);

      if (!response.data || typeof response.data !== "object") {
        throw new Error("Invalid response from server.");
      }

      await AsyncStorage.setItem("wallet_privateKey", newWallet.privateKey);
      console.log("🚀 Auto-Logging In...");
      const loginSuccess = await login(email, password, true); // 👈 skipRedirect = true


      if (loginSuccess) {
        console.log("✅ Auto-Login Successful! Redirecting...");
        // Delay navigation slightly to allow any UI updates to settle
        setTimeout(() => {
          if (response.data.requires_key_setup) {
            console.log("🔑 Redirecting to Key Setup...");
            resetNavigation("KeyScreenSetup");
          } else {
            console.log("✅ Registration Complete! Redirecting to Home...");
            resetNavigation("HomeTabs");
          }
        }, 500);
      } else {
        console.error("❌ Auto-Login Failed");
      }
    } catch (error) {
      console.error("❌ Registration Failed:", error.response?.data || error.message);
      Alert.alert("Registration Error", "Something went wrong. Try again.");
    }
  };

  // Login User
  const login = async (email, password, skipRedirect = false) => {
    try {
      console.log("🚀 Attempting Login...");
      const response = await axios.post(`${API_URL}/login/`, { email, password });
      console.log("📡 Server Response:", response);
  
      if (typeof response.data !== "object") {
        console.error("❌ Unexpected Response:", response.data);
        Alert.alert("Login Error", "Unexpected server response. Try again.");
        return false;
      }
  
      const { access, refresh, user } = response.data;
  
      // ✅ Save tokens and user info
      await AsyncStorage.setItem("authToken", access);
      await AsyncStorage.setItem("refreshToken", refresh);
      await AsyncStorage.setItem("user", JSON.stringify(user));
  
      // ✅ Sync public key if it exists
      if (user.public_key) {
        await AsyncStorage.setItem("publicKey", user.public_key);
        console.log("🔑 Public key synced from server");
      } else {
        console.warn("⚠️ No public key found on server for this user.");
      }
  
      setAuthToken(access);
      setUser(user);
      console.log("✅ Login Successful!");
  
      if (!skipRedirect) {
        console.log("🚀 Resetting Navigation to HomeTabs");
        resetNavigation("HomeTabs");
      }
  
      return true;
    } catch (error) {
      console.error("❌ Login Failed:", error.response ? error.response.data : error.message);
      if (error.response && error.response.status === 401) {
        Alert.alert("Login Error", "Invalid email or password.");
      } else {
        Alert.alert("Login Error", "Server error. Check API.");
      }
      return false;
    }
  };
  
  

  // Logout User
  const logoutUser = async () => {
    try {
      console.log("📡 Sending Logout Request to API...");
      const refreshToken = await AsyncStorage.getItem("refreshToken");
      const accessToken = await AsyncStorage.getItem("authToken");
      const privateKey = await AsyncStorage.getItem("privateKey"); // 🛑 Backup before clearing
  
      if (refreshToken && accessToken) {
        console.log("🔑 Found refresh token:", refreshToken);
        console.log("🔐 Using access token:", accessToken);
        try {
          const response = await axios.post(
            `${API_URL}/logout/`,
            { token: refreshToken },
            {
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${accessToken}`,
              },
            }
          );
          console.log("📡 API Logout Response:", response.data);
        } catch (apiError) {
          console.warn("⚠️ Logout API Error:", apiError.response?.data || apiError.message);
        }
      } else {
        console.warn("⚠️ No refresh token or access token found. Proceeding with local logout.");
      }
  
      // 🧼 Clear all storage
      await AsyncStorage.clear();
  
      // 🔁 Restore private key
      if (privateKey) {
        await AsyncStorage.setItem("privateKey", privateKey);
        console.log("🔐 Private key restored after logout.");
      }
  
      setUser(null);
      setAuthToken(null);
  
      if (navigationRef && navigationRef.isReady()) {
        console.log("🚀 Resetting Navigation to Landing...");
        resetNavigation("Landing");
      } else {
        console.warn("⚠️ Navigation is NOT ready! Skipping resetNavigation.");
      }
  
      console.log("✅ User logged out successfully.");
    } catch (error) {
      console.error("❌ Logout Failed:", error.message);
    }
  };
  

  return (
    <AuthContext.Provider
      value={{ user, authToken, setAuthToken, register, login, logoutUser, resetInactivityTimer }}
    >
      {loading ? <Text>Loading...</Text> : children}
    </AuthContext.Provider>
  );
};

export default AuthProvider;
