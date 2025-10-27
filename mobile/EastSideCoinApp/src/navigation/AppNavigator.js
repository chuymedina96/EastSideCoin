// navigation/AppNavigator.js
import React, { useContext } from "react";
import { createStackNavigator } from "@react-navigation/stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import Ionicons from "react-native-vector-icons/Ionicons";

import { AuthContext } from "../context/AuthProvider";

import LandingScreen from "../screens/LandingScreen";
import LoginScreen from "../screens/LoginScreen";
import RegisterScreen from "../screens/RegisterScreen";
import HomeScreen from "../screens/HomeScreen";
import WalletScreen from "../screens/WalletScreen";
import ChatScreen from "../screens/ChatScreen";
import ServicesScreen from "../screens/ServicesScreen";
import ProfileScreen from "../screens/ProfileScreen";
import KeyScreenSetup from "../screens/KeyScreenSetup";

const AuthStack = createStackNavigator();
const AppStack = createStackNavigator();
const Tab = createBottomTabNavigator();

const iconMap = {
  Home: "home",
  Wallet: "wallet",
  Chat: "chatbubbles",
  Services: "briefcase",
  Profile: "person",
};

const HomeTabs = () => (
  <Tab.Navigator
    screenOptions={({ route }) => ({
      headerShown: false,
      tabBarIcon: ({ color, size }) => (
        <Ionicons name={iconMap[route.name] ?? "home"} size={size} color={color} />
      ),
      tabBarActiveTintColor: "#E63946",
      tabBarInactiveTintColor: "gray",
      tabBarHideOnKeyboard: true,         // nicer input UX
    })}
    // Helps performance a bit; RN handles this well now.
    // detachInactiveScreens={true}
  >
    <Tab.Screen name="Home" component={HomeScreen} />
    <Tab.Screen name="Wallet" component={WalletScreen} />
    <Tab.Screen
      name="Chat"
      component={ChatScreen}
      options={{ unmountOnBlur: true }}   // extra WS safety
    />
    <Tab.Screen name="Services" component={ServicesScreen} />
    <Tab.Screen name="Profile" component={ProfileScreen} />
  </Tab.Navigator>
);

// ---- Auth stack when not logged in ------------------------------------------
const AuthNavigator = () => (
  <AuthStack.Navigator screenOptions={{ headerShown: false }} initialRouteName="Landing">
    <AuthStack.Screen name="Landing" component={LandingScreen} />
    <AuthStack.Screen name="Login" component={LoginScreen} />
    <AuthStack.Screen name="Register" component={RegisterScreen} />
  </AuthStack.Navigator>
);

// ---- App stack when logged in ------------------------------------------------
// Note: the `key` forces a remount when keysReady flips, so initialRouteName is honored.
const AppNavigatorInner = ({ keysReady }) => (
  <AppStack.Navigator
    screenOptions={{ headerShown: false }}
    initialRouteName={keysReady ? "HomeTabs" : "KeyScreenSetup"}
    key={keysReady ? "app-home" : "app-keys"}
  >
    <AppStack.Screen
      name="KeyScreenSetup"
      component={KeyScreenSetup}
      options={{ gestureEnabled: false }} // don't allow swipe-back into auth flow
    />
    <AppStack.Screen name="HomeTabs" component={HomeTabs} />
  </AppStack.Navigator>
);

const AppNavigator = () => {
  const { user, keysReady } = useContext(AuthContext);
  return user ? <AppNavigatorInner keysReady={!!keysReady} /> : <AuthNavigator />;
};

export default AppNavigator;
