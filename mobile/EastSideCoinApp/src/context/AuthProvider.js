import React, { createContext, useEffect, useState } from "react";
import { Text, Alert, AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";
import "react-native-get-random-values";
import Web3 from "web3";
import { navigationRef, resetNavigation } from "../navigation/NavigationService"; 

export const AuthContext = createContext();

const API_URL = "http://192.168.1.125:8000/api"; 
const AUTO_LOGOUT_TIME = 15 * 60 * 1000; 

const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [authToken, setAuthToken] = useState(null);
  const [loading, setLoading] = useState(true);
  let inactivityTimer = null;

  // ✅ Define `handleAppStateChange` BEFORE `useEffect`
  const handleAppStateChange = (nextAppState) => {
    if (nextAppState === "active") {
      resetInactivityTimer();
    }
  };

  useEffect(() => {
    checkUserSession();
    const appStateListener = AppState.addEventListener("change", handleAppStateChange);
    return () => appStateListener.remove();
  }, []);

  // ✅ Restore session when app loads
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

  // ✅ Reset inactivity timer
  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      console.log("⏳ Auto-logout triggered.");
      Alert.alert("Session Expired", "You have been logged out due to inactivity.", [
        { text: "OK", onPress: logoutUser },
      ]);
    }, AUTO_LOGOUT_TIME);
  };

  // ✅ Register User Function
  const register = async (firstName, lastName, email, password) => {
    try {
      console.log("🚀 Attempting Registration...");
  
      // ✅ Generate Ethereum Wallet Locally
      const web3 = new Web3(); // ✅ No provider needed (offline generation)
      const newWallet = web3.eth.accounts.create();
      console.log("🔑 Generated Wallet Address:", newWallet.address);
  
      // ✅ Prepare User Data
      const userData = {
        first_name: firstName,
        last_name: lastName,
        email,
        password,
        wallet_address: newWallet.address, // ✅ Send generated wallet address to backend
      };
  
      // ✅ Call Registration API
      console.log("📡 Hitting API:", `${API_URL}/register/`);
      const response = await axios.post(`${API_URL}/register/`, userData);
  
      console.log("✅ Registration Successful:", response.data);
  
      // ✅ Extract Tokens & User Info
      const { access, refresh, user } = response.data;
  
      // ✅ Store Tokens & User Info in AsyncStorage
      await AsyncStorage.setItem("authToken", access);
      await AsyncStorage.setItem("refreshToken", refresh);
      await AsyncStorage.setItem("user", JSON.stringify(user));
      await AsyncStorage.setItem("wallet_privateKey", newWallet.privateKey);
  
      console.log("✅ Auto-Login Successful!");
      
      // ✅ Update Auth Context
      setAuthToken(access);
      setUser(user);
  
      // ✅ Navigate to HomeTabs immediately
      resetNavigation("HomeTabs");
  
    } catch (error) {
      console.error("❌ Registration Failed:", error.response?.data || error.message);
      Alert.alert("Registration Error", "Something went wrong. Try again.");
    }
  };
  


  // ✅ Login
  const login = async (email, password) => {
    try {
      console.log("🚀 Attempting Login...");
      const response = await axios.post(`${API_URL}/login/`, { email, password });
  
      const { access, refresh, user } = response.data;
      await AsyncStorage.setItem("authToken", access);
      await AsyncStorage.setItem("refreshToken", refresh);
      await AsyncStorage.setItem("user", JSON.stringify(user));
  
      console.log("✅ Login Successful:", user.email);
  
      setAuthToken(access);
      setUser(user);
  
      resetInactivityTimer();
  
      // 🚀 Prevent multiple navigations by checking user state
      if (!navigationRef.isReady()) {
        console.warn("⚠️ Navigation not ready, retrying...");
        return;
      }
  
      if (navigationRef.getCurrentRoute()?.name !== "HomeTabs") {
        console.log("🚀 Navigating to HomeTabs...");
        resetNavigation("HomeTabs");
      } else {
        console.warn("⚠️ Already on HomeTabs, skipping navigation");
      }
  
    } catch (error) {
      console.error("❌ Login Failed:", error.response?.data || error.message);
      Alert.alert("Login Error", "Invalid email or password.");
    }
  };
  
  
  

  // ✅ Logout
  const logoutUser = async () => {
    try {
      console.log("📡 Sending Logout Request to API...");
  
      const refreshToken = await AsyncStorage.getItem("refreshToken");
      if (!refreshToken) {
        console.warn("⚠️ No refresh token found. Skipping API logout.");
      } else {
        // ✅ Call the API logout endpoint to blacklist refresh token
        const response = await axios.post(`${API_URL}/logout/`, { token: refreshToken }, {
          headers: { "Content-Type": "application/json" }
        });
  
        console.log("📡 API Logout Response:", response.data);
      }
  
      // ✅ Clear stored tokens
      await AsyncStorage.removeItem("authToken");
      await AsyncStorage.removeItem("refreshToken");
      await AsyncStorage.removeItem("user");
  
      // ✅ Reset user state
      setUser(null);
      setAuthToken(null);
      console.log("✅ Cleared Auth Storage & State");
  
      // ✅ Debug navigation
      if (navigationRef.isReady()) {
        console.log("🚀 Navigation is READY! Navigating to Landing...");
        resetNavigation("Landing");
      } else {
        console.warn("⚠️ Navigation is NOT ready! Cannot navigate yet.");
      }
  
      console.log("✅ User logged out successfully.");
    } catch (error) {
      console.error("❌ Logout Failed:", error.response?.data || error.message);
    }
  };

  return (
    <AuthContext.Provider value={{ user, authToken, setAuthToken, register, login, logoutUser, resetInactivityTimer }}>
      {loading ? <Text>Loading...</Text> : children}
    </AuthContext.Provider>
  );
};

export default AuthProvider;
