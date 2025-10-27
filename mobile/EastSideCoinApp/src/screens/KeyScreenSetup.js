// screens/KeyScreenSetup.js
import React, { useState, useEffect, useRef } from "react";
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
import { resetNavigation } from "../navigation/NavigationService";
import {
  isKeysReady,
  generateAndUploadKeys,
  loadPrivateKeyForUser,
} from "../utils/keyManager";

const KeyScreenSetup = () => {
  const [loading, setLoading] = useState(false);
  const [keysGenerated, setKeysGenerated] = useState(false);

  // UX copy that updates per stage
  const [headline, setHeadline] = useState("Setting up secure messaging…");
  const [detail, setDetail] = useState(
    "We’re creating encryption keys on your device so only you and your neighbors can read your messages."
  );

  // progress
  const progress = useRef(new Animated.Value(0)).current;
  const [pct, setPct] = useState(0);

  const animateTo = (toValue, duration = 400) => {
    Animated.timing(progress, { toValue, duration, useNativeDriver: false }).start();
    setPct(toValue);
  };

  const toast = (msg) => {
    if (Platform.OS === "android") ToastAndroid.show(msg, ToastAndroid.SHORT);
    else Alert.alert("Info", msg);
  };

  const routeHome = () => resetNavigation("HomeTabs");

  // Smooth staged progress so it doesn’t “jump”
  const stage = async (nextPct, title, sub, minMs = 300) => {
    setHeadline(title);
    setDetail(sub);
    const start = Date.now();
    animateTo(nextPct);
    const elapsed = Date.now() - start;
    if (elapsed < minMs) {
      await new Promise((r) => setTimeout(r, minMs - elapsed));
    }
  };

  const runGenerate = async () => {
    setLoading(true);
    try {
      const rawUser = await AsyncStorage.getItem("user");
      const authToken = await AsyncStorage.getItem("authToken");
      const user = rawUser ? JSON.parse(rawUser) : null;

      if (!user?.id || !authToken) {
        Alert.alert("Session expired", "Please log in again.");
        resetNavigation("Login");
        return;
      }

      await stage(
        10,
        "Creating your private key…",
        "This key never leaves your device. It’s used to decrypt messages sent to you."
      );

      await stage(
        30,
        "Creating your public key…",
        "We’ll share this with the server so neighbors can send you encrypted messages."
      );

      await stage(
        45,
        "Saving keys to secure storage…",
        "Keeping your private key on-device under your account."
      );

      // generate & upload (progress callback will update text/pct too)
      await generateAndUploadKeys({
        userId: user.id,
        authToken,
        onProgress: (v, msg) => {
          if (typeof v === "number") animateTo(Math.max(pct, v)); // never go backwards
          if (msg) {
            setHeadline(msg);
            // keep our explanatory detail unless msg is a full sentence
          }
        },
      });

      await stage(
        85,
        "Verifying setup…",
        "Double-checking your keys and syncing with your account."
      );

      // Hydrate legacy slot to keep the rest of the app happy
      await loadPrivateKeyForUser(user.id);

      await stage(
        100,
        "All set! 🔐",
        "End-to-end encryption is enabled for your device."
      );

      setKeysGenerated(true);
      toast("Keys generated on this device.");
      setTimeout(routeHome, 650);
    } catch (err) {
      console.error("❌ Key setup failed:", err?.response?.data || err?.message || err);
      Alert.alert(
        "Key Setup",
        "Something went wrong while generating keys. You can try again."
      );
    } finally {
      setLoading(false);
    }
  };

  // Auto-start on mount if missing; if already ready, go home
  useEffect(() => {
    (async () => {
      try {
        const rawUser = await AsyncStorage.getItem("user");
        const user = rawUser ? JSON.parse(rawUser) : null;
        if (!user?.id) {
          resetNavigation("Login");
          return;
        }
        const ready = await isKeysReady(user.id);
        if (ready) {
          await loadPrivateKeyForUser(user.id);
          setKeysGenerated(true);
          routeHome();
        } else {
          setTimeout(runGenerate, 300);
        }
      } catch (e) {
        console.warn("KeyScreenSetup init error:", e?.message || e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>

      <View style={styles.card}>
        <Text style={styles.title}>{headline}</Text>
        <Text style={styles.subtitle}>{detail}</Text>

        <View style={styles.infoBox}>
          <Text style={styles.infoLine}>• Your private key stays on this device.</Text>
          <Text style={styles.infoLine}>• Only the public key is shared to let others send you messages.</Text>
          <Text style={styles.infoLine}>• You can keep using the app while we finish.</Text>
        </View>

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
        <Text style={styles.percent}>{Math.round(pct)}%</Text>

        {loading ? (
          <ActivityIndicator size="small" color="#FFD700" style={{ marginTop: 10 }} />
        ) : keysGenerated ? (
          <TouchableOpacity style={styles.primary} onPress={routeHome}>
            <Text style={styles.primaryText}>Continue</Text>
          </TouchableOpacity>
        ) : (
          <View style={{ width: "100%" }}>
            <TouchableOpacity style={styles.primary} onPress={runGenerate}>
              <Text style={styles.primaryText}>Try Again</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondary} onPress={routeHome}>
              <Text style={styles.secondaryText}>Skip for now (not recommended)</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000", justifyContent: "center", alignItems: "center", padding: 20 },
  card: {
    backgroundColor: "#111",
    borderRadius: 14,
    padding: 18,
    width: "100%",
    maxWidth: 520,
    borderWidth: 1,
    borderColor: "#222",
  },
  title: { color: "#fff", fontSize: 20, fontWeight: "700", marginBottom: 6 },
  subtitle: { color: "#BEBEBE", fontSize: 14, marginBottom: 14, lineHeight: 20 },
  infoBox: {
    backgroundColor: "#0d1a0d",
    borderColor: "#163116",
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 16,
  },
  infoLine: { color: "#8ee28e", fontSize: 12, marginBottom: 2 },
  progressBar: {
    width: "100%",
    height: 10,
    backgroundColor: "#2a2a2a",
    borderRadius: 6,
    overflow: "hidden",
  },
  progressFill: { height: "100%", backgroundColor: "#FFD700" },
  percent: { color: "#ddd", fontSize: 12, marginTop: 6, textAlign: "right" },
  primary: {
    marginTop: 16,
    backgroundColor: "#FF4500",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  secondary: {
    marginTop: 10,
    backgroundColor: "#222",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#FFD700",
  },
  secondaryText: { color: "#FFD700", fontSize: 14, fontWeight: "700" },
});

export default KeyScreenSetup;
