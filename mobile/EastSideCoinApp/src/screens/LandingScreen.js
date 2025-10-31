// screens/LandingScreen.js
import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  Image,
  Animated,
  Easing,
  Pressable,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { SafeAreaView } from "react-native-safe-area-context";

const LandingScreen = () => {
  const navigation = useNavigation();

  // Animations
  const fadeIn = useRef(new Animated.Value(0)).current;
  const logoFloat = useRef(new Animated.Value(0)).current;
  const glowScale = useRef(new Animated.Value(0)).current;
  const btnLoginScale = useRef(new Animated.Value(1)).current;
  const btnRegisterScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.timing(fadeIn, {
      toValue: 1,
      duration: 900,
      useNativeDriver: true,
      easing: Easing.out(Easing.cubic),
    }).start();

    Animated.loop(
      Animated.sequence([
        Animated.timing(logoFloat, {
          toValue: 1,
          duration: 2600,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.quad),
        }),
        Animated.timing(logoFloat, {
          toValue: 0,
          duration: 2600,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.quad),
        }),
      ])
    ).start();

    Animated.loop(
      Animated.sequence([
        Animated.timing(glowScale, {
          toValue: 1,
          duration: 1800,
          useNativeDriver: true,
          easing: Easing.out(Easing.quad),
        }),
        Animated.timing(glowScale, {
          toValue: 0,
          duration: 1800,
          useNativeDriver: true,
          easing: Easing.in(Easing.quad),
        }),
      ])
    ).start();
  }, [fadeIn, logoFloat, glowScale]);

  const floatTranslate = logoFloat.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -6],
  });

  const glowScaleVal = glowScale.interpolate({
    inputRange: [0, 1],
    outputRange: [0.95, 1.15],
  });

  const onPressIn = (anim) =>
    Animated.spring(anim, { toValue: 0.97, useNativeDriver: true }).start();
  const onPressOut = (anim) =>
    Animated.spring(anim, { toValue: 1, friction: 3, useNativeDriver: true }).start();

  return (
    <SafeAreaView style={styles.safe}>
      {/* background accents */}
      <View style={styles.bg}>
        <View style={[styles.accent, styles.accentTop]} />
        <View style={[styles.accent, styles.accentBottom]} />
      </View>

      <Animated.View style={[styles.container, { opacity: fadeIn }]}>
        {/* Logo with pulse */}
        <View style={styles.heroWrap}>
          <Animated.View
            style={[
              styles.glow,
              { transform: [{ scale: glowScaleVal }], opacity: 0.35 },
            ]}
          />
          <Animated.Image
            source={require("../../assets/Eastside Coin.webp")}
            style={[styles.logo, { transform: [{ translateY: floatTranslate }] }]}
          />
        </View>

        <Text style={styles.title}>EastSide Coin</Text>
        <Text style={styles.subtitle}>
          A neighborhood economy for real people — earn, spend, and rise together.
        </Text>

        {/* Feature chips */}
        <View style={styles.chipsRow}>
          <View style={styles.chip}><Text style={styles.chipText}>Shop Local</Text></View>
          <View style={styles.chip}><Text style={styles.chipText}>Support Creators</Text></View>
          <View style={styles.chip}><Text style={styles.chipText}>Trade Skills</Text></View>
          <View style={styles.chip}><Text style={styles.chipText}>Build Credit Together</Text></View>
        </View>

        {/* CTA buttons */}
        <Animated.View style={[styles.button, { transform: [{ scale: btnLoginScale }] }]}>
          <Pressable
            onPressIn={() => onPressIn(btnLoginScale)}
            onPressOut={() => onPressOut(btnLoginScale)}
            onPress={() => navigation.navigate("Login")}
            style={styles.pressable}
          >
            <Text style={styles.buttonText}>Log In</Text>
          </Pressable>
        </Animated.View>

        <Animated.View
          style={[styles.buttonOutline, { transform: [{ scale: btnRegisterScale }] }]}
        >
          <Pressable
            onPressIn={() => onPressIn(btnRegisterScale)}
            onPressOut={() => onPressOut(btnRegisterScale)}
            onPress={() => navigation.navigate("Register")}
            style={styles.pressable}
          >
            <Text style={styles.buttonOutlineText}>Join the Movement</Text>
          </Pressable>
        </Animated.View>

        <Text style={styles.footer}>
          By continuing, you agree to our{" "}
          <Text style={styles.footerLink}>Terms</Text> &{" "}
          <Text style={styles.footerLink}>Privacy</Text>.
        </Text>
      </Animated.View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#101012" },
  bg: { ...StyleSheet.absoluteFillObject, zIndex: -1 },
  accent: {
    position: "absolute",
    width: 320,
    height: 320,
    borderRadius: 999,
    opacity: 0.18,
    transform: [{ rotate: "15deg" }],
  },
  accentTop: {
    top: -90,
    right: -70,
    backgroundColor: "#FFD700",
  },
  accentBottom: {
    bottom: -110,
    left: -80,
    backgroundColor: "#FF4500",
  },
  container: {
    flex: 1,
    paddingHorizontal: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  heroWrap: {
    width: 160,
    height: 160,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 18,
  },
  glow: {
    position: "absolute",
    width: 160,
    height: 160,
    borderRadius: 999,
    backgroundColor: "#FFD700",
  },
  logo: { width: 130, height: 130, resizeMode: "contain" },
  title: {
    fontSize: 32,
    fontWeight: "800",
    color: "#FFD700",
    letterSpacing: 0.5,
    textAlign: "center",
  },
  subtitle: {
    marginTop: 8,
    color: "#cfcfcf",
    fontSize: 14.5,
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: 8,
  },
  chipsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
    marginTop: 16,
    marginBottom: 22,
  },
  chip: {
    backgroundColor: "#1b1b1f",
    borderColor: "#2a2a2e",
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
  },
  chipText: { color: "#e9e9ea", fontSize: 13, fontWeight: "700" },
  pressable: { width: "100%", alignItems: "center", justifyContent: "center" },
  button: {
    width: "100%",
    backgroundColor: "#FF4500",
    borderRadius: 12,
    paddingVertical: 14,
    shadowColor: "#FF4500",
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
  },
  buttonText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  buttonOutline: {
    width: "100%",
    borderRadius: 12,
    paddingVertical: 14,
    borderWidth: 1.5,
    borderColor: "#2c2c30",
    backgroundColor: "#151519",
    marginTop: 12,
  },
  buttonOutlineText: {
    color: "#eaeaea",
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  footer: {
    color: "#7d7d85",
    fontSize: 12,
    marginTop: 18,
    textAlign: "center",
  },
  footerLink: { color: "#cfcfcf", textDecorationLine: "underline" },
});

export default LandingScreen;
