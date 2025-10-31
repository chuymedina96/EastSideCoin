// App.js
import 'react-native-gesture-handler';
import React from 'react';
import { StatusBar } from 'react-native';
import { NavigationContainer, DarkTheme as RNDarkTheme } from '@react-navigation/native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import AuthProvider from './src/context/AuthProvider';
import AppNavigator from './src/navigation/AppNavigator';
import { navigationRef, onNavReady } from './src/navigation/NavigationService';

// Optional: align RN Navigation theme with your app colors
const DarkTheme = {
  ...RNDarkTheme,
  colors: {
    ...RNDarkTheme.colors,
    background: '#101012',
    card: '#1b1b1f',
    text: '#EEE',
    border: '#2a2a2e',
    primary: '#FF4500',
  },
};

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <StatusBar barStyle="light-content" />
          <NavigationContainer
            ref={navigationRef}
            theme={DarkTheme}
            onReady={onNavReady}
          >
            <AppNavigator />
          </NavigationContainer>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
