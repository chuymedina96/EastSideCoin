import React, { useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const HomeScreen = ({ navigation }) => {
  const wipeAsyncStorage = async () => {
    try {
      await AsyncStorage.clear();
      console.log("🧼 AsyncStorage cleared!");
      Alert.alert("Success", "All local data has been wiped.");
    } catch (e) {
      console.error("❌ Failed to clear AsyncStorage:", e);
      Alert.alert("Error", "Something went wrong clearing storage.");
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome to EastSide Coin</Text>

      <TouchableOpacity
        style={styles.button}
        onPress={() => navigation.navigate("HomeTabs", { screen: "Services" })}
      >
        <Text style={styles.buttonText}>View Services</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.button}
        onPress={() => navigation.navigate("HomeTabs", { screen: "Chat" })}
      >
        <Text style={styles.buttonText}>Chat with Neighbors</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.button}
        onPress={() => navigation.navigate("HomeTabs", { screen: "Wallet" })}
      >
        <Text style={styles.buttonText}>View Wallet</Text>
      </TouchableOpacity>

      {/* 🧼 TEMPORARY CLEAR CACHE BUTTON */}
      <TouchableOpacity style={styles.wipeButton} onPress={wipeAsyncStorage}>
        <Text style={styles.wipeText}>🧼 Wipe Local Storage</Text>
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
  wipeButton: {
    backgroundColor: "#E63946",
    padding: 12,
    borderRadius: 8,
    marginTop: 40,
    width: "80%",
    alignItems: "center",
  },
  wipeText: {
    color: "#FFF",
    fontWeight: "bold",
    fontSize: 16,
  },
});

export default HomeScreen;
