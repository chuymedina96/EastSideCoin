// navigation/AppNavigator.js
import React, { useContext } from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import Ionicons from "react-native-vector-icons/Ionicons";
import { AuthContext } from "../context/AuthProvider";

// Screens
import LandingScreen from "../screens/LandingScreen";
import LoginScreen from "../screens/LoginScreen";
import RegisterScreen from "../screens/RegisterScreen";
import HomeScreen from "../screens/HomeScreen";
import WalletScreen from "../screens/WalletScreen";
import ChatScreen from "../screens/ChatScreen";
import ServicesScreen from "../screens/ServicesScreen";
import ProfileScreen from "../screens/ProfileScreen";
import KeyScreenSetup from "../screens/KeyScreenSetup";

const AuthStack = createNativeStackNavigator();
const AppStack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

const iconMap = {
  Home: "home",
  Wallet: "wallet",
  Chat: "chatbubbles",
  Services: "briefcase",
  Profile: "person",
};

const tabTheme = {
  bg: "#101012",
  card: "#1b1b1f",
  text: "#EEE",
  border: "#2a2a2e",
  gold: "#FFD700",
  red: "#E63946",
};

// ---------------- Tabs (main app) ----------------
const HomeTabs = () => (
  <Tab.Navigator
    screenOptions={({ route }) => ({
      headerShown: false,
      tabBarIcon: ({ color, size }) => (
        <Ionicons name={iconMap[route.name] ?? "home"} size={size} color={color} />
      ),
      tabBarActiveTintColor: tabTheme.red,
      tabBarInactiveTintColor: "gray",
      tabBarHideOnKeyboard: true,
      tabBarStyle: {
        backgroundColor: tabTheme.card,
        borderTopColor: tabTheme.border,
      },
    })}
  >
    <Tab.Screen
      name="Home"
      component={HomeScreen}
      options={{ /* keeps global fade on push into HomeTabs */ }}
    />
    <Tab.Screen
      name="Wallet"
      component={WalletScreen}
      options={{ /* can also add header if you want */ }}
    />
    <Tab.Screen
      name="Chat"
      component={ChatScreen}
      options={{
        unmountOnBlur: true, // WS safety
      }}
    />
    <Tab.Screen name="Services" component={ServicesScreen} />
    <Tab.Screen name="Profile" component={ProfileScreen} />
  </Tab.Navigator>
);

// ---------------- Auth (logged out) --------------
const AuthNavigator = () => (
  <AuthStack.Navigator
    initialRouteName="Landing"
    screenOptions={{
      headerShown: false,
      animation: "fade", // quick, subtle between auth screens
      contentStyle: { backgroundColor: tabTheme.bg },
    }}
  >
    <AuthStack.Screen name="Landing" component={LandingScreen} />
    <AuthStack.Screen name="Login" component={LoginScreen} />
    <AuthStack.Screen name="Register" component={RegisterScreen} />
  </AuthStack.Navigator>
);

// ---------------- App (logged in) ----------------
const AppNavigatorInner = ({ keysReady }) => (
  <AppStack.Navigator
    // fade by default; per-screen overrides below
    screenOptions={{
      headerShown: false,
      animation: "fade",
      contentStyle: { backgroundColor: tabTheme.bg },
      gestureEnabled: true,
      fullScreenGestureEnabled: true,
    }}
    initialRouteName={keysReady ? "HomeTabs" : "KeyScreenSetup"}
    key={keysReady ? "app-home" : "app-keys"} // ensures correct initial route on flip
  >
    <AppStack.Screen
      name="KeyScreenSetup"
      component={KeyScreenSetup}
      options={{
        gestureEnabled: false,          // don’t allow swipe back into auth
        animation: "slide_from_bottom", // feels like a setup sheet
      }}
    />
    <AppStack.Screen
      name="HomeTabs"
      component={HomeTabs}
      options={{
        animation: "slide_from_right",  // nice push when leaving setup
      }}
    />

    {/*
      If you later want a modal outside tabs (e.g., QR Scanner, Sheet),
      add it here with a modal presentation:

      <AppStack.Screen
        name="QrModal"
        component={QrModalScreen}
        options={{
          headerShown: true,
          title: "Scan",
          presentation: "modal",
          animation: "slide_from_bottom",
        }}
      />
    */}
  </AppStack.Navigator>
);

const AppNavigator = () => {
  const { user, keysReady } = useContext(AuthContext);
  return user ? <AppNavigatorInner keysReady={!!keysReady} /> : <AuthNavigator />;
};

export default AppNavigator;
