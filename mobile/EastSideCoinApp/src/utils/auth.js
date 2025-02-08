import axios from "axios";
import AsyncStorage from "@react-native-async-storage/async-storage";

const API_URL = "http://192.168.1.125:8000/api"; // ✅ Replace with your backend URL

// 🔄 Refresh JWT Access Token
export const refreshAccessToken = async () => {
  try {
    const refreshToken = await AsyncStorage.getItem("refreshToken");
    if (!refreshToken) throw new Error("No refresh token found");

    console.log("🔄 Refreshing Token...");

    const response = await axios.post(`${API_URL}/token/refresh/`, {
      refresh: refreshToken,
    });

    const newAccessToken = response.data.access;
    await AsyncStorage.setItem("authToken", newAccessToken);

    console.log("✅ Token Refreshed Successfully:", newAccessToken);
    return newAccessToken;
  } catch (error) {
    console.log("❌ Token Refresh Failed:", error.response?.data || error.message);
    return null;
  }
};
