// screens/OnboardingScreen.js
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  Animated,
  Easing,
  ActivityIndicator,
  Alert,
  ScrollView,
  Image,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import debounce from "lodash.debounce";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { AuthContext } from "../context/AuthProvider";
import { resetNavigation } from "../navigation/NavigationService";
import { api, upload as apiUpload } from "../utils/api";

const NEIGHBORHOOD_SUGGESTIONS = [
  "Rogers Park","Edgewater","Uptown","Lincoln Square","Lakeview",
  "Logan Square","Humboldt Park","Pilsen","Little Village",
  "South Shore","Hyde Park","Bronzeville","Bridgeport","Back of the Yards",
  "East Side","South Chicago","Hegewisch","Pullman","Roseland",
];

const OnboardingScreen = () => {
  const insets = useSafeAreaInsets();
  const { user, getAccessToken, refreshUser } = useContext(AuthContext);

  const [neighborhood, setNeighborhood] = useState(user?.neighborhood || "");
  const [skills, setSkills] = useState(user?.skills || "");
  const [languages, setLanguages] = useState(user?.languages || "");
  const [bio, setBio] = useState(user?.bio || "");
  const [age, setAge] = useState(user?.age ? String(user.age) : "");

  const [avatarUrl, setAvatarUrl] = useState(user?.avatar_url || null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [filtered, setFiltered] = useState(NEIGHBORHOOD_SUGGESTIONS);
  const doFilter = useMemo(
    () =>
      debounce((q) => {
        const text = (q || "").toLowerCase();
        if (!text) return setFiltered(NEIGHBORHOOD_SUGGESTIONS);
        setFiltered(
          NEIGHBORHOOD_SUGGESTIONS.filter((n) => n.toLowerCase().includes(text)).slice(0, 6)
        );
      }, 120),
    []
  );
  useEffect(() => {
    doFilter(neighborhood);
    return () => doFilter.cancel();
  }, [neighborhood, doFilter]);

  // animations
  const fade = useRef(new Animated.Value(0)).current;
  const float = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 500, useNativeDriver: true }).start();
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(float, { toValue: 1, duration: 2200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(float, { toValue: 0, duration: 2200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [fade, float]);
  const floatY = float.interpolate({ inputRange: [0, 1], outputRange: [0, -5] });

  const canSubmit = neighborhood.trim().length > 0 && !saving;

  // ------- Avatar helpers -------
  const ensureMediaPermission = async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission needed", "We need access to your photos to set your profile picture.");
        return false;
      }
      return true;
    } catch {
      Alert.alert("Error", "Could not request photo permissions.");
      return false;
    }
  };

  const ensureCameraPermission = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission needed", "We need access to your camera to take a profile picture.");
        return false;
      }
      return true;
    } catch {
      Alert.alert("Error", "Could not request camera permissions.");
      return false;
    }
  };

  const pickFromLibrary = async () => {
    const ok = await ensureMediaPermission();
    if (!ok) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
      base64: false,
      exif: false,
    });
    if (!res.canceled && res.assets?.length) {
      await uploadAvatar(res.assets[0]);
    }
  };

  const takePhoto = async () => {
    const ok = await ensureCameraPermission();
    if (!ok) return;
    const res = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
      base64: false,
      exif: false,
    });
    if (!res.canceled && res.assets?.length) {
      await uploadAvatar(res.assets[0]);
    }
  };

  const refreshUserSafe = async () => {
    try {
      if (typeof refreshUser === "function") {
        await refreshUser();
      } else {
        await api.get("/me/");
      }
    } catch {}
  };

  const uploadAvatar = async (asset) => {
    try {
      setAvatarUploading(true);
      const token = await getAccessToken();
      if (!token) throw new Error("Not authenticated");

      const uri = asset.uri || asset.localUri;
      if (!uri) throw new Error("Missing file URI");

      const guessedName = asset.fileName || (uri.split("/").pop() || `avatar_${Date.now()}.jpg`);
      const type =
        asset.mimeType ||
        asset.type || // some SDKs put it here
        (guessedName.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");

      const form = new FormData();
      form.append("avatar", { uri, name: guessedName, type });

      try {
        const data = await apiUpload("/profile/avatar/", form, { timeout: 45000 });
        setAvatarUrl(data?.avatar_url || null);
      } catch (e1) {
        if (e1?.status === 404) {
          const data2 = await apiUpload("/users/me/avatar/", form, { timeout: 45000 });
          setAvatarUrl(data2?.avatar_url || null);
        } else {
          throw e1;
        }
      }

      await refreshUserSafe();
    } catch (e) {
      const status = e?.status;
      if (status === 413) {
        Alert.alert("Image too large", "Please choose a smaller photo and try again.");
      } else if (status === 415) {
        Alert.alert("Unsupported file", "Please choose a JPG or PNG image.");
      } else if (e?.message === "Not authenticated") {
        Alert.alert("Not signed in", "Please log in again and retry.");
      } else {
        console.log("Avatar upload failed:", e?.data || e?.message || e);
        Alert.alert("Upload failed", "We couldn’t upload your photo. Try another image.");
      }
    } finally {
      setAvatarUploading(false);
    }
  };

  const removeAvatar = async () => {
    try {
      setAvatarUploading(true);
      try {
        await api.del("/profile/avatar/");
      } catch (e1) {
        if (e1?.status === 404) {
          await api.del("/users/me/avatar/");
        } else {
          throw e1;
        }
      }
      setAvatarUrl(null);
      await refreshUserSafe();
    } catch (e) {
      console.log("Avatar delete failed:", e?.data || e?.message || e);
      Alert.alert("Remove failed", "We couldn’t remove your photo right now.");
    } finally {
      setAvatarUploading(false);
    }
  };

  // ------- Submit -------
  const submit = useCallback(async () => {
    if (!canSubmit) {
      Alert.alert("One more step", "Please tell us your neighborhood to personalize your experience.");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        neighborhood: neighborhood.trim(),
        skills: skills.trim(),
        languages: languages.trim(),
        bio: bio.trim(),
        age: age ? Number(age) : null,
        onboarding_completed: true,
      };

      await api.patch("/me/update/", { body: payload });
      await refreshUserSafe();
      resetNavigation("HomeTabs");
    } catch (e) {
      console.log("Onboarding save failed:", e?.data || e?.message || e);
      Alert.alert("Save failed", "Couldn’t finish onboarding. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [neighborhood, skills, languages, bio, age, canSubmit]);

  const skipForNow = () => {
    resetNavigation("HomeTabs");
  };

  return (
    <SafeAreaView style={[styles.safe, { paddingTop: Math.max(insets.top, 10) }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
        keyboardVerticalOffset={insets.top}
      >
        <View style={styles.bg}>
          <View style={[styles.accent, styles.accentTop]} />
          <View style={[styles.accent, styles.accentBottom]} />
        </View>

        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 22, paddingBottom: 44 }}
          keyboardShouldPersistTaps="handled"
        >
          <Animated.View style={[styles.card, { opacity: fade, transform: [{ translateY: floatY }] }]}>
            <Text style={styles.title}>Let’s localize your experience</Text>
            <Text style={styles.subtitle}>
              We ask for your neighborhood so we can show nearby services, match you with local talent, and
              add new neighborhoods when we see demand. Skills & languages help neighbors discover you. Bio/age
              are optional—share if it helps others understand your work.
            </Text>

            {/* Avatar */}
            <Text style={[styles.sectionTitle, { marginTop: 10, textAlign: "center" }]}>Profile photo</Text>
            <Text style={[styles.smallNote, { textAlign: "center" }]}>
              A clear photo builds trust. You can skip this and add one later.
            </Text>

            <View style={styles.avatarBlock}>
              <View style={styles.avatarPreviewWrap}>
                {avatarUrl ? (
                  <Image source={{ uri: avatarUrl }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatar, styles.avatarPlaceholder]}>
                    <Text style={{ color: "#777" }}>No photo</Text>
                  </View>
                )}
              </View>

              <View style={styles.avatarCtas}>
                <Pressable
                  onPress={pickFromLibrary}
                  disabled={avatarUploading}
                  style={[styles.btnSm, avatarUploading && styles.btnDisabled]}
                >
                  <Text style={styles.btnSmText}>{avatarUploading ? "Uploading…" : "Choose from library"}</Text>
                </Pressable>
                <Pressable
                  onPress={takePhoto}
                  disabled={avatarUploading}
                  style={[styles.btnSmOutline, avatarUploading && styles.btnDisabled]}
                >
                  <Text style={styles.btnSmOutlineText}>Take a photo</Text>
                </Pressable>
                {avatarUrl ? (
                  <Pressable
                    onPress={removeAvatar}
                    disabled={avatarUploading}
                    style={[styles.btnSmGhost, avatarUploading && styles.btnDisabled]}
                  >
                    <Text style={styles.btnSmGhostText}>Remove photo</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>

            {/* Neighborhood */}
            <Text style={[styles.label, { marginTop: 16 }]}>Neighborhood *</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g., East Side"
              placeholderTextColor="#9a9aa1"
              value={neighborhood}
              onChangeText={setNeighborhood}
              autoCapitalize="words"
            />

            {!!filtered.length && (
              <View style={styles.suggestions}>
                {filtered.map((n) => (
                  <Pressable key={n} onPress={() => setNeighborhood(n)} style={styles.suggestion}>
                    <Text style={styles.suggestionText}>{n}</Text>
                  </Pressable>
                ))}
              </View>
            )}

            {/* Skills */}
            <Text style={[styles.label, { marginTop: 14 }]}>Skills (comma-separated)</Text>
            <TextInput
              style={styles.input}
              placeholder="Haircuts, Fades, Lawn care, Painting"
              placeholderTextColor="#9a9aa1"
              value={skills}
              onChangeText={setSkills}
              autoCapitalize="sentences"
            />

            {/* Languages */}
            <Text style={[styles.label, { marginTop: 14 }]}>Languages</Text>
            <TextInput
              style={styles.input}
              placeholder="English, Spanish"
              placeholderTextColor="#9a9aa1"
              value={languages}
              onChangeText={setLanguages}
              autoCapitalize="sentences"
            />

            {/* Bio */}
            <Text style={[styles.label, { marginTop: 14 }]}>Short bio (optional)</Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              placeholder="Tell neighbors a little about you…"
              placeholderTextColor="#9a9aa1"
              value={bio}
              onChangeText={setBio}
              multiline
            />

            {/* Age (optional) */}
            <Text style={[styles.label, { marginTop: 14 }]}>Age (optional)</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g., 28"
              placeholderTextColor="#9a9aa1"
              value={age}
              onChangeText={(t) => setAge(t.replace(/[^0-9]/g, ""))}
              keyboardType="number-pad"
              maxLength={3}
            />

            {/* CTAs */}
            <Pressable
              onPress={submit}
              disabled={!canSubmit || saving}
              style={[styles.btn, (!canSubmit || saving) && styles.btnDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Finish onboarding"
            >
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Finish</Text>}
            </Pressable>

            <Pressable onPress={skipForNow} style={styles.skip}>
              <Text style={styles.skipText}>Skip for now</Text>
            </Pressable>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const AVATAR_SIZE = 128;

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
  accentTop: { top: -90, right: -70, backgroundColor: "#FFD700" },
  accentBottom: { bottom: -110, left: -80, backgroundColor: "#FF4500" },

  card: {
    backgroundColor: "#151519",
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: "#26262c",
  },

  title: { fontSize: 22, fontWeight: "800", color: "#FFD700" },
  subtitle: { marginTop: 8, color: "#cfcfcf", fontSize: 14, lineHeight: 20 },

  sectionTitle: { color: "#e1e1e6", fontSize: 14, fontWeight: "800", marginTop: 8 },
  smallNote: { color: "#a8a8b3", fontSize: 12, marginTop: 2 },

  avatarBlock: { alignItems: "center", marginTop: 12, marginBottom: 4 },
  avatarPreviewWrap: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#2a2a2e",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1b1b1f",
  },
  avatar: { width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: AVATAR_SIZE / 2, resizeMode: "cover" },
  avatarPlaceholder: { alignItems: "center", justifyContent: "center" },
  avatarCtas: { width: "100%", maxWidth: 420, marginTop: 12, gap: 8 },

  btnSm: {
    backgroundColor: "#FF4500",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  btnSmText: { color: "#fff", fontWeight: "800" },

  btnSmOutline: {
    borderWidth: 1.5,
    borderColor: "#2c2c30",
    backgroundColor: "#151519",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  btnSmOutlineText: { color: "#eaeaea", fontWeight: "800" },

  btnSmGhost: {
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  btnSmGhostText: { color: "#b5b5be", fontWeight: "700" },

  label: { color: "#e1e1e6", fontSize: 12, marginTop: 10, marginBottom: 6, opacity: 0.85, paddingLeft: 4 },
  input: {
    width: "100%",
    backgroundColor: "#1b1b1f",
    color: "#fff",
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderColor: "#2a2a2e",
    borderWidth: 1,
  },
  multiline: { minHeight: 90, textAlignVertical: "top" },

  suggestions: {
    marginTop: 6,
    borderRadius: 10,
    backgroundColor: "#131318",
    borderWidth: 1,
    borderColor: "#2a2a2e",
  },
  suggestion: { paddingVertical: 8, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: "#1e1e24" },
  suggestionText: { color: "#ddd", fontSize: 13 },

  btn: {
    marginTop: 18,
    backgroundColor: "#FF4500",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#FF4500",
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: "#fff", fontSize: 16, fontWeight: "800", letterSpacing: 0.3 },

  skip: { marginTop: 10, alignItems: "center" },
  skipText: { color: "#a6a6ad", textDecorationLine: "underline" },
});

export default OnboardingScreen;
