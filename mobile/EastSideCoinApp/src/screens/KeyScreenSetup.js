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
  InteractionManager,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import forge from "node-forge";
import axios from "axios";
import { API_URL } from "../config";
import { resetNavigation } from "../navigation/NavigationService";
import { useNavigation } from "@react-navigation/native";

const KeyScreenSetup = () => {
  const navigation = useNavigation();
  const [loading, setLoading] = useState(false);
  const [keysGenerated, setKeysGenerated] = useState(false);
  const [progress] = useState(new Animated.Value(0));
  const [percentage, setPercentage] = useState(0);
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
    setPercentage(toValue);
  };

  const wait = (ms) => new Promise((res) => setTimeout(res, ms));

  const showNotification = (msg) => {
    if (Platform.OS === "android") {
      ToastAndroid.show(msg, ToastAndroid.SHORT);
    } else {
      Alert.alert("Notification", msg);
    }
  };

  const generateKeys = async (inBackground = false) => {
    try {
      setLoading(true);
      setStep("🔐 Generating RSA key pair...");
      animateProgress(10);
      await wait(150);

      const keyPair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
 
      setStep("🔒 Encrypting keys...");
      animateProgress(30);
      await wait(150);

      const publicKey = forge.pki.publicKeyToPem(keyPair.publicKey);
      const privateKey = forge.pki.privateKeyToPem(keyPair.privateKey);

      await AsyncStorage.setItem("privateKey", privateKey);

      setStep("🔑 Validating user session...");
      animateProgress(50);
      await wait(150);

      const authToken = await AsyncStorage.getItem("authToken");
      if (!authToken) {
        Alert.alert("Session Expired", "Please log in again.");
        resetNavigation("Login");
        return;
      }

      setStep("📡 Sending public key to server...");
      animateProgress(80);
      await wait(150);

      const res = await axios.post(
        `${API_URL}/generate_keys/`,
        { public_key: publicKey.trim() },
        {
          headers: { Authorization: `Bearer ${authToken}` },
        }
      );

      console.log("✅ Keys stored:", res.data);
      await AsyncStorage.setItem("keysGenerated", "true");

      setKeysGenerated(true);
      setStep("✅ Key setup complete!");
      animateProgress(100);
      showNotification("🔐 Keys generated!");

      if (!inBackground) {
        setTimeout(() => resetNavigation("HomeTabs"), 1000);
      }
    } catch (err) {
      console.error("❌ Key setup failed:", err);
      Alert.alert("Key Setup Error", "Something went wrong.");
    } finally {
      setLoading(false);
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
          <Text style={styles.percentageText}>{percentage}%</Text>
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
              resetNavigation("HomeTabs");
              InteractionManager.runAfterInteractions(() => {
                generateKeys(true);
              });
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
    backgroundColor: "#000",
    padding: 20,
  },
  matrixText: {
    fontSize: 24,
    color: "#0F0",
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
    marginVertical: 10,
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#E63946",
  },
  percentageText: {
    color: "#FFF",
    fontSize: 14,
    marginTop: 5,
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
