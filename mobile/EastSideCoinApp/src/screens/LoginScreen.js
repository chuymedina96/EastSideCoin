// screens/LoginScreen.js
import React, { useState, useContext, useMemo } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AuthContext } from "../context/AuthProvider";
import { useNavigation } from "@react-navigation/native";
import { resetNavigation } from "../navigation/NavigationService";

const MIN_PW = 6;

const LoginScreen = () => {
  const { login } = useContext(AuthContext);
  const navigation = useNavigation();

  const [email, setEmail]         = useState("");
  const [password, setPassword]   = useState("");
  const [showPw, setShowPw]       = useState(false);
  const [loading, setLoading]     = useState(false);
  const [routing, setRouting]     = useState(false); // brief spinner during post-login route decision

  const canSubmit = useMemo(() => {
    return /^\S+@\S+\.\S+$/.test(email.trim()) && password.length >= MIN_PW && !loading && !routing;
  }, [email, password, loading, routing]);

  const routeAfterAuth = async () => {
    setRouting(true);
    try {
      // Give AuthProvider a beat to persist things
      await new Promise((r) => setTimeout(r, 150));

      const priv = await AsyncStorage.getItem("privateKey");
      // Either cached locally or provided by server (AuthProvider may have cached user.public_key to 'publicKey')
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

  const handleLogin = async () => {
    if (!canSubmit) {
      Alert.alert("Check your info", "Enter a valid email and password (min 6 chars).");
      return;
    }
    setLoading(true);
    try {
      const success = await login(email.trim().toLowerCase(), password, /*skipRedirect*/ true);
      if (!success) {
        Alert.alert("Login Error", "Invalid email or password.");
        return;
      }
      // Decide immediately on this screen (AuthProvider also guards, this just makes it snappier)
      await routeAfterAuth();
    } catch (error) {
      console.error("❌ Login Failed:", error?.message || error);
      Alert.alert("Login Error", "Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Log In</Text>

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
          placeholder="Password"
          placeholderTextColor="#AAA"
          secureTextEntry={!showPw}
          value={password}
          onChangeText={setPassword}
          autoCapitalize="none"
          returnKeyType="done"
          onSubmitEditing={handleLogin}
        />
        <TouchableOpacity onPress={() => setShowPw((s) => !s)}>
          <Text style={styles.togglePw}>{showPw ? "Hide" : "Show"}</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.helper}>
        After login, we’ll secure your messages with device keys. If keys are missing,
        you’ll be guided to set them up right away.
      </Text>

      {(loading || routing) && <ActivityIndicator size="large" color="#E63946" />}

      <TouchableOpacity
        style={[styles.button, (!canSubmit || loading || routing) && styles.disabledButton]}
        onPress={handleLogin}
        disabled={!canSubmit || loading || routing}
      >
        <Text style={styles.buttonText}>{loading || routing ? "Checking..." : "Log In"}</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => navigation.navigate("Register")}>
        <Text style={styles.linkText}>Don't have an account? Sign Up</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1, justifyContent: "center", alignItems: "center",
    backgroundColor: "#1E1E1E", padding: 20,
  },
  title: {
    fontSize: 28, fontWeight: "bold", color: "#FFD700",
    textAlign: "center", marginBottom: 20,
  },
  input: {
    width: "90%", backgroundColor: "#333", color: "#FFF",
    padding: 12, marginBottom: 12, borderRadius: 8, borderColor: "#444", borderWidth: 1,
  },
  passwordRow: { flexDirection: "row", alignItems: "center", paddingRight: 8 },
  passwordInput: { flex: 1, color: "#FFF" },
  togglePw: { color: "#FFD700", fontWeight: "600", marginLeft: 8 },
  helper: { width: "90%", color: "#BDBDBD", fontSize: 12, marginBottom: 6 },
  button: {
    backgroundColor: "#E63946", padding: 15, borderRadius: 10,
    alignItems: "center", marginTop: 10, width: "90%",
  },
  disabledButton: { backgroundColor: "#555" },
  buttonText: { color: "#FFF", fontSize: 18, fontWeight: "bold" },
  linkText: { color: "#FFD700", fontSize: 16, marginTop: 10 },
});

export default LoginScreen;
