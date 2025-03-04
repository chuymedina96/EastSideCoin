import React, { useState, useEffect, useContext } from "react";
import { View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet, Alert, KeyboardAvoidingView, Platform } from "react-native";
import { AuthContext } from "../context/AuthProvider";
import { API_URL, WS_URL } from "../config";
import { debounce } from "lodash";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { encryptAES, encryptRSA, decryptAES } from "../utils/encryption";

// ✅ Alternative Simple Chat Component
import SimpleChat from "react-native-simple-chat";

const ChatScreen = ({ navigation }) => {
  const { authToken, user } = useContext(AuthContext);
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [ws, setWs] = useState(null);

  // ✅ Ensure User Has Encryption Keys Before Using Chat
  useEffect(() => {
    const checkEncryptionSetup = async () => {
      const privateKey = await AsyncStorage.getItem("privateKey");
      if (!privateKey) {
        Alert.alert("Encryption Setup Needed", "Please generate encryption keys before using chat.");
        navigation.navigate("KeySetupScreen");
      }
    };
    checkEncryptionSetup();
  }, []);

  // ✅ Fetch Users (Debounced)
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

  // ✅ Open WebSocket when a user is selected
  useEffect(() => {
    if (!selectedUser) return;
    console.log(`🔗 Connecting WebSocket for ${selectedUser.id}`);
    const wsConnection = new WebSocket(`${WS_URL}/chat/${selectedUser.id}/`);

    wsConnection.onopen = () => console.log("✅ WebSocket Connected");
    wsConnection.onmessage = (event) => {
      const newMessage = JSON.parse(event.data);
      setMessages((prev) => [
        {
          _id: newMessage.id,
          text: decryptAES(newMessage.encrypted_message) || "🔒 Encrypted Message",
          createdAt: new Date(),
          user: {
            _id: newMessage.sender,
            name: selectedUser.first_name,
          },
        },
        ...prev,
      ]);
    };
    wsConnection.onerror = (error) => console.error("❌ WebSocket Error:", error.message);
    wsConnection.onclose = () => console.log("🔴 WebSocket Disconnected");

    setWs(wsConnection);
    return () => wsConnection.close();
  }, [selectedUser]);

  // ✅ Send Encrypted Message
  const sendMessage = async (messageText) => {
    if (!selectedUser) return;

    const privateKey = await AsyncStorage.getItem("privateKey");
    if (!privateKey) {
      Alert.alert("Encryption Setup Needed", "Please generate encryption keys before using chat.");
      navigation.navigate("KeySetupScreen");
      return;
    }

    try {
      const publicKey = await AsyncStorage.getItem(`publicKey_${selectedUser.id}`);
      if (!publicKey) {
        Alert.alert("Encryption Error", "Public key not found for this user.");
        return;
      }

      const encryptedMessage = encryptAES(messageText);
      const encryptedKey = encryptRSA(encryptedMessage.key, publicKey);

      ws.send(
        JSON.stringify({
          receiver_id: selectedUser.id,
          encrypted_message: encryptedMessage.encryptedText,
          encrypted_key: encryptedKey,
        })
      );

      setMessages((prev) => [
        {
          _id: Math.random().toString(),
          text: messageText,
          createdAt: new Date(),
          user: { _id: user.id, name: "You" },
        },
        ...prev,
      ]);
    } catch (error) {
      console.error("❌ Error sending message:", error);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.container}>
      {/* Back Button */}
      <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
        <Text style={styles.backText}>← Back</Text>
      </TouchableOpacity>

      {/* Search Users */}
      <TextInput style={styles.searchInput} placeholder="🔍 Search users..." placeholderTextColor="#AAA" value={search} onChangeText={setSearch} />

      {/* Chat Section */}
      {selectedUser ? (
        <SimpleChat
          messages={messages}
          onSend={(text) => sendMessage(text)}
          user={{ _id: user.id, name: "You" }}
          placeholder="Type a message..."
          inputStyle={styles.input}
        />
      ) : (
        <FlatList
          data={users}
          keyExtractor={(item) => item.id.toString()}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.userItem} onPress={() => setSelectedUser(item)}>
              <Text style={styles.userText}>{item.first_name} {item.last_name}</Text>
            </TouchableOpacity>
          )}
        />
      )}
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#1E1E1E", padding: 15 },
  backButton: { padding: 10, backgroundColor: "#333", borderRadius: 5, alignSelf: "flex-start", marginBottom: 10 },
  backText: { color: "#FFD700", fontSize: 16 },
  searchInput: { backgroundColor: "#222", padding: 12, color: "#FFF", borderRadius: 10, marginBottom: 10 },
  userItem: { padding: 15, backgroundColor: "#444", borderRadius: 8, marginBottom: 10 },
  userText: { color: "#FFF", fontSize: 16 },
  input: { backgroundColor: "#333", padding: 10, color: "#FFF", borderRadius: 8 },
});

export default ChatScreen;
