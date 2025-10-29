// screens/RegisterScreen.js
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
import { AuthContext } from "../context/AuthProvider";
import { useNavigation } from "@react-navigation/native";

const MIN_PW = 6;

const RegisterScreen = () => {
  const { register } = useContext(AuthContext);
  const navigation = useNavigation();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName]   = useState("");
  const [email, setEmail]         = useState("");
  const [password, setPassword]   = useState("");
  const [showPw, setShowPw]       = useState(false);
  const [loading, setLoading]     = useState(false);

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
    () =>
      firstName.trim() &&
      lastName.trim() &&
      /^\S+@\S+\.\S+$/.test(email.trim()) &&
      password.length >= MIN_PW &&
      !loading,
    [firstName, lastName, email, password, loading]
  );

  const handleRegister = async () => {
    if (!canSubmit) {
      Alert.alert("Check your info", "Please fill all fields correctly.");
      return;
    }
    setLoading(true);
    try {
      const ok = await register(
        firstName.trim(),
        lastName.trim(),
        email.trim().toLowerCase(),
        password
      );
      // Do NOT navigate here. AppNavigator will swap to the logged-in stack,
      // whose initial route is KeyScreenSetup.
      if (!ok) return;
    } catch (error) {
      console.error("❌ Registration Error:", error);
      Alert.alert("Registration Error", "Something went wrong. Try again.");
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

          <Text style={styles.title}>Create your account</Text>
          <Text style={styles.subtitle}>Secure setup. Local impact.</Text>

          {/* Inputs */}
          <View style={styles.form}>
            <Text style={styles.label}>First name</Text>
            <TextInput
              style={styles.input}
              placeholder="María"
              placeholderTextColor="#9a9aa1"
              value={firstName}
              onChangeText={setFirstName}
              autoCapitalize="words"
              returnKeyType="next"
              textContentType="givenName"
            />

            <Text style={[styles.label, { marginTop: 12 }]}>Last name</Text>
            <TextInput
              style={styles.input}
              placeholder="Medina"
              placeholderTextColor="#9a9aa1"
              value={lastName}
              onChangeText={setLastName}
              autoCapitalize="words"
              returnKeyType="next"
              textContentType="familyName"
            />

            <Text style={[styles.label, { marginTop: 12 }]}>Email</Text>
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
              textContentType="emailAddress"
            />

            <Text style={[styles.label, { marginTop: 12 }]}>Password</Text>
            <View style={[styles.input, styles.passwordRow]}>
              <TextInput
                style={styles.passwordInput}
                placeholder="At least 6 characters"
                placeholderTextColor="#9a9aa1"
                secureTextEntry={!showPw}
                value={password}
                onChangeText={setPassword}
                autoCapitalize="none"
                returnKeyType="done"
                onSubmitEditing={handleRegister}
                textContentType="newPassword"
              />
              <Pressable onPress={() => setShowPw((s) => !s)} hitSlop={8}>
                <Text style={styles.togglePw}>{showPw ? "Hide" : "Show"}</Text>
              </Pressable>
            </View>
          </View>

          {/* Status */}
          {loading && <ActivityIndicator size="large" color="#FF4500" style={{ marginTop: 10 }} />}

          {/* Primary CTA */}
          <Animated.View style={[styles.button, { transform: [{ scale: btnScale }] }]}>
            <Pressable
              onPressIn={() => onPressIn(btnScale)}
              onPressOut={() => onPressOut(btnScale)}
              onPress={handleRegister}
              disabled={!canSubmit}
              style={[styles.pressable, !canSubmit && styles.disabledBtn]}
              accessibilityRole="button"
              accessibilityLabel="Sign up"
            >
              <Text style={styles.buttonText}>{loading ? "Please wait…" : "Sign Up"}</Text>
            </Pressable>
          </Animated.View>

          {/* Secondary: back to Login */}
          <Animated.View
            style={[styles.buttonOutline, { transform: [{ scale: btnSecondaryScale }] }]}
          >
            <Pressable
              onPressIn={() => onPressIn(btnSecondaryScale)}
              onPressOut={() => onPressOut(btnSecondaryScale)}
              onPress={() => navigation.navigate("Login")}
              style={styles.pressable}
              accessibilityRole="button"
              accessibilityLabel="Back to login"
            >
              <Text style={styles.buttonOutlineText}>Back to Login</Text>
            </Pressable>
          </Animated.View>

          {/* Footer */}
          <Text style={styles.footer}>
            By continuing, you agree to our{" "}
            <Text style={styles.footerLink}>Terms</Text> &{" "}
            <Text style={styles.footerLink}>Privacy</Text>.
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
  footerLink: { color: "#cfcfcf", textDecorationLine: "underline" },
});

export default RegisterScreen;
