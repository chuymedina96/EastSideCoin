import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { navigationRef } from "./src/navigation/NavigationService";
import AuthProvider from "./src/context/AuthProvider";
import AppNavigator from "./src/navigation/AppNavigator";

export default function App() {
  return (
    <NavigationContainer ref={navigationRef}>
      <AuthProvider>
        <AppNavigator />
      </AuthProvider>
    </NavigationContainer>
  );
}
