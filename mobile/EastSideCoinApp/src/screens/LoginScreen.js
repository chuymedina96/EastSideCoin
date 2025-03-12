import React, { useState, useContext } from "react";
import { 
  View, 
  Text, 
  TextInput, 
  TouchableOpacity, 
  StyleSheet, 
  ActivityIndicator, 
  Alert 
} from "react-native";
import { AuthContext } from "../context/AuthProvider";
import { useNavigation } from "@react-navigation/native";

const LoginScreen = () => {
  const { login } = useContext(AuthContext);
  const navigation = useNavigation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setLoading(true);
    console.log("🚀 Attempting Login:", { email, password });
  
    try {
      const success = await login(email.trim().toLowerCase(), password);
      if (success) {
        console.log("✅ Login Successful! Redirecting...");
  
        // ✅ Reset navigation properly
        // navigation.reset({ index: 0, routes: [{ name: "Main" }] });


      } else {
        console.log("❌ Login Failed! No navigation triggered.");
        Alert.alert("Login Error", "Invalid email or password.");
      }
    } catch (error) {
      console.error("❌ Login Failed:", error.message);
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
        autoCapitalize="none" // Prevents auto-capitalization issues
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

      <TouchableOpacity 
        style={styles.button} 
        onPress={handleLogin} 
        disabled={loading}
      >
        <Text style={styles.buttonText}>{loading ? "Logging in..." : "Log In"}</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => navigation.navigate("Register")}>
        <Text style={styles.linkText}>Don't have an account? Sign Up</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    justifyContent: "center", 
    alignItems: "center", 
    backgroundColor: "#1E1E1E", 
    padding: 20 
  },
  title: { 
    fontSize: 28, 
    fontWeight: "bold", 
    color: "#FFD700", 
    textAlign: "center", 
    marginBottom: 20 
  },
  input: { 
    width: "90%", 
    backgroundColor: "#333", 
    color: "#FFF", 
    padding: 12, 
    marginBottom: 12, 
    borderRadius: 8 
  },
  button: { 
    backgroundColor: "#E63946", 
    padding: 15, 
    borderRadius: 10, 
    alignItems: "center", 
    marginTop: 10 
  },
  buttonText: { 
    color: "#FFF", 
    fontSize: 18, 
    fontWeight: "bold" 
  },
  linkText: { 
    color: "#FFD700", 
    fontSize: 16, 
    marginTop: 10 
  },
});

export default LoginScreen;
