// screens/ProfileScreen.js
import React, { useContext, useEffect, useMemo, useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  ScrollView,
  RefreshControl,
  Pressable,
  Modal,
  Animated,
  Easing,
  Share,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";
import { AuthContext } from "../context/AuthProvider";
import { API_URL } from "../config";
import { SafeAreaView } from "react-native-safe-area-context";

const THEME = {
  bg: "#101012",
  card: "#1b1b1f",
  border: "#2a2a2e",
  text: "#EEE",
  subtext: "#cfcfcf",
  subtle: "#9a9aa1",
  accentGold: "#FFD700",
  accentOrange: "#FF4500",
  danger: "#E63946",
  ok: "#2f8f46",
};

const trimAddr = (a, len = 10) =>
  a?.length > 2 * len ? `${a.slice(0, len)}…${a.slice(-len)}` : a || "";

const ProfileScreen = () => {
  const { user, logoutUser, deleteAccountAndLogout } = useContext(AuthContext);

  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const [balance, setBalance] = useState(null);
  const [address, setAddress] = useState(user?.wallet_address || "");
  const [refreshing, setRefreshing] = useState(false);
  const [loadingBalance, setLoadingBalance] = useState(true);
  const [showFullAddr, setShowFullAddr] = useState(false);

  const [qrOpen, setQrOpen] = useState(false);

  // subtle float accents
  const float = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(float, { toValue: 1, duration: 2500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(float, { toValue: 0, duration: 2500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    ).start();
  }, [float]);
  const floatY = float.interpolate({ inputRange: [0, 1], outputRange: [0, -3] });

  const displayName = useMemo(() => {
    if (!user) return "";
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
    return name || user.email || "";
  }, [user]);

  const initials = useMemo(() => {
    const parts = displayName.split(" ").filter(Boolean);
    if (parts.length === 0 && user?.email) return user.email.slice(0, 2).toUpperCase();
    return (parts[0]?.[0] || "").toUpperCase() + (parts[1]?.[0] || "").toUpperCase();
  }, [displayName, user?.email]);

  const withAuth = useCallback(async () => {
    const token = await AsyncStorage.getItem("authToken");
    return axios.create({
      baseURL: API_URL, // should include /api
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
  }, []);

  const loadBalance = useCallback(async () => {
    try {
      setLoadingBalance(true);
      const client = await withAuth();
      const { data } = await client.get("/wallet/balance/");
      setAddress(data?.address || user?.wallet_address || "");
      setBalance(typeof data?.balance === "number" ? data.balance : Number(data?.balance ?? 0));
    } catch (e) {
      console.warn("Balance fetch error:", e?.response?.data || e?.message || e);
      if (balance == null) setBalance(0);
    } finally {
      setLoadingBalance(false);
    }
  }, [withAuth, user?.wallet_address, balance]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadBalance();
    setRefreshing(false);
  }, [loadBalance]);

  useEffect(() => {
    loadBalance();
  }, [loadBalance]);

  const handleCopy = async () => {
    if (!address) return;
    try {
      await Clipboard.setStringAsync(address);
      Alert.alert("Copied", "Wallet address copied to clipboard.");
    } catch (e) {
      // noop
    }
  };

  const handleShare = async () => {
    if (!address) return;
    try {
      await Share.share({ message: `My ESC address: ${address}` });
    } catch {
      // noop
    }
  };

  const handleLogout = async () => {
    if (isLoggingOut || isDeleting) return;
    setIsLoggingOut(true);
    try {
      await logoutUser();
    } finally {
      setIsLoggingOut(false);
    }
  };

  const handleDelete = async () => {
    if (isLoggingOut || isDeleting) return;
    if (!deleteAccountAndLogout) {
      Alert.alert("Unavailable", "Delete account isn’t available in this build. Logging out instead.");
      return handleLogout();
    }
    Alert.alert(
      "Delete Account",
      "This will permanently remove your account and wipe keys on this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setIsDeleting(true);
            try {
              await deleteAccountAndLogout();
            } finally {
              setIsDeleting(false);
            }
          },
        },
      ]
    );
  };

  const anyBusy = isLoggingOut || isDeleting;

  return (
    <SafeAreaView style={styles.safe}>
      {/* accents */}
      <Animated.View style={[styles.accent, styles.accentTop, { transform: [{ translateY: floatY }] }]} />
      <Animated.View style={[styles.accent, styles.accentBottom, { transform: [{ translateY: floatY }] }]} />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={THEME.accentGold} />}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header / avatar */}
        <View style={styles.headerCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={styles.name} numberOfLines={1}>
              {displayName || "Your Profile"}
            </Text>
            {!!user?.email && (
              <Text style={styles.email} numberOfLines={1}>
                {user.email}
              </Text>
            )}
            <View style={styles.badgesRow}>
              <View style={[styles.badge, user?.is_vip ? styles.badgeVip : styles.badgeDim]}>
                <Text style={[styles.badgeText, user?.is_vip ? styles.badgeTextVip : null]}>
                  {user?.is_vip ? "VIP" : "Member"}
                </Text>
              </View>
              <View style={[styles.badge, user?.public_key ? styles.badgeOk : styles.badgeWarn]}>
                <Text style={styles.badgeText}>
                  {user?.public_key ? "Keys: Set" : "Keys: Not Set"}
                </Text>
              </View>
            </View>
          </View>
        </View>

        {/* Balance */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardHeader}>Wallet</Text>
            <TouchableOpacity style={styles.smallBtn} onPress={onRefresh}>
              <Text style={styles.smallBtnText}>Refresh</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.balanceRow}>
            <Text style={styles.balanceNumber}>
              {loadingBalance ? "—" : (Number(balance) || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })}
            </Text>
            <Text style={styles.balanceTicker}> ESC</Text>
          </View>

          <Text style={styles.addrLabel}>Address</Text>
          <Pressable onLongPress={() => setShowFullAddr((v) => !v)} hitSlop={8}>
            <Text selectable style={styles.addrValue}>
              {showFullAddr ? address : trimAddr(address, 10)}
            </Text>
          </Pressable>

          <View style={styles.row}>
            <TouchableOpacity onPress={handleCopy} style={[styles.ghostBtn, { marginRight: 8 }]}>
              <Text style={styles.ghostBtnText}>Copy</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleShare} style={[styles.ghostBtn, { marginRight: 8 }]}>
              <Text style={styles.ghostBtnText}>Share</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setQrOpen(true)} style={styles.ghostBtn}>
              <Text style={styles.ghostBtnText}>QR</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.subtle}>
            Tip: Long-press the address to toggle full/short view.
          </Text>
        </View>

        {/* Account actions */}
        <View style={styles.card}>
          <Text style={styles.cardHeader}>Account</Text>

          <TouchableOpacity
            style={[styles.primaryBtn, anyBusy && styles.btnDisabled]}
            onPress={handleLogout}
            disabled={anyBusy}
            accessibilityLabel="Log out"
          >
            {isLoggingOut ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <Text style={styles.primaryBtnText}>Logout</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.dangerBtn, anyBusy && styles.btnDisabled]}
            onPress={handleDelete}
            disabled={anyBusy}
            accessibilityLabel="Delete account"
          >
            {isDeleting ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <Text style={styles.primaryBtnText}>Delete Account</Text>
            )}
          </TouchableOpacity>

          <Text style={styles.disclaimer}>
            Deleting your account will remove your messages and wallet records from our servers. Keep a backup of any keys you own.
          </Text>
        </View>

        <Text style={styles.footer}>America/Chicago</Text>
      </ScrollView>

      {/* QR Modal */}
      <Modal visible={qrOpen} transparent animationType="fade" onRequestClose={() => setQrOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Your ESC Address</Text>
            <View style={{ backgroundColor: "#fff", padding: 12, borderRadius: 12, alignSelf: "center" }}>
              {!!address ? <QRCode size={200} value={address} quietZone={6} /> : null}
            </View>
            <Text style={[styles.modalText, { marginTop: 10 }]} selectable>
              {address}
            </Text>
            <View style={[styles.row, { marginTop: 14 }]}>
              <TouchableOpacity onPress={handleCopy} style={[styles.ghostBtn, { marginRight: 8 }]}>
                <Text style={styles.ghostBtnText}>Copy</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setQrOpen(false)} style={styles.primaryBtnSmall}>
                <Text style={styles.primaryBtnText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
};

export default ProfileScreen;

/* ======= styles ======= */
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: THEME.bg },
  scrollContent: { padding: 16, paddingBottom: 28 },

  // accents
  accent: {
    position: "absolute",
    width: 320,
    height: 320,
    borderRadius: 999,
    opacity: 0.10,
    zIndex: -1,
  },
  accentTop: { top: -80, right: -70, backgroundColor: THEME.accentGold },
  accentBottom: { bottom: -100, left: -80, backgroundColor: THEME.accentOrange },

  headerCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: THEME.card,
    borderColor: THEME.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 999,
    backgroundColor: "#23242c",
    borderWidth: 1,
    borderColor: THEME.border,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: THEME.accentGold, fontWeight: "900", fontSize: 22, letterSpacing: 1 },
  name: { color: THEME.text, fontSize: 20, fontWeight: "800" },
  email: { color: THEME.subtle, marginTop: 2 },

  badgesRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: "#1f2026",
    borderColor: THEME.border,
  },
  badgeVip: { borderColor: "#caa200", backgroundColor: "#2a2412" },
  badgeTextVip: { color: THEME.accentGold, fontWeight: "800" },
  badgeDim: {},
  badgeOk: { borderColor: THEME.ok, backgroundColor: "#15261a" },
  badgeWarn: { borderColor: "#7a4a00", backgroundColor: "#2a1e10" },
  badgeText: { color: THEME.subtext, fontSize: 12, fontWeight: "700" },

  card: {
    backgroundColor: THEME.card,
    borderColor: THEME.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    marginTop: 12,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
  },
  cardHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardHeader: { color: THEME.text, fontWeight: "800", fontSize: 16 },

  smallBtn: {
    backgroundColor: "#2d2d2f",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderColor: "#3a3a3f",
    borderWidth: 1,
  },
  smallBtnText: { color: THEME.accentGold, fontWeight: "700" },

  balanceRow: { flexDirection: "row", alignItems: "flex-end", marginTop: 10 },
  balanceNumber: { color: "#fff", fontSize: 34, fontWeight: "900" },
  balanceTicker: { color: THEME.accentGold, fontWeight: "800", marginLeft: 6, marginBottom: 3 },

  addrLabel: { color: "#b7b7bf", fontSize: 12, marginTop: 10 },
  addrValue: { color: THEME.text, fontSize: 13, marginTop: 2 },

  row: { flexDirection: "row", alignItems: "center", marginTop: 12 },

  ghostBtn: {
    backgroundColor: "#2d2d2f",
    borderColor: "#3a3a3f",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  ghostBtnText: { color: THEME.text, fontWeight: "800" },

  primaryBtn: {
    backgroundColor: THEME.accentOrange,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 14,
    shadowColor: THEME.accentOrange,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  primaryBtnSmall: {
    backgroundColor: THEME.accentOrange,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: "center",
  },
  primaryBtnText: { color: "#fff", fontSize: 16, fontWeight: "800", letterSpacing: 0.3 },
  btnDisabled: { opacity: 0.6 },

  dangerBtn: {
    backgroundColor: THEME.danger,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 12,
  },

  disclaimer: { color: THEME.subtle, fontSize: 12, marginTop: 10 },

  footer: { color: "#7a7a7a", textAlign: "center", marginTop: 14, fontSize: 12 },

  // modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  modalCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: THEME.card,
    borderColor: THEME.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
  },
  modalTitle: { color: THEME.text, fontSize: 16, fontWeight: "800", marginBottom: 12, textAlign: "center" },
  modalText: { color: THEME.subtext, textAlign: "center" },
});
