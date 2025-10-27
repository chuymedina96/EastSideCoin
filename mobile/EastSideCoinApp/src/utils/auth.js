// utils/auth.js
import axios from "axios";
import AsyncStorage from "@react-native-async-storage/async-storage";

const API_URL = "http://192.168.1.125:8000/api"; // ✅ Replace with your backend URL

/**
 * 🔄 Refresh JWT Access Token using stored refresh token
 * Gracefully handles network issues and clears session on total failure.
 */
export const refreshAccessToken = async () => {
  try {
    const refreshToken = await AsyncStorage.getItem("refreshToken");
    if (!refreshToken) throw new Error("No refresh token found");

    console.log("🔄 Refreshing Token…");

    const response = await axios.post(`${API_URL}/token/refresh/`, { refresh: refreshToken });
    const newAccessToken = response.data.access;

    if (!newAccessToken) throw new Error("No access token returned");

    await AsyncStorage.setItem("authToken", newAccessToken);
    console.log("✅ Token Refreshed Successfully");

    return newAccessToken;
  } catch (error) {
    const errMsg = error?.response?.data || error?.message || "Unknown error";
    console.log("❌ Token Refresh Failed:", errMsg);

    // If token refresh fails, clear auth and force re-login
    if (errMsg.includes("token") || errMsg.includes("expired")) {
      await AsyncStorage.multiRemove(["authToken", "refreshToken", "user"]);
    }
    return null;
  }
};

/**
 * 🧠 Axios instance with auto token injection
 * Use this when making secure requests.
 */
export const getAuthorizedAxios = async () => {
  const authToken = await AsyncStorage.getItem("authToken");
  const instance = axios.create({
    baseURL: API_URL,
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
  });
  return instance;
};

/**
 * 🔐 Helper: attach fresh token automatically before request
 */
export const axiosWithAutoRefresh = axios.create({ baseURL: API_URL });
axiosWithAutoRefresh.interceptors.request.use(async (config) => {
  let token = await AsyncStorage.getItem("authToken");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

axiosWithAutoRefresh.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      const newToken = await refreshAccessToken();
      if (newToken) {
        axios.defaults.headers.common.Authorization = `Bearer ${newToken}`;
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return axiosWithAutoRefresh(originalRequest);
      }
    }
    return Promise.reject(error);
  }
);
