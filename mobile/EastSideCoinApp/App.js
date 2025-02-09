import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { setNavigator } from "./src/navigation/NavigationService";
import AuthProvider from "./src/context/AuthProvider";
import AppNavigator from "./src/navigation/AppNavigator";

export default function App() {
  return (
    <NavigationContainer ref={(ref) => setNavigator(ref)}>
      <AuthProvider>
        <AppNavigator />
      </AuthProvider>
    </NavigationContainer>
  );
}
