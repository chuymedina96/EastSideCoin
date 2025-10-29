// screens/LoginScreen.js
import React, { useState, useContext, useMemo, useRef, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Image,
  Pressable,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AuthContext } from "../context/AuthProvider";
import { useNavigation } from "@react-navigation/native";
import { resetNavigation } from "../navigation/NavigationService";
import { loadPrivateKeyForUser, loadPublicKeyForUser } from "../utils/keyManager";

const MIN_PW = 6;

const LoginScreen = () => {
  const { login } = useContext(AuthContext);
  const navigation = useNavigation();

  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw]     = useState(false);
  const [loading, setLoading]   = useState(false);
  const [routing, setRouting]   = useState(false);

  // Animations
  const fadeIn = useRef(new Animated.Value(0)).current;
  const logoFloat = useRef(new Animated.Value(0)).current;
  const btnScale = useRef(new Animated.Value(1)).current;
  const btnSecondaryScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.timing(fadeIn, {
      toValue: 1,
      duration: 800,
      useNativeDriver: true,
      easing: Easing.out(Easing.cubic),
    }).start();

    Animated.loop(
      Animated.sequence([
        Animated.timing(logoFloat, {
          toValue: 1,
          duration: 2400,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.quad),
        }),
        Animated.timing(logoFloat, {
          toValue: 0,
          duration: 2400,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.quad),
        }),
      ])
    ).start();
  }, [fadeIn, logoFloat]);

  const onPressIn = (anim) =>
    Animated.spring(anim, { toValue: 0.97, useNativeDriver: true }).start();
  const onPressOut = (anim) =>
    Animated.spring(anim, { toValue: 1, friction: 3, useNativeDriver: true }).start();

  const canSubmit = useMemo(
    () => /^\S+@\S+\.\S+$/.test(email.trim()) && password.length >= MIN_PW && !loading && !routing,
    [email, password, loading, routing]
  );

  const routeAfterAuth = async () => {
    setRouting(true);
    try {
      // Let AuthProvider persist tokens/user
      await new Promise((r) => setTimeout(r, 150));

      const rawUser = await AsyncStorage.getItem("user");
      const u = rawUser ? JSON.parse(rawUser) : null;

      if (u?.id) {
        // Hydrate volatile slot if per-user key exists
        const perUserKey = await AsyncStorage.getItem(`privateKey_${u.id}`);
        if (perUserKey) await AsyncStorage.setItem("privateKey", perUserKey);

        const priv = await loadPrivateKeyForUser(u.id); // copies if present
        const pub =
          (await loadPublicKeyForUser(u.id)) ||
          (await AsyncStorage.getItem("publicKey")) ||
          u.public_key ||
          null;

        const ready = Boolean(priv && pub);
        resetNavigation(ready ? "HomeTabs" : "KeyScreenSetup");
        return;
      }

      // Fallback legacy check
      const priv = await AsyncStorage.getItem("privateKey");
      const pub  = await AsyncStorage.getItem("publicKey");
      resetNavigation(priv && pub ? "HomeTabs" : "KeyScreenSetup");
    } finally {
      setRouting(false);
    }
  };

  const handleLogin = async () => {
    if (!canSubmit) {
      Alert.alert("Check your info", "Enter a valid email and password (min 6 chars).");
      return;
    }
    setLoading(true);
    try {
      const success = await login(email.trim().toLowerCase(), password, /* skipRedirect */ true);
      if (!success) {
        Alert.alert("Login Error", "Invalid email or password.");
        return;
      }
      await routeAfterAuth();
    } catch (error) {
      console.error("❌ Login Failed:", error?.message || error);
      Alert.alert("Login Error", "Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const floatTranslate = logoFloat.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -6],
  });

  return (
    <SafeAreaView style={styles.safe}>
      {/* Background accents */}
      <View style={styles.bg}>
        <View style={[styles.accent, styles.accentTop]} />
        <View style={[styles.accent, styles.accentBottom]} />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <Animated.View style={[styles.container, { opacity: fadeIn }]}>
          {/* Header / Logo */}
          <View style={styles.heroWrap}>
            <Animated.Image
              source={require("../../assets/Eastside Coin.webp")}
              style={[styles.logo, { transform: [{ translateY: floatTranslate }] }]}
              accessible
              accessibilityLabel="EastSide Coin logo"
            />
          </View>

          <Text style={styles.title}>Welcome back</Text>
          <Text style={styles.subtitle}>Log in to your neighborhood hub</Text>

          {/* Inputs */}
          <View style={styles.form}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              placeholder="you@example.com"
              placeholderTextColor="#9a9aa1"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
              textContentType="username"
            />

            <Text style={[styles.label, { marginTop: 12 }]}>Password</Text>
            <View style={[styles.input, styles.passwordRow]}>
              <TextInput
                style={styles.passwordInput}
                placeholder="••••••••"
                placeholderTextColor="#9a9aa1"
                secureTextEntry={!showPw}
                value={password}
                onChangeText={setPassword}
                autoCapitalize="none"
                returnKeyType="done"
                onSubmitEditing={handleLogin}
                textContentType="password"
              />
              <Pressable onPress={() => setShowPw((s) => !s)} hitSlop={8}>
                <Text style={styles.togglePw}>{showPw ? "Hide" : "Show"}</Text>
              </Pressable>
            </View>

            <Pressable onPress={() => Alert.alert("Coming soon", "Password reset is coming soon.")}>
              <Text style={styles.forgot}>Forgot password?</Text>
            </Pressable>
          </View>

          {/* Status */}
          {(loading || routing) && (
            <ActivityIndicator size="large" color="#FF4500" style={{ marginBottom: 8 }} />
          )}

          {/* Primary CTA */}
          <Animated.View style={[styles.button, { transform: [{ scale: btnScale }] }]}>
            <Pressable
              onPressIn={() => onPressIn(btnScale)}
              onPressOut={() => onPressOut(btnScale)}
              onPress={handleLogin}
              disabled={!canSubmit}
              style={[styles.pressable, !canSubmit && styles.disabledBtn]}
              accessibilityRole="button"
              accessibilityLabel="Log in"
            >
              <Text style={styles.buttonText}>{loading || routing ? "Checking..." : "Log In"}</Text>
            </Pressable>
          </Animated.View>

          {/* Secondary CTA */}
          <Animated.View
            style={[styles.buttonOutline, { transform: [{ scale: btnSecondaryScale }] }]}
          >
            <Pressable
              onPressIn={() => onPressIn(btnSecondaryScale)}
              onPressOut={() => onPressOut(btnSecondaryScale)}
              onPress={() => navigation.navigate("Register")}
              style={styles.pressable}
              accessibilityRole="button"
              accessibilityLabel="Create account"
            >
              <Text style={styles.buttonOutlineText}>Create an Account</Text>
            </Pressable>
          </Animated.View>

          {/* Footer */}
          <Text style={styles.footer}>
            Protected login • End-to-end encrypted chat after key setup.
          </Text>
        </Animated.View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#101012" },

  bg: { ...StyleSheet.absoluteFillObject, zIndex: -1 },
  accent: {
    position: "absolute",
    width: 320,
    height: 320,
    borderRadius: 999,
    opacity: 0.18,
    transform: [{ rotate: "15deg" }],
  },
  accentTop: { top: -90, right: -70, backgroundColor: "#FFD700" },
  accentBottom: { bottom: -110, left: -80, backgroundColor: "#FF4500" },

  container: {
    flex: 1,
    paddingHorizontal: 22,
    alignItems: "center",
    justifyContent: "center",
  },

  heroWrap: { width: 140, height: 140, marginBottom: 10, alignItems: "center", justifyContent: "center" },
  logo: { width: 120, height: 120, resizeMode: "contain" },

  title: { fontSize: 28, fontWeight: "800", color: "#FFD700", letterSpacing: 0.3, textAlign: "center" },
  subtitle: { marginTop: 6, color: "#cfcfcf", fontSize: 14, textAlign: "center" },

  form: { width: "100%", marginTop: 18 },
  label: { color: "#e1e1e6", fontSize: 12, marginBottom: 6, opacity: 0.85, paddingLeft: 4 },
  input: {
    width: "100%",
    backgroundColor: "#1b1b1f",
    color: "#fff",
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderColor: "#2a2a2e",
    borderWidth: 1,
  },
  passwordRow: { flexDirection: "row", alignItems: "center", paddingRight: 8 },
  passwordInput: { flex: 1, color: "#FFF" },
  togglePw: { color: "#FFD700", fontWeight: "700", marginLeft: 10 },

  forgot: {
    color: "#9e9eaa",
    fontSize: 12,
    marginTop: 8,
    textAlign: "right",
    paddingRight: 4,
  },

  pressable: { width: "100%", alignItems: "center", justifyContent: "center" },

  button: {
    width: "100%",
    backgroundColor: "#FF4500",
    borderRadius: 12,
    paddingVertical: 14,
    shadowColor: "#FF4500",
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    marginTop: 16,
  },
  disabledBtn: { opacity: 0.6 },

  buttonText: { color: "#fff", fontSize: 18, fontWeight: "800", letterSpacing: 0.3 },

  buttonOutline: {
    width: "100%",
    borderRadius: 12,
    paddingVertical: 14,
    borderWidth: 1.5,
    borderColor: "#2c2c30",
    backgroundColor: "#151519",
    marginTop: 10,
  },
  buttonOutlineText: { color: "#eaeaea", fontSize: 18, fontWeight: "800", letterSpacing: 0.3 },

  footer: {
    color: "#7d7d85",
    fontSize: 12,
    marginTop: 14,
    textAlign: "center",
    paddingHorizontal: 6,
  },
});

export default LoginScreen;
