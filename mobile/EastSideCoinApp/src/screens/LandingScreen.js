import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Image, Animated } from "react-native";
import { useNavigation } from "@react-navigation/native";

const LandingScreen = () => {
  const navigation = useNavigation();
  const fadeAnim = new Animated.Value(0);

  // ✅ Fade in animation when the screen loads
  React.useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 1000,
      useNativeDriver: true,
    }).start();
  }, []);

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
      {/* Logo */}
      <Image source={require("../../assets/Eastside Coin.webp")} style={styles.logo} />

      {/* App Title */}
      <Text style={styles.title}>Welcome to EastSide Coin</Text>
      <Text style={styles.subtitle}>Trade, connect, and support your community</Text>

      {/* Buttons */}
      <TouchableOpacity style={styles.button} onPress={() => navigation.navigate("Login")}>
        <Text style={styles.buttonText}>Log In</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.button} onPress={() => navigation.navigate("Register")}>
        <Text style={styles.buttonText}>Sign Up</Text>
      </TouchableOpacity>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#1E1E1E",
    padding: 20,
  },
  logo: {
    width: 120, // ✅ Auto-adjust logo size
    height: 120,
    resizeMode: "contain",
    marginBottom: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#FFD700",
    marginBottom: 10,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 16,
    color: "#CCC",
    textAlign: "center",
    marginBottom: 30,
  },
  button: {
    backgroundColor: "#FF4500",
    padding: 15,
    borderRadius: 10,
    width: "80%",
    alignItems: "center",
    marginVertical: 10,
    shadowColor: "#FFF",
    shadowOpacity: 0.4,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
  },
  buttonText: {
    color: "#FFF",
    fontSize: 18,
    fontWeight: "bold",
  },
});

export default LandingScreen;
