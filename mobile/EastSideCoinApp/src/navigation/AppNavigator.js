import React, { useContext } from "react";
import { createStackNavigator } from "@react-navigation/stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { AuthContext } from "../context/AuthProvider";

import LandingScreen from "../screens/LandingScreen";
import LoginScreen from "../screens/LoginScreen";
import RegisterScreen from "../screens/RegisterScreen";
import HomeScreen from "../screens/HomeScreen";
import WalletScreen from "../screens/WalletScreen";
import ChatScreen from "../screens/ChatScreen";
import ServicesScreen from "../screens/ServicesScreen";
import ProfileScreen from "../screens/ProfileScreen";
import KeyScreenSetup from "../screens/KeyScreenSetup"; // ✅ Import Key Setup Screen

import Ionicons from "react-native-vector-icons/Ionicons";

const Stack = createStackNavigator();
const Tab = createBottomTabNavigator();

// ✅ Bottom Tabs for Authenticated Users
const HomeTabs = () => (
  <Tab.Navigator
    screenOptions={({ route }) => ({
      headerShown: false,
      tabBarIcon: ({ color, size }) => {
        let iconName;
        if (route.name === "Home") iconName = "home";
        else if (route.name === "Wallet") iconName = "wallet";
        else if (route.name === "Chat") iconName = "chatbubbles";
        else if (route.name === "Services") iconName = "briefcase";
        else if (route.name === "Profile") iconName = "person";

        return <Ionicons name={iconName} size={size} color={color} />;
      },
      tabBarActiveTintColor: "#E63946",
      tabBarInactiveTintColor: "gray",
    })}
  >
    <Tab.Screen name="Home" component={HomeScreen} />
    <Tab.Screen name="Wallet" component={WalletScreen} />
    <Tab.Screen name="Chat" component={ChatScreen} />
    <Tab.Screen name="Services" component={ServicesScreen} />
    <Tab.Screen name="Profile" component={ProfileScreen} />
  </Tab.Navigator>
);

// ✅ Main App Navigator (Ensuring HomeTabs and KeyScreenSetup are Recognized)
const AppNavigator = () => {
  const { user } = useContext(AuthContext);

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {user ? (
        <>
          {/* 🔥 Explicitly Define HomeTabs and KeyScreenSetup */}
          <Stack.Screen name="HomeTabs" component={HomeTabs} />
          <Stack.Screen name="KeyScreenSetup" component={KeyScreenSetup} />
        </>
      ) : (
        <>
          <Stack.Screen name="Landing" component={LandingScreen} />
          <Stack.Screen name="Login" component={LoginScreen} />
          <Stack.Screen name="Register" component={RegisterScreen} />
        </>
      )}
    </Stack.Navigator>
  );
};

export default AppNavigator;
