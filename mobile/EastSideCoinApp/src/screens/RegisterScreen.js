import React, { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Image, ActivityIndicator, Alert } from "react-native";
import axios from "axios";
import Web3 from "web3";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useNavigation } from "@react-navigation/native";

const API_URL = "http://192.168.1.125:8000/api"; // ✅ Replace with actual API

const RegisterScreen = () => {
  const navigation = useNavigation();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  // ✅ Generate Ethereum Wallet Locally (No API Key Needed)
  const generateWallet = () => {
    try {
      const web3 = new Web3(); // ✅ No provider needed (offline generation)
      const newWallet = web3.eth.accounts.create();
      console.log("🔑 Generated Wallet Address:", newWallet.address);
      return newWallet;
    } catch (error) {
      console.error("❌ Wallet Generation Failed:", error.message);
      return null;
    }
  };

  const handleRegister = async () => {
    setLoading(true);
    try {
      const wallet = generateWallet();
      if (!wallet) {
        Alert.alert("Error", "Failed to generate wallet. Try again.");
        setLoading(false);
        return;
      }

      // ✅ Store Private Key Securely (Consider secure storage for production)
      await AsyncStorage.setItem("wallet_privateKey", wallet.privateKey);

      const userData = {
        first_name: firstName,
        last_name: lastName,
        email,
        password,
        wallet_address: wallet.address, // ✅ Send generated wallet address to backend
      };

      console.log("🚀 Registering User:", userData);
      await axios.post(`${API_URL}/register/`, userData);
      
      Alert.alert("Success", "Account Created! Please log in.");
      navigation.navigate("Login"); // ✅ Navigate to Login after registration
    } catch (error) {
      console.error("❌ Registration Error:", error.response?.data || error.message);
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
      <TextInput style={styles.input} placeholder="First Name" placeholderTextColor="#AAA" value={firstName} onChangeText={setFirstName} />
      <TextInput style={styles.input} placeholder="Last Name" placeholderTextColor="#AAA" value={lastName} onChangeText={setLastName} />
      <TextInput style={styles.input} placeholder="Email" placeholderTextColor="#AAA" value={email} onChangeText={setEmail} keyboardType="email-address" />
      <TextInput style={styles.input} placeholder="Password" placeholderTextColor="#AAA" secureTextEntry value={password} onChangeText={setPassword} />

      {loading ? <ActivityIndicator size="large" color="#E63946" /> : null}

      <TouchableOpacity style={styles.button} onPress={handleRegister} disabled={loading}>
        <Text style={styles.buttonText}>{loading ? "Registering..." : "Sign Up"}</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => navigation.navigate("Login")}>
        <Text style={styles.linkText}>Already have an account? Log in</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => navigation.navigate("Landing")}>
        <Text style={styles.backText}>← Back to Landing</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#1E1E1E", padding: 20 },
  logo: { width: 120, height: 120, resizeMode: "contain", marginBottom: 20 },
  title: { fontSize: 26, fontWeight: "bold", color: "#FFD700", marginBottom: 5 },
  subtitle: { fontSize: 14, color: "#CCC", textAlign: "center", marginBottom: 25 },
  input: { width: "90%", backgroundColor: "#333", color: "#FFF", padding: 12, marginBottom: 12, borderRadius: 8 },
  button: { backgroundColor: "#FF4500", padding: 15, borderRadius: 8, width: "90%", alignItems: "center", marginVertical: 10 },
  buttonText: { color: "#FFF", fontSize: 18, fontWeight: "bold" },
  linkText: { color: "#FFD700", fontSize: 16, marginTop: 10 },
  backText: { color: "#888", fontSize: 14, marginTop: 20 },
});

export default RegisterScreen;
