import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { navigationRef } from "./src/navigation/NavigationService"; // ✅ Correct import path
import AuthProvider from "./src/context/AuthProvider";
import AppNavigator from "./src/navigation/AppNavigator";

export default function App() {
  return (
    <AuthProvider>
      <NavigationContainer ref={navigationRef}>
        <AppNavigator />
      </NavigationContainer>
    </AuthProvider>
  );
}
