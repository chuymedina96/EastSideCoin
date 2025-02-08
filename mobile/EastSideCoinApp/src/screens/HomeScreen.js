import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";

const HomeScreen = ({ navigation }) => {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome to EastSide Coin</Text>

      <TouchableOpacity style={styles.button} onPress={() => navigation.navigate("HomeTabs", { screen: "Services" })}>
        <Text style={styles.buttonText}>View Services</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.button} onPress={() => navigation.navigate("HomeTabs", { screen: "Chat" })}>
        <Text style={styles.buttonText}>Chat with Neighbors</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.button} onPress={() => navigation.navigate("HomeTabs", { screen: "Wallet" })}>
        <Text style={styles.buttonText}>View Wallet</Text>
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
    padding: 20,
  },
  title: {
    fontSize: 26,
    fontWeight: "bold",
    color: "#FFD700",
    marginBottom: 30,
  },
  button: {
    backgroundColor: "#FF4500",
    padding: 15,
    borderRadius: 8,
    marginVertical: 10,
    width: "80%",
    alignItems: "center",
  },
  buttonText: {
    color: "#FFF",
    fontSize: 18,
    fontWeight: "bold",
  },
});

export default HomeScreen;
