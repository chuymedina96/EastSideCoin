import React from "react";
import { View, Text, StyleSheet } from "react-native";

const ChatScreen = () => {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Community Chat</Text>
      <Text style={styles.text}>Chat feature is under development.</Text>
    </View>
  );
};

ChatScreen.navigationOptions = ({ navigation }) => ({
  title: "Chat",
  headerLeft: () => <Button title="Back" onPress={() => navigation.goBack()} />,
});


const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#1E1E1E",
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
  },
});

export default ChatScreen;
