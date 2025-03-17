import React, { createContext, useEffect, useState } from "react";
import { Text, Alert, AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";
import "react-native-get-random-values";
import Web3 from "web3";
import { navigationRef, resetNavigation } from "../navigation/NavigationService";
import { API_URL } from "../config";


export const AuthContext = createContext();

const AUTO_LOGOUT_TIME = 15 * 60 * 1000; // 15-minute auto-logout

const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [authToken, setAuthToken] = useState(null);
  const [loading, setLoading] = useState(true);
  let inactivityTimer = null;

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

  // ✅ Handle App State Changes (Background/Foreground)
  const handleAppStateChange = (nextAppState) => {
    if (nextAppState === "active") {
      resetInactivityTimer();
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

  // ✅ Register User & Auto-Login
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
        wallet_address: newWallet.address, // ✅ No public_key here
      };
  
      console.log("📡 Hitting API:", `${API_URL}/register/`);
      const response = await axios.post(`${API_URL}/register/`, userData);
  
      console.log("✅ Registration Successful:", response.data);
  
      if (!response.data || typeof response.data !== "object") {
        throw new Error("Invalid response from server.");
      }
  
      await AsyncStorage.setItem("wallet_privateKey", newWallet.privateKey);
  
      console.log("🚀 Auto-Logging In...");
      const loginSuccess = await login(email, password);
  
      if (loginSuccess) {
        console.log("✅ Auto-Login Successful! Redirecting...");
  
        if (response.data.requires_key_setup) {
          console.log("🔑 Redirecting to Key Setup...");
          setTimeout(() => resetNavigation("KeyScreenSetup"), 500); // ✅ Small delay ensures navigation is ready
        } else {
          console.log("✅ Registration Complete! Redirecting to Home...");
          setTimeout(() => resetNavigation("HomeTabs"), 500); // ✅ Delay for safety
        }
      } else {
        console.error("❌ Auto-Login Failed");
      }
    } catch (error) {
      console.error("❌ Registration Failed:", error.response?.data || error.message);
      Alert.alert("Registration Error", "Something went wrong. Try again.");
    }
  };
  
  


  // ✅ Login User
  const login = async (email, password) => {
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

      await AsyncStorage.setItem("authToken", access);
      await AsyncStorage.setItem("refreshToken", refresh);
      await AsyncStorage.setItem("user", JSON.stringify(user));

      setAuthToken(access);
      setUser(user);

      console.log("✅ Login Successful! Navigating...");

      // ✅ Ensure we correctly navigate after login
      resetNavigation("Home"); 

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

  // ✅ Logout User
  const logoutUser = async () => {
    try {
        console.log("📡 Sending Logout Request to API...");

        const refreshToken = await AsyncStorage.getItem("refreshToken");
        const accessToken = await AsyncStorage.getItem("authToken"); // ✅ Fetch access token

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
                            "Authorization": `Bearer ${accessToken}`, // ✅ Pass access token!
                        }
                    }
                );
                console.log("📡 API Logout Response:", response.data);
            } catch (apiError) {
                console.warn("⚠️ Logout API Error:", apiError.response?.data || apiError.message);
            }
        } else {
            console.warn("⚠️ No refresh token or access token found. Proceeding with local logout.");
        }

        // ✅ Clear AsyncStorage before logging out
        await AsyncStorage.clear();
        console.log("✅ Cleared AsyncStorage!");

        // ✅ Reset state
        setUser(null);
        setAuthToken(null);

        // ✅ Navigate back to Landing
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
    <AuthContext.Provider value={{ user, authToken, setAuthToken, register, login, logoutUser, resetInactivityTimer }}>
      {loading ? <Text>Loading...</Text> : children}
    </AuthContext.Provider>
  );
};

export default AuthProvider;
