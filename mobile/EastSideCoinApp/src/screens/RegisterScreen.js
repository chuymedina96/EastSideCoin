import React, { useState, useContext } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Image, ActivityIndicator, Alert } from "react-native";
import { AuthContext } from "../context/AuthProvider";
import { useNavigation } from "@react-navigation/native";

const RegisterScreen = () => {
  const { register } = useContext(AuthContext);
  const navigation = useNavigation();
  
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleRegister = async () => {
    setLoading(true);
    try {
      await register(firstName.trim(), lastName.trim(), email.trim().toLowerCase(), password);
    } catch (error) {
      console.error("❌ Registration Error:", error);
      Alert.alert("Registration Error", "Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* Logo */}
      <Image source={require("../../assets/Eastside Coin.webp")} style={styles.logo} />
      <Text style={styles.title}>Create Your Account</Text>
      <Text style={styles.subtitle}>Join the EastSide Coin community</Text>

      {/* Input Fields */}
      <TextInput
        style={styles.input}
        placeholder="First Name"
        placeholderTextColor="#AAA"
        value={firstName}
        onChangeText={setFirstName}
      />
      <TextInput
        style={styles.input}
        placeholder="Last Name"
        placeholderTextColor="#AAA"
        value={lastName}
        onChangeText={setLastName}
      />
      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor="#AAA"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor="#AAA"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      {loading && <ActivityIndicator size="large" color="#E63946" />}

      {/* Register Button */}
      <TouchableOpacity style={styles.button} onPress={handleRegister} disabled={loading}>
        <Text style={styles.buttonText}>{loading ? "Registering..." : "Sign Up"}</Text>
      </TouchableOpacity>

      {/* Navigate to Login Screen */}
      <TouchableOpacity onPress={() => navigation.navigate("Login")}>
        <Text style={styles.linkText}>Already have an account? Log in</Text>
      </TouchableOpacity>

      {/* Navigate to Landing Page */}
      <TouchableOpacity onPress={() => navigation.navigate("Landing")}>
        <Text style={styles.backText}>← Back to Landing</Text>
      </TouchableOpacity>
    </View>
  );
};

// ✅ Styles
const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#1E1E1E", padding: 20 },
  logo: { width: 120, height: 120, resizeMode: "contain", marginBottom: 20 },
  title: { fontSize: 26, fontWeight: "bold", color: "#FFD700", marginBottom: 5 },
  subtitle: { fontSize: 14, color: "#CCC", textAlign: "center", marginBottom: 25 },
  input: {
    width: "90%",
    backgroundColor: "#333",
    color: "#FFF",
    padding: 12,
    marginBottom: 12,
    borderRadius: 8,
    placeholderTextColor: "#AAA",
  },
  button: { backgroundColor: "#FF4500", padding: 15, borderRadius: 8, width: "90%", alignItems: "center", marginVertical: 10 },
  buttonText: { color: "#FFF", fontSize: 18, fontWeight: "bold" },
  linkText: { color: "#FFD700", fontSize: 16, marginTop: 10 },
  backText: { color: "#888", fontSize: 14, marginTop: 20 },
});

export default RegisterScreen;
