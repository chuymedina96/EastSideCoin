// screens/ProfileScreen.js
import React, { useContext, useState, useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert, ActivityIndicator } from "react-native";
import { AuthContext } from "../context/AuthProvider";

const ProfileScreen = () => {
  const { user, logoutUser, deleteAccountAndLogout } = useContext(AuthContext);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const displayName = useMemo(() => {
    if (!user) return "";
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
    return name || user.email || "";
  }, [user]);

  const handleLogout = async () => {
    if (isLoggingOut || isDeleting) return;
    setIsLoggingOut(true);
    try {
      await logoutUser();
    } finally {
      setIsLoggingOut(false);
    }
  };

  const handleDelete = async () => {
    if (isLoggingOut || isDeleting) return;
    if (!deleteAccountAndLogout) {
      Alert.alert("Unavailable", "Delete account isn’t available in this build. Logging out instead.");
      return handleLogout();
    }

    Alert.alert(
      "Delete Account",
      "This will permanently remove your account and wipe keys on this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setIsDeleting(true);
            try {
              await deleteAccountAndLogout();
            } finally {
              setIsDeleting(false);
            }
          },
        },
      ]
    );
  };

  const anyBusy = isLoggingOut || isDeleting;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>User Profile</Text>
      {!!displayName && <Text style={styles.subtitle}>{displayName}</Text>}
      {!!user?.email && <Text style={styles.email}>{user.email}</Text>}

      <TouchableOpacity
        style={[styles.button, anyBusy && styles.buttonDisabled]}
        onPress={handleLogout}
        disabled={anyBusy}
        accessibilityLabel="Log out"
      >
        {isLoggingOut ? (
          <ActivityIndicator color="#FFF" />
        ) : (
          <Text style={styles.buttonText}>Logout</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.button, styles.danger, anyBusy && styles.buttonDisabled]}
        onPress={handleDelete}
        disabled={anyBusy}
        accessibilityLabel="Delete account"
      >
        {isDeleting ? (
          <ActivityIndicator color="#FFF" />
        ) : (
          <Text style={styles.buttonText}>Delete Account</Text>
        )}
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container:{ flex:1, justifyContent:"center", alignItems:"center", backgroundColor:"#1E1E1E", padding:20 },
  title:{ fontSize:24, fontWeight:"bold", color:"#FFD700", marginBottom:6 },
  subtitle:{ fontSize:16, color:"#EEE", marginBottom:2 },
  email:{ fontSize:14, color:"#BDBDBD", marginBottom:20 },
  button:{
    backgroundColor:"#FF4500",
    paddingVertical:15,
    borderRadius:8,
    marginTop:16,
    width:"75%",
    alignItems:"center",
  },
  danger:{ backgroundColor:"#E63946" },
  buttonDisabled:{ opacity:0.6 },
  buttonText:{ color:"#FFF", fontSize:18, fontWeight:"bold" },
});

export default ProfileScreen;
