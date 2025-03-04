import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";
 import { API_URL } from "../config";




const WalletScreen = () => {
  const [walletAddress, setWalletAddress] = useState(null);
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchWalletData = async () => {
      const user = await AsyncStorage.getItem("user");
      if (user) {
        const parsedUser = JSON.parse(user);
        setWalletAddress(parsedUser.wallet_address);

        try {
          console.log("📡 Fetching Wallet Balance from:", `${API_URL}/balance/${user.wallet_address}/`);
          const response = await axios.get(`${API_URL}/balance/${user.wallet_address}/`);
          setBalance(response.data.balance);
        } catch (error) {
          console.error("❌ Wallet Fetch Error:", error);
        }
      }
      setLoading(false);
    };

    fetchWalletData();
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Wallet Balance</Text>
      {loading ? (
        <ActivityIndicator size="large" color="#FFD700" />
      ) : (
        <Text style={styles.balance}>Balance: {balance} ESC</Text>
      )}
    </View>
  );
};

WalletScreen.navigationOptions = ({ navigation }) => ({
  title: "Wallet",
  headerLeft: () => <Button title="Back" onPress={() => navigation.goBack()} />,
});


const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#1E1E1E", padding: 20 },
  title: { fontSize: 26, fontWeight: "bold", color: "#FFD700", marginBottom: 10 },
  balance: { fontSize: 20, color: "#FFF" },
});

export default WalletScreen;
