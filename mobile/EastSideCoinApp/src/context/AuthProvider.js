import React, { createContext, useEffect, useState } from "react";
import { Text, Alert, AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage"; // ✅ Correct Import
import axios from "axios";
import { navigate, resetNavigation } from "../navigation/NavigationService";

export const AuthContext = createContext();

const API_URL = "http://192.168.1.125:8000/api"; // ✅ Your API
const AUTO_LOGOUT_TIME = 15 * 60 * 1000; // ✅ Auto logout after 15 min

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

  // ✅ Logout after inactivity
  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      console.log("⏳ Auto-logout triggered.");
      Alert.alert("Session Expired", "You have been logged out due to inactivity.", [
        { text: "OK", onPress: logoutUser },
      ]);
    }, AUTO_LOGOUT_TIME);
  };

  // ✅ Refresh token
  const refreshSession = async () => {
    try {
      const refreshToken = await AsyncStorage.getItem("refreshToken");
      if (!refreshToken) {
        logoutUser();
        return;
      }

      const response = await axios.post(`${API_URL}/token/refresh/`, { refresh: refreshToken });
      const newAccessToken = response.data.access;
      await AsyncStorage.setItem("authToken", newAccessToken);
      setAuthToken(newAccessToken);
      resetInactivityTimer();
    } catch (error) {
      console.error("❌ Token refresh failed:", error.response?.data || error.message);
      logoutUser();
    }
  };

  const handleAppStateChange = (nextAppState) => {
    if (nextAppState === "active") {
      resetInactivityTimer();
    }
  };  

  // ✅ Login
  const login = async (email, password) => {
    try {
      const response = await axios.post(`${API_URL}/login/`, { email, password });
      const { access, refresh, user } = response.data;
  
      await AsyncStorage.setItem("authToken", access);
      await AsyncStorage.setItem("refreshToken", refresh);
      await AsyncStorage.setItem("user", JSON.stringify(user));
  
      setAuthToken(access);  // ✅ Ensure authToken is set
      setUser(user);  
  
      resetInactivityTimer(); 
  
      console.log("✅ Login Successful:", user.email);
      navigate("Home");  // ✅ Navigate to Home after login
    } catch (error) {
      console.error("❌ Login Failed:", error.response?.data || error.message);
      Alert.alert("Login Error", "Invalid email or password.");
    }
  };

  // ✅ Logout
  const logoutUser = async () => {
    try {
        console.log("📡 Sending Logout Request...");

        // ✅ Clear AsyncStorage
        await AsyncStorage.removeItem("authToken");
        await AsyncStorage.removeItem("refreshToken");
        await AsyncStorage.removeItem("user");

        // ✅ Reset authentication state
        setUser(null);
        setAuthToken(null);

        // ✅ Navigate back to Landing properly
        if (navigationRef.isReady()) {
            navigationRef.reset({
                index: 0,
                routes: [{ name: "Landing" }],
            });
        }

        console.log("✅ User logged out successfully.");
    } catch (error) {
        console.log("❌ Error logging out:", error);
    }
};


  return (
    <AuthContext.Provider value={{ user, authToken, setAuthToken, login, logoutUser, refreshSession, resetInactivityTimer }}>
      {loading ? <Text>Loading...</Text> : children}  
    </AuthContext.Provider>
  );
  
  
};

export default AuthProvider;
