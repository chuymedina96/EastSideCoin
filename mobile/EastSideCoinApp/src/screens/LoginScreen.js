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
        // Hydrate legacy slot if a per-user key already exists on this device
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

      // Fallback legacy check (very unlikely)
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
      // Don’t generate keys here—route to KeyScreenSetup if needed
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
        After login, if your device doesn’t have keys yet, we’ll walk you through setup.
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
