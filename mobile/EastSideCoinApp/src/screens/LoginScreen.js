import React, { useState, useContext } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { AuthContext } from "../context/AuthProvider";
import axios from "axios";
import Web3 from "web3";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useNavigation } from "@react-navigation/native";

const API_URL = "http://192.168.1.125:8000/api";

const LoginScreen = ({ navigation }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useContext(AuthContext); // ✅ Use AuthContext login function

  const handleLogin = async () => {
    setLoading(true);
    try {
      console.log("🚀 Attempting Login:", { email, password });
  
      // ✅ Call `login` from `AuthContext`
      await login(email, password);
  
      // 🚀 Do NOT navigate here! `AuthContext` handles it
      console.log("✅ Login Successful! Handing off navigation to AuthProvider...");
  
    } catch (error) {
      console.error("❌ Login Failed:", error.message);
      Alert.alert("Login Error", error.message);
    } finally {
      setLoading(false);
    }
  };
  

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Log In</Text>
      <TextInput style={styles.input} placeholder="Email" placeholderTextColor="#AAA" value={email} onChangeText={setEmail} keyboardType="email-address" />
      <TextInput style={styles.input} placeholder="Password" placeholderTextColor="#AAA" secureTextEntry value={password} onChangeText={setPassword} />

      {loading ? <ActivityIndicator size="large" color="#E63946" /> : null}

      <TouchableOpacity style={styles.button} onPress={handleLogin}>
        <Text style={styles.buttonText}>Log In</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => navigation.navigate("Register")}>
        <Text style={styles.linkText}>Don't have an account? Sign Up</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#1E1E1E", padding: 20 },
  title: { fontSize: 28, fontWeight: "bold", color: "#FFD700", textAlign: "center", marginBottom: 20 },
  input: { width: "90%", backgroundColor: "#333", color: "#FFF", padding: 12, marginBottom: 12, borderRadius: 8 },
  button: { backgroundColor: "#E63946", padding: 15, borderRadius: 10, alignItems: "center", marginTop: 10 },
  buttonText: { color: "#FFF", fontSize: 18, fontWeight: "bold" },
  linkText: { color: "#FFD700", fontSize: 16, marginTop: 10 },
});

export default LoginScreen;
