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
import BookingsScreen from "../screens/BookingsScreen";
import ProfileScreen from "../screens/ProfileScreen";
import KeyScreenSetup from "../screens/KeyScreenSetup";
import OnboardingScreen from "../screens/OnboardingScreen";
import UserProfile from "../screens/UserProfile";
import FlappyEscScreen from "../screens/FlappyEscScreen"; // Flappy ESC game

const AuthStack = createNativeStackNavigator();
const AppStack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

const iconMap = {
  Home: "home",
  Wallet: "wallet",
  Chat: "chatbubbles",
  Services: "briefcase",
  Bookings: "calendar",
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
    <Tab.Screen name="Home" component={HomeScreen} />
    <Tab.Screen name="Wallet" component={WalletScreen} />
    <Tab.Screen
      name="Chat"
      component={ChatScreen}
      options={{ unmountOnBlur: true }}
    />
    <Tab.Screen name="Services" component={ServicesScreen} />
    <Tab.Screen
      name="Bookings"
      component={BookingsScreen}
      options={{ title: "Bookings" }}
    />
    <Tab.Screen name="Profile" component={ProfileScreen} />
  </Tab.Navigator>
);

const AuthNavigator = () => (
  <AuthStack.Navigator
    initialRouteName="Landing"
    screenOptions={{
      headerShown: false,
      animation: "fade",
      contentStyle: { backgroundColor: tabTheme.bg },
    }}
  >
    <AuthStack.Screen name="Landing" component={LandingScreen} />
    <AuthStack.Screen name="Login" component={LoginScreen} />
    <AuthStack.Screen name="Register" component={RegisterScreen} />
  </AuthStack.Navigator>
);

/**
 * Distinct trees so the correct initial route is guaranteed.
 */
const AppNavigator = () => {
  const { user, keysReady } = useContext(AuthContext);

  // Logged out
  if (!user) return <AuthNavigator />;

  // Logged in, but keys not ready
  if (!keysReady) {
    return (
      <AppStack.Navigator
        key="app-needs-keys"
        screenOptions={{
          headerShown: false,
          animation: "fade",
          contentStyle: { backgroundColor: tabTheme.bg },
        }}
        initialRouteName="KeyScreenSetup"
      >
        <AppStack.Screen
          name="KeyScreenSetup"
          component={KeyScreenSetup}
          options={{ gestureEnabled: false, animation: "slide_from_bottom" }}
        />
      </AppStack.Navigator>
    );
  }

  // Logged in and keys ready, but onboarding not done
  const needsOnboarding = user?.onboarding_completed !== true;
  if (needsOnboarding) {
    return (
      <AppStack.Navigator
        key="app-needs-onboarding"
        screenOptions={{
          headerShown: false,
          animation: "fade",
          contentStyle: { backgroundColor: tabTheme.bg },
        }}
        initialRouteName="Onboarding"
      >
        <AppStack.Screen
          name="Onboarding"
          component={OnboardingScreen}
          options={{ gestureEnabled: false }}
        />
        <AppStack.Screen name="HomeTabs" component={HomeTabs} />
        <AppStack.Screen name="UserProfile" component={UserProfile} />
        {/* Easter egg game available even during onboarding if you navigate to it */}
        <AppStack.Screen
          name="FlappyESC"
          component={FlappyEscScreen}
          options={{
            headerShown: false,
            animation: "slide_from_right",
          }}
        />
      </AppStack.Navigator>
    );
  }

  // Fully ready
  return (
    <AppStack.Navigator
      key="app-home"
      screenOptions={{
        headerShown: false,
        animation: "fade",
        contentStyle: { backgroundColor: tabTheme.bg },
      }}
      initialRouteName="HomeTabs"
    >
      <AppStack.Screen name="HomeTabs" component={HomeTabs} />
      <AppStack.Screen name="UserProfile" component={UserProfile} />
      {/* Hidden route for Flappy ESC game */}
      <AppStack.Screen
        name="FlappyESC"
        component={FlappyEscScreen}
        options={{
          headerShown: false,
          animation: "slide_from_right",
        }}
      />
    </AppStack.Navigator>
  );
};

export default AppNavigator;
