// screens/KeyScreenSetup.js
import React, { useState, useEffect, useRef } from "react";
import {
  View, Text, ActivityIndicator, Alert, ToastAndroid,
  Animated, StyleSheet, Platform, InteractionManager
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { resetNavigation } from "../navigation/NavigationService";
import {
  isKeysReady,
  generateAndUploadKeys,
  loadPrivateKeyForUser,
  loadPublicKeyForUser,
} from "../utils/keyManager";

const KeyScreenSetup = () => {
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");

  const [headline, setHeadline] = useState("Setting up your secure account…");
  const [detail, setDetail] = useState(
    "Generating encryption keys on your device. This can take ~10–20 seconds the first time."
  );

  const progress = useRef(new Animated.Value(0)).current;
  const pctRef = useRef(0);
  const [pct, setPct] = useState(0);
  const mountedRef = useRef(true);
  const startedRef = useRef(false); // prevent double runs

  const setPctSafe = (v) => {
    if (!mountedRef.current) return;
    pctRef.current = v;
    setPct(v);
  };

  const animateTo = (toValue, duration = 220) => {
    const next = Math.max(pctRef.current, toValue); // never regress
    Animated.timing(progress, { toValue: next, duration, useNativeDriver: false }).start();
    setPctSafe(next);
  };

  const toast = (msg) => {
    if (Platform.OS === "android") ToastAndroid.show(msg, ToastAndroid.SHORT);
    else Alert.alert("Info", msg);
  };

  const routeHome = () => resetNavigation("HomeTabs");

  const stage = async (nextPct, title, sub, minMs = 240) => {
    if (!mountedRef.current) return;
    if (title) setHeadline(title);
    if (sub) setDetail(sub);
    const t0 = Date.now();
    animateTo(nextPct);
    const elapsed = Date.now() - t0;
    if (elapsed < minMs) await new Promise((r) => setTimeout(r, Math.max(0, minMs - elapsed)));
  };

  const runGenerate = async (attempt = 1) => {
    if (!mountedRef.current) return;
    if (attempt === 1) setLoading(true);
    setErrorMsg("");
    try {
      const rawUser = await AsyncStorage.getItem("user");
      const authToken = await AsyncStorage.getItem("authToken");
      const user = rawUser ? JSON.parse(rawUser) : null;

      if (!user?.id || !authToken) {
        resetNavigation("Login");
        return;
      }

      await stage(
        10,
        "Creating your key pair…",
        "Your private key stays on this device. Your public key lets neighbors send you encrypted messages."
      );

      await generateAndUploadKeys({
        userId: user.id,
        authToken,
        onProgress: (v, msg) => {
          if (!mountedRef.current) return;
          if (typeof v === "number") animateTo(v);
          if (msg) setDetail(msg);
        },
      });

      await stage(90, "Verifying setup…", "Finishing sync with your account…");

      await loadPrivateKeyForUser(user.id);
      await loadPublicKeyForUser(user.id);

      const ready = await isKeysReady(user.id);
      if (!ready) throw new Error("Keys not fully ready after generation.");

      await stage(100, "All set! 🔐", "End-to-end encryption is now enabled.");
      toast("Keys generated on this device.");
      routeHome();
    } catch (err) {
      if (!mountedRef.current) return;
      console.error("❌ Key setup failed:", err?.response?.data || err?.message || err);

      if (attempt < 2) {
        setErrorMsg("Something went wrong setting up your secure account. Retrying…");
        await new Promise((r) => setTimeout(r, 900));
        setErrorMsg("");
        return runGenerate(attempt + 1);
      }

      setErrorMsg("We couldn’t finish setup. Please reopen the app to try again.");
    } finally {
      if (mountedRef.current && attempt === 1) setLoading(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;

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
          // Keys already there—hydrate legacy slots then go home.
          await loadPrivateKeyForUser(user.id);
          await loadPublicKeyForUser(user.id);
          routeHome();
          return;
        }

        // ✅ Let the screen render FIRST, then kick off heavy work.
        if (!startedRef.current) {
          startedRef.current = true;
          InteractionManager.runAfterInteractions(() => {
            // small timeout to ensure first paint + 10% shows
            setTimeout(() => runGenerate(1), 0);
          });
        }
      } catch (e) {
        console.warn("KeyScreenSetup init error:", e?.message || e);
        setErrorMsg("We hit a snag starting your secure setup. Please reopen the app.");
      }
    })();

    return () => {
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>{headline}</Text>
        <Text style={styles.subtitle}>{detail}</Text>

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

        {loading && <ActivityIndicator size="small" color="#FFD700" style={{ marginTop: 12 }} />}

        {!!errorMsg && <Text style={styles.error}>{errorMsg}</Text>}
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
  subtitle: { color: "#BEBEBE", fontSize: 14, marginBottom: 16, lineHeight: 20 },
  progressBar: { width: "100%", height: 10, backgroundColor: "#2a2a2a", borderRadius: 6, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: "#FFD700" },
  percent: { color: "#ddd", fontSize: 12, marginTop: 6, textAlign: "right" },
  error: { color: "#ff6b6b", marginTop: 10, fontSize: 12 },
});

export default KeyScreenSetup;
