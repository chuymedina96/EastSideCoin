import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";

const API_URL = "http://192.168.1.125:8000/api/logout/";

const ProfileScreen = ({ navigation }) => {
  const logoutUser = async () => {
    try {
      const refreshToken = await AsyncStorage.getItem("refreshToken"); // Ensure this is stored during login
      if (!refreshToken) {
        Alert.alert("Error", "No refresh token found. Try logging in again.");
        return;
      }

      console.log("📡 Sending Logout Request...");

      await axios.post(API_URL, { token: refreshToken }, { headers: { "Content-Type": "application/json" } });

      await AsyncStorage.removeItem("authToken"); // Remove access token
      await AsyncStorage.removeItem("refreshToken"); // Remove refresh token
      await AsyncStorage.removeItem("user");

      Alert.alert("Logged Out", "You have been successfully logged out.");
      navigation.replace("Landing"); // ✅ Redirect to Landing Page
    } catch (error) {
      console.log("❌ Logout Error:", error.response?.data || error.message);
      Alert.alert("Logout Failed", error.response?.data?.error || "Something went wrong.");
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>User Profile</Text>
      <TouchableOpacity style={styles.button} onPress={logoutUser}>
        <Text style={styles.buttonText}>Logout</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#1E1E1E",
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    color: "#FFD700",
    marginBottom: 20,
  },
  button: {
    backgroundColor: "#FF4500",
    padding: 15,
    borderRadius: 8,
    marginTop: 20,
  },
  buttonText: {
    color: "#FFF",
    fontSize: 18,
    fontWeight: "bold",
  },
});

export default ProfileScreen;
