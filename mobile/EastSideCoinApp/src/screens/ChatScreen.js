import React, { useState, useEffect, useContext, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AuthContext } from "../context/AuthProvider";
import { API_URL, WS_URL } from "../config";
import { debounce } from "lodash";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { encryptAES, encryptRSA, decryptAES } from "../utils/encryption";
import SimpleChat from "react-native-simple-chat";

const ChatScreen = ({ navigation }) => {
  const { authToken, user } = useContext(AuthContext);
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [ws, setWs] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    (async () => {
      const privateKey = await AsyncStorage.getItem("privateKey");
      if (!privateKey) {
        Alert.alert("Encryption Setup Needed", "Please generate encryption keys before using chat.");
        navigation.navigate("KeySetupScreen");
      }
    })();
  }, []);

  const fetchUsers = debounce(async (query) => {
    if (query.length < 2) return;
    try {
      const response = await fetch(`${API_URL}/users/search/?query=${query}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await response.json();
      setUsers(data);
    } catch (err) {
      console.error("❌ Error fetching users:", err);
    }
  }, 500);

  useEffect(() => {
    fetchUsers(search);
  }, [search]);

  useEffect(() => {
    if (!selectedUser) return;

    const wsConnection = new WebSocket(`${WS_URL}/chat/?token=${authToken}`);
    console.log(`🔗 Connecting WebSocket for ${selectedUser.id}`);

    wsConnection.onopen = () => console.log("✅ WebSocket Connected");

    wsConnection.onmessage = (event) => {
      const newMessage = JSON.parse(event.data);
      console.log("📥 Received Message:", newMessage);

      const decryptedText = decryptAES(newMessage.encrypted_message);
      setMessages((prev) => [
        ...prev,
        {
          _id: newMessage.id,
          text: decryptedText || "🔒 Encrypted Message",
          createdAt: new Date(),
          user: {
            _id: newMessage.sender,
            name: newMessage.sender === user.id ? "You" : selectedUser.first_name,
          },
        },
      ]);
    };

    wsConnection.onerror = (error) => console.error("❌ WebSocket Error:", error.message);
    wsConnection.onclose = () => console.log("🔴 WebSocket Disconnected");

    setWs(wsConnection);
    return () => wsConnection.close();
  }, [selectedUser]);

  const sendMessage = async (messageText) => {
    if (!selectedUser || !ws) return;

    const privateKey = await AsyncStorage.getItem("privateKey");
    if (!privateKey) {
      Alert.alert("Encryption Setup Needed", "Please generate encryption keys before using chat.");
      navigation.navigate("KeySetupScreen");
      return;
    }

    if (ws.readyState !== WebSocket.OPEN) {
      Alert.alert("WebSocket not connected. Try again.");
      return;
    }

    try {
      let publicKey = await AsyncStorage.getItem(`publicKey_${selectedUser.id}`);
      if (!publicKey) {
        const response = await fetch(`${API_URL}/users/${selectedUser.id}/public_key/`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        const data = await response.json();

        if (!data.public_key) {
          Alert.alert("Encryption Error", "Public key not found for this user.");
          return;
        }

        publicKey = data.public_key;
        await AsyncStorage.setItem(`publicKey_${selectedUser.id}`, publicKey);
      }

      const encryptedMessage = encryptAES(messageText);
      const encryptedKey = encryptRSA(encryptedMessage.key, publicKey);

      console.log("🛫 Sending message to:", selectedUser.id);
      console.log("📦 Encrypted Message:", encryptedMessage.encryptedText);
      console.log("🔐 Encrypted AES Key:", encryptedKey);

      ws.send(
        JSON.stringify({
          receiver_id: selectedUser.id,
          encrypted_message: encryptedMessage.encryptedText,
          encrypted_key: encryptedKey,
        })
      );

      // ✅ Add sender message to chat view
      setMessages((prev) => [
        ...prev,
        {
          _id: Math.random().toString(),
          text: messageText,
          createdAt: new Date(),
          user: { _id: user.id, name: "You" },
        },
      ]);
    } catch (error) {
      console.error("❌ Error sending message:", error);
      Alert.alert("Send Error", "Failed to send message.");
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  return (
    <SafeAreaView style={styles.safeContainer}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.container}>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>

        <TextInput
          style={styles.searchInput}
          placeholder="🔍 Search users..."
          placeholderTextColor="#AAA"
          value={search}
          onChangeText={setSearch}
        />

        {selectedUser ? (
          <SimpleChat
            messages={[...messages]} // latest at bottom
            onPressSendButton={(text) => sendMessage(text)}
            user={{ _id: user.id, name: "You" }}
            placeholder="Type a message..."
            inputStyle={styles.input}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
          />
        ) : (
          <FlatList
            data={users}
            keyExtractor={(item) => item.id.toString()}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[
                  styles.userItem,
                  selectedUser?.id === item.id && { backgroundColor: "#666" },
                ]}
                onPress={() => setSelectedUser(item)}
              >
                <Text style={styles.userText}>{item.first_name} {item.last_name}</Text>
              </TouchableOpacity>
            )}
          />
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeContainer: {
    flex: 1,
    backgroundColor: "#1E1E1E",
  },
  container: {
    flex: 1,
    padding: 15,
  },
  backButton: {
    padding: 10,
    backgroundColor: "#333",
    borderRadius: 5,
    alignSelf: "flex-start",
    marginBottom: 10,
  },
  backText: {
    color: "#FFD700",
    fontSize: 16,
  },
  searchInput: {
    backgroundColor: "#222",
    padding: 12,
    color: "#FFF",
    borderRadius: 10,
    marginBottom: 10,
  },
  userItem: {
    padding: 15,
    backgroundColor: "#444",
    borderRadius: 8,
    marginBottom: 10,
  },
  userText: {
    color: "#FFF",
    fontSize: 16,
  },
  input: {
    backgroundColor: "#333",
    padding: 10,
    color: "#FFF",
    borderRadius: 8,
  },
});

export default ChatScreen;
