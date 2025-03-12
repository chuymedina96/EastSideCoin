import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ToastAndroid,
  Platform,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import forge from "node-forge";
import axios from "axios";
import { API_URL } from "../config";
import { useNavigation } from "@react-navigation/native";

const KeyScreenSetup = () => {
  const navigation = useNavigation();
  const [loading, setLoading] = useState(false);
  const [keysGenerated, setKeysGenerated] = useState(false);

  useEffect(() => {
    (async () => {
      const privateKeyExists = await AsyncStorage.getItem("privateKey");
      if (!privateKeyExists) {
        generateKeysInBackground();
      } else {
        console.log("✅ Keys already exist. Skipping generation.");
        setKeysGenerated(true);
      }
    })();
  }, []);

  const generateKeysInBackground = async () => {
    setLoading(true);
    console.log("🔐 Running RSA Key Generation in Background...");

    try {
      const keyPair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
      const publicKey = forge.pki.publicKeyToPem(keyPair.publicKey);
      const privateKey = forge.pki.privateKeyToPem(keyPair.privateKey);

      console.log("✅ RSA Key Pair Generated!");
      await AsyncStorage.setItem("privateKey", privateKey);

      const authToken = await AsyncStorage.getItem("authToken");
      if (!authToken) {
        console.warn("⚠️ No Auth Token Found! Redirecting to Login...");
        Alert.alert("Session Expired", "Please log in again.");
        navigation.navigate("Login");
        return;
      }

      console.log("📡 Storing Public Key in Backend...");

      const response = await axios.post(
        `${API_URL}/generate_keys/`,
        { public_key: publicKey.trim() },
        { headers: { Authorization: `Bearer ${authToken}` } }
      );

      console.log("✅ Keys Successfully Stored! Response:", response.data);
      setKeysGenerated(true);
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
    <View style={styles.container}>
      {/* 🔥 Matrix-Inspired Text with Pulsating Effect */}
      <Text style={styles.matrixText}>🔑 Secure Your Account</Text>
      <Text style={styles.description}>
        We are setting up your encryption keys in the background.
      </Text>

      {loading ? (
        <ActivityIndicator size="large" color="#E63946" />
      ) : keysGenerated ? (
        <>
          <Text style={styles.successText}>✅ Keys Successfully Generated!</Text>
          <TouchableOpacity
            onPress={() => navigation.navigate("HomeTabs")}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Continue</Text>
          </TouchableOpacity>
        </>
      ) : (
        <Text style={styles.loadingText}>Generating keys in the background...</Text>
      )}
    </View>
  );
};

const styles = {
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000", // Matrix Black
    padding: 20,
  },
  matrixText: {
    fontSize: 24,
    color: "#0F0", // Matrix Green
    fontWeight: "bold",
    textAlign: "center",
    textShadowColor: "#00FF00",
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 5,
    letterSpacing: 2,
  },
  description: {
    fontSize: 16,
    color: "#AAA",
    marginBottom: 20,
    textAlign: "center",
  },
  successText: {
    fontSize: 16,
    color: "#0F0",
    marginBottom: 20,
    fontWeight: "bold",
  },
  loadingText: {
    fontSize: 16,
    color: "#AAA",
  },
  button: {
    backgroundColor: "#FF4500",
    padding: 15,
    borderRadius: 8,
    width: "90%",
    alignItems: "center",
    marginVertical: 10,
  },
  buttonText: {
    color: "#FFF",
    fontSize: 18,
    fontWeight: "bold",
  },
};

export default KeyScreenSetup;
