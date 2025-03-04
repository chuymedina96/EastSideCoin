import React, { useState, useEffect } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, Alert, ToastAndroid, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import forge from "node-forge";
import axios from "axios";
import { API_URL } from "../config";
import { useNavigation } from "@react-navigation/native";

const KeySetupScreen = () => {
  const navigation = useNavigation();
  const [loading, setLoading] = useState(false);
  const [keysGenerated, setKeysGenerated] = useState(false);

  useEffect(() => {
    // ✅ Automatically start key generation when the screen loads
    generateKeysInBackground();
  }, []);

  const generateKeysInBackground = async () => {
    setLoading(true);
    console.log("🔐 Running RSA Key Generation in Background...");

    try {
      const keyPair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
      const publicKey = forge.pki.publicKeyToPem(keyPair.publicKey);
      const privateKey = forge.pki.privateKeyToPem(keyPair.privateKey);

      console.log("✅ RSA Key Pair Generated!");
      
      // ✅ Store Private Key Securely
      await AsyncStorage.setItem("privateKey", privateKey);

      // ✅ Retrieve Auth Token
      const authToken = await AsyncStorage.getItem("authToken");
      if (!authToken) {
        console.warn("⚠️ No Auth Token Found! Redirecting to Login...");
        Alert.alert("Session Expired", "Please log in again.");
        navigation.navigate("Login");
        return;
      }

      console.log("📡 Storing Public Key in Backend...");
      await axios.post(
        `${API_URL}/generate_keys/`,
        { public_key: publicKey.trim() },
        { headers: { Authorization: `Bearer ${authToken}` } }
      );

      console.log("✅ Keys Successfully Stored!");
      setKeysGenerated(true);

      // ✅ Show Background Notification
      showNotification("🔑 Encryption Keys Ready!");

    } catch (error) {
      console.error("❌ Key Setup Error:", error);
      Alert.alert("Error", "Failed to generate keys. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const showNotification = (message) => {
    if (Platform.OS === "android") {
      ToastAndroid.show(message, ToastAndroid.SHORT);
    } else {
      Alert.alert("Notification", message);
    }
  };

  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#1E1E1E" }}>
      <Text style={{ fontSize: 24, color: "#FFD700", marginBottom: 10 }}>🔑 Secure Your Account</Text>
      <Text style={{ fontSize: 16, color: "#AAA", marginBottom: 20 }}>We are setting up your encryption keys in the background.</Text>

      {loading ? (
        <ActivityIndicator size="large" color="#E63946" />
      ) : keysGenerated ? (
        <>
          <Text style={{ fontSize: 16, color: "#0F0", marginBottom: 20 }}>✅ Keys Successfully Generated!</Text>
          <TouchableOpacity onPress={() => navigation.navigate("HomeTabs")} style={{ backgroundColor: "#FF4500", padding: 15, borderRadius: 8 }}>
            <Text style={{ color: "#FFF", fontSize: 18 }}>Continue</Text>
          </TouchableOpacity>
        </>
      ) : (
        <Text style={{ fontSize: 16, color: "#CCC" }}>Generating keys in the background...</Text>
      )}
    </View>
  );
};

export default KeySetupScreen;
