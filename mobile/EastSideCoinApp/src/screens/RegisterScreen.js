// screens/RegisterScreen.js
import React, { useState, useContext, useMemo } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Image,
  ActivityIndicator,
  Alert,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AuthContext } from "../context/AuthProvider";
import { resetNavigation } from "../navigation/NavigationService";

const MIN_PW = 6;

const RegisterScreen = () => {
  const { register } = useContext(AuthContext);

  const [firstName, setFirstName]   = useState("");
  const [lastName, setLastName]     = useState("");
  const [email, setEmail]           = useState("");
  const [password, setPassword]     = useState("");
  const [showPw, setShowPw]         = useState(false);
  const [loading, setLoading]       = useState(false);
  const [routing, setRouting]       = useState(false);

  const canSubmit = useMemo(() => {
    return (
      firstName.trim().length > 0 &&
      lastName.trim().length > 0 &&
      /^\S+@\S+\.\S+$/.test(email.trim()) &&
      password.length >= MIN_PW &&
      !loading && !routing
    );
  }, [firstName, lastName, email, password, loading, routing]);

  const routeAfterRegister = async () => {
    setRouting(true);
    try {
      // brief delay for AuthProvider to persist values
      await new Promise((r) => setTimeout(r, 150));

      const priv = await AsyncStorage.getItem("privateKey");
      const pub  = await AsyncStorage.getItem("publicKey");

      if (priv && pub) {
        resetNavigation("HomeTabs");
      } else {
        resetNavigation("KeyScreenSetup");
      }
    } finally {
      setRouting(false);
    }
  };

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
      if (!ok) return;

      // Decide immediately on this screen (AuthProvider still guards)
      await routeAfterRegister();
    } catch (error) {
      console.error("❌ Registration Error:", error);
      Alert.alert("Registration Error", "Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Image source={require("../../assets/Eastside Coin.webp")} style={styles.logo} />
      <Text style={styles.title}>Create Your Account</Text>
      <Text style={styles.subtitle}>Join the EastSide Coin community</Text>

      <TextInput
        style={styles.input}
        placeholder="First Name"
        placeholderTextColor="#AAA"
        value={firstName}
        onChangeText={setFirstName}
        autoCapitalize="words"
        returnKeyType="next"
      />
      <TextInput
        style={styles.input}
        placeholder="Last Name"
        placeholderTextColor="#AAA"
        value={lastName}
        onChangeText={setLastName}
        autoCapitalize="words"
        returnKeyType="next"
      />
      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor="#AAA"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="next"
      />

      <View style={[styles.input, styles.passwordRow]}>
        <TextInput
          style={styles.passwordInput}
          placeholder="Password (min 6 chars)"
          placeholderTextColor="#AAA"
          secureTextEntry={!showPw}
          value={password}
          onChangeText={setPassword}
          autoCapitalize="none"
        />
        <TouchableOpacity onPress={() => setShowPw((s) => !s)}>
          <Text style={styles.togglePw}>{showPw ? "Hide" : "Show"}</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.helper}>
        After signup, if keys aren’t on this device yet, we’ll guide you to set them up.
        It only takes a moment.
      </Text>

      {(loading || routing) && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#E63946" />
          <Text style={styles.loadingText}>{routing ? "Preparing your account…" : "Creating your account…"}</Text>
        </View>
      )}

      <TouchableOpacity
        style={[styles.button, (!canSubmit || loading || routing) && styles.disabledButton]}
        onPress={handleRegister}
        disabled={!canSubmit || loading || routing}
      >
        <Text style={styles.buttonText}>
          {loading || routing ? "Please wait…" : "Sign Up"}
        </Text>
      </TouchableOpacity>

      <Text style={styles.footerNote}>
        By continuing, you agree to our Terms & Privacy Policy.
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1, justifyContent: "center", alignItems: "center",
    backgroundColor: "#1E1E1E", padding: 20,
  },
  logo: { width: 120, height: 120, resizeMode: "contain", marginBottom: 20 },
  title: { fontSize: 26, fontWeight: "bold", color: "#FFD700", marginBottom: 5 },
  subtitle: { fontSize: 14, color: "#CCC", textAlign: "center", marginBottom: 18 },
  input: {
    width: "90%", backgroundColor: "#333", color: "#FFF",
    padding: 12, marginBottom: 12, borderRadius: 8,
    borderColor: "#FFD700", borderWidth: 1,
  },
  passwordRow: { flexDirection: "row", alignItems: "center", paddingRight: 8 },
  passwordInput: { flex: 1, color: "#FFF" },
  togglePw: { color: "#FFD700", fontWeight: "600", marginLeft: 8 },
  helper: { width: "90%", color: "#BDBDBD", fontSize: 12, marginBottom: 6 },
  button: {
    backgroundColor: "#FF4500", padding: 15, borderRadius: 8,
    width: "90%", alignItems: "center", marginVertical: 10,
  },
  disabledButton: { backgroundColor: "#555" },
  buttonText: { color: "#FFF", fontSize: 18, fontWeight: "bold" },
  loadingContainer: { alignItems: "center", marginVertical: 10 },
  loadingText: { color: "#FFD700", fontSize: 16, marginTop: 5 },
  footerNote: { color: "#777", fontSize: 12, marginTop: 8, textAlign: "center", width: "90%" },
});

export default RegisterScreen;
