import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";

const API_URL = "http://192.168.1.125/api/balance/";

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
          const response = await axios.get(`${API_URL}${parsedUser.wallet_address}`);
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
      <Text style={styles.title}>My Wallet</Text>
      {loading ? <ActivityIndicator size="large" color="#FFD700" /> : (
        <>
          <Text style={styles.text}>Wallet Address:</Text>
          <Text style={styles.wallet}>{walletAddress}</Text>
          <Text style={styles.text}>ESC Balance: {balance}</Text>
        </>
      )}
    </View>
  );
};

WalletScreen.navigationOptions = ({ navigation }) => ({
  title: "Wallet",
  headerLeft: () => <Button title="Back" onPress={() => navigation.goBack()} />,
});


const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#1E1E1E",
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    color: "#FFD700",
    marginBottom: 10,
  },
  text: {
    fontSize: 18,
    color: "#FFF",
    marginBottom: 5,
  },
  wallet: {
    fontSize: 14,
    color: "#CCC",
    textAlign: "center",
    marginBottom: 10,
  },
});

export default WalletScreen;
