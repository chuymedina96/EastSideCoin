import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ToastAndroid,
  Animated,
  StyleSheet,
  Platform,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import forge from "node-forge";
import axios from "axios";
import { API_URL } from "../config";
import { resetNavigation } from "../navigation/NavigationService";
import { useNavigation } from "@react-navigation/native";

// Utility delay function
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const KeyScreenSetup = () => {
  const navigation = useNavigation();
  const [loading, setLoading] = useState(false);
  const [keysGenerated, setKeysGenerated] = useState(false);
  const [progress] = useState(new Animated.Value(0)); // progress from 0 to 100
  const [step, setStep] = useState("Ready to generate keys");

  useEffect(() => {
    (async () => {
      const privateKeyExists = await AsyncStorage.getItem("privateKey");
      if (privateKeyExists) {
        console.log("✅ Keys already exist. Skipping generation.");
        setKeysGenerated(true);
      }
    })();
  }, []);

  const animateProgress = (toValue) => {
    Animated.timing(progress, {
      toValue,
      duration: 500,
      useNativeDriver: false,
    }).start();
  };

  const generateKeys = async (inBackground = false) => {
    setLoading(true);
    animateProgress(10);
    setStep("Generating RSA key pair...");
    await delay(150); // slight delay for UI update

    let keyPair;
    try {
      keyPair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    } catch (err) {
      console.error("RSA generation error:", err);
      Alert.alert("Error", "Failed to generate RSA keys.");
      setLoading(false);
      return;
    }
    animateProgress(50);
    setStep("Encrypting and preparing keys...");
    await delay(150);

    const publicKey = forge.pki.publicKeyToPem(keyPair.publicKey);
    const privateKey = forge.pki.privateKeyToPem(keyPair.privateKey);

    console.log("✅ RSA Key Pair Generated!");
    await AsyncStorage.setItem("privateKey", privateKey);

    const authToken = await AsyncStorage.getItem("authToken");
    if (!authToken) {
      Alert.alert("Session Expired", "Please log in again.");
      resetNavigation("Login");
      setLoading(false);
      return;
    }

    animateProgress(75);
    setStep("Storing public key on server...");
    await delay(150);

    try {
      const response = await axios.post(
        `${API_URL}/generate_keys/`,
        { public_key: publicKey.trim() },
        { headers: { Authorization: `Bearer ${authToken}` } }
      );
      console.log("✅ Keys Successfully Stored! Response:", response.data);
      await AsyncStorage.setItem("keysGenerated", "true");
      setKeysGenerated(true);
      animateProgress(100);
      setStep("Key setup complete!");
      showNotification("🔑 Encryption Keys Ready!");
    } catch (error) {
      console.error("❌ Key Setup Error:", error);
      Alert.alert("Error", "Failed to store keys on server. Try again.");
    } finally {
      setLoading(false);
      // For foreground mode, navigate after a short delay
      if (!inBackground) {
        setTimeout(() => resetNavigation("HomeTabs"), 1000);
      }
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
      <Text style={styles.matrixText}>🔑 Secure Your Account</Text>
      <Text style={styles.description}>{step}</Text>

      {loading ? (
        <>
          <ActivityIndicator size="large" color="#E63946" />
          <View style={styles.progressBar}>
            <Animated.View
              style={[
                styles.progressFill,
                {
                  width: progress.interpolate({
                    inputRange: [0, 100],
                    outputRange: ["0%", "100%"],
                  }),
                },
              ]}
            />
          </View>
        </>
      ) : keysGenerated ? (
        <>
          <Text style={styles.successText}>✅ Keys Successfully Generated!</Text>
          <TouchableOpacity
            style={styles.button}
            onPress={() => resetNavigation("HomeTabs")}
          >
            <Text style={styles.buttonText}>Continue</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <TouchableOpacity
            style={styles.button}
            onPress={() => generateKeys(false)}
          >
            <Text style={styles.buttonText}>Generate Now</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => {
              // Start generation in background and immediately navigate away
              generateKeys(true);
              resetNavigation("HomeTabs");
            }}
          >
            <Text style={styles.secondaryButtonText}>
              Generate in Background
            </Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
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
    marginBottom: 10,
  },
  description: {
    fontSize: 16,
    color: "#AAA",
    marginBottom: 20,
    textAlign: "center",
  },
  progressBar: {
    width: "80%",
    height: 10,
    backgroundColor: "#333",
    borderRadius: 5,
    overflow: "hidden",
    marginVertical: 20,
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#E63946",
  },
  successText: {
    fontSize: 16,
    color: "#0F0",
    marginBottom: 20,
    fontWeight: "bold",
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
  secondaryButton: {
    backgroundColor: "#333",
    padding: 15,
    borderRadius: 8,
    width: "90%",
    alignItems: "center",
    marginVertical: 10,
    borderColor: "#FFD700",
    borderWidth: 1,
  },
  secondaryButtonText: {
    color: "#FFD700",
    fontSize: 18,
    fontWeight: "bold",
  },
});

export default KeyScreenSetup;
