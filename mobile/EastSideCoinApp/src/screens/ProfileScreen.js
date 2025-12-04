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
  Image,
  Platform,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AuthContext } from "../context/AuthProvider";
import { walletBalance, fetchUserPublicKey, fetchMe } from "../utils/api";
import { API_URL } from "../config";
import avatarPlaceholder from "../../assets/avatar-placeholder.png"; // root-level assets

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

// Demo mode flags (mirrors WalletScreen)
const DEMO_MODE = true;
const DEMO_LEDGER_KEY = "esc_demo_ledger_v1";

// ---- Demo ledger helpers ----
async function getDemoLedger() {
  try {
    const raw = await AsyncStorage.getItem(DEMO_LEDGER_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    console.warn("Profile demo ledger load error:", e?.message || e);
    return {};
  }
}

async function saveDemoLedger(ledger) {
  try {
    await AsyncStorage.setItem(DEMO_LEDGER_KEY, JSON.stringify(ledger || {}));
  } catch (e) {
    console.warn("Profile demo ledger save error:", e?.message || e);
  }
}

// Helper: absolute URL + cache-bust
function resolveAvatarUri(me, fallback) {
  const raw = me?.avatar_url || fallback || "";
  if (!raw) return null;

  const lower = raw.toLowerCase();
  const isAbsolute =
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("data:") ||
    lower.startsWith("file:") ||
    lower.startsWith("content:");

  const base = isAbsolute ? raw : `${API_URL.replace(/\/+$/, "")}/${raw.replace(/^\/+/, "")}`;

  const ts = me?.avatar_updated_at || me?.updated_at || me?.profile_updated_at || Date.now();
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}t=${encodeURIComponent(String(ts))}`;
}

const trimAddr = (a, len = 10) =>
  a?.length > 2 * len ? `${a.slice(0, len)}…${a.slice(-len)}` : a || "";

const ProfileScreen = () => {
  const { user: authUser, logoutUser, deleteAccountAndLogout, accessToken } = useContext(AuthContext);

  // server-fresh profile (from /me/)
  const [me, setMe] = useState(null);

  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const [balance, setBalance] = useState(null);
  const [address, setAddress] = useState(authUser?.wallet_address || "");
  const [refreshing, setRefreshing] = useState(false);
  const [loadingBalance, setLoadingBalance] = useState(true);

  // FIXED: missing earlier
  const [showFullAddr, setShowFullAddr] = useState(false);

  // key status
  const [keysReady, setKeysReady] = useState(Boolean(authUser?.public_key));

  const [qrOpen, setQrOpen] = useState(false);

  // avatar handling
  const [avatarError, setAvatarError] = useState(false);
  const [avatarBust, setAvatarBust] = useState(0);

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

  // --------- data loaders ----------
  const loadMe = useCallback(async () => {
    try {
      const data = await fetchMe();
      
      setMe(data);

      if (data?.wallet_address && data.wallet_address !== address) {
        setAddress(data.wallet_address);
      }

      if (typeof data?.public_key !== "undefined") {
        setKeysReady(Boolean(data.public_key));
      }

      setAvatarError(false);
      setAvatarBust((b) => b + 1);
    } catch (e) {
      console.warn("fetchMe error:", e?.data || e?.message || e);
    }
  }, [address]);

  const loadBalance = useCallback(async () => {
    try {
      setLoadingBalance(true);
      const data = await walletBalance();

      let addr = data?.address || data?.wallet_address || "";
      if (!addr && DEMO_MODE) addr = "esc_demo_wallet_local";
      if (!addr) {
        setAddress("");
        setBalance(0);
        return;
      }

      let balNum = Number(data?.balance);
      if (!Number.isFinite(balNum) || balNum < 0) balNum = 0;

      if (DEMO_MODE) {
        const ledger = await getDemoLedger();
        if (ledger[addr] == null) {
          const seed = balNum > 0 ? balNum : 100;
          ledger[addr] = seed;
          await saveDemoLedger(ledger);
          balNum = seed;
        } else {
          balNum = Number(ledger[addr]);
          if (!Number.isFinite(balNum) || balNum < 0) balNum = 0;
        }
      }

      setAddress(addr);
      setBalance(balNum);
    } catch (e) {
      console.warn("Balance fetch error:", e);
      if (DEMO_MODE) {
        const addr = address || "esc_demo_wallet_local";
        try {
          const ledger = await getDemoLedger();
          let b = Number(ledger[addr]);
          if (!Number.isFinite(b) || b < 0) b = 100;
          setAddress(addr);
          setBalance(b);
        } catch {
          setBalance((prev) => (prev == null ? 100 : prev));
        }
      } else {
        setBalance((prev) => (prev == null ? 0 : prev));
      }
    } finally {
      setLoadingBalance(false);
    }
  }, [address]);

  const refreshKeyStatus = useCallback(async () => {
    const id = me?.id || authUser?.id;
    if (!id) return;
    try {
      const data = await fetchUserPublicKey(id);
      setKeysReady(Boolean(data?.public_key));
    } catch {
      setKeysReady((prev) => prev || Boolean(me?.public_key || authUser?.public_key));
    }
  }, [me?.id, me?.public_key, authUser?.id, authUser?.public_key]);

  useEffect(() => {
    loadMe();
    loadBalance();
    refreshKeyStatus();
  }, [loadMe, loadBalance, refreshKeyStatus]);

  useFocusEffect(
    useCallback(() => {
      loadMe();
      refreshKeyStatus();
    }, [loadMe, refreshKeyStatus])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadMe(), loadBalance(), refreshKeyStatus()]);
    setRefreshing(false);
  }, [loadMe, loadBalance, refreshKeyStatus]);

  // -------- computed values --------
  const profile = me || authUser || {};

  const displayName = useMemo(() => {
    const name = [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim();
    return name || profile.email || "";
  }, [profile]);

  const initials = useMemo(() => {
    const parts = displayName.split(" ").filter(Boolean);
    if (parts.length === 0 && profile?.email) return profile.email.slice(0, 2).toUpperCase();
    return (parts[0]?.[0] || "").toUpperCase() + (parts[1]?.[0] || "").toUpperCase();
  }, [displayName, profile?.email]);

  const avatarUriBase = resolveAvatarUri(me, authUser?.avatar_url);
  const avatarUri = avatarUriBase
    ? `${avatarUriBase}${avatarUriBase.includes("?") ? "&" : "?"}b=${avatarBust}`
    : null;

  const imageHeaders = useMemo(() => {
    if (!accessToken) return undefined;
    return { Authorization: `Bearer ${accessToken}` };
  }, [accessToken]);

  // -------- actions --------
  const handleCopy = async () => {
    if (!address) return;
    try {
      await Clipboard.setStringAsync(address);
      Alert.alert("Copied", "Wallet address copied to clipboard.");
    } catch {}
  };

  const handleShare = async () => {
    if (!address) return;
    try {
      await Share.share({ message: `My ESC address: ${address}` });
    } catch {}
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

  const reloadAvatar = () => {
    setAvatarError(false);
    setAvatarBust((b) => b + 1);
  };

  const onAvatarError = () => setAvatarError(true);

  return (
    <SafeAreaView style={styles.safe}>
      {/* animated accents */}
      <Animated.View style={[styles.accent, styles.accentTop, { transform: [{ translateY: floatY }] }]} />
      <Animated.View style={[styles.accent, styles.accentBottom, { transform: [{ translateY: floatY }] }]} />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={THEME.accentGold} />}
        keyboardShouldPersistTaps="handled"
      >
        {/* Avatar */}
        <View style={styles.avatarSection}>
          <View style={styles.bigAvatarWrap}>
            {avatarUri && !avatarError ? (
              <Image
                key={avatarUri}
                source={{ uri: avatarUri, headers: imageHeaders }}
                style={styles.bigAvatarImg}
                resizeMode="cover"
                onError={onAvatarError}
                defaultSource={Platform.OS === "ios" ? avatarPlaceholder : undefined}
              />
            ) : (
              <View style={styles.bigAvatarFallback}>
                <Text style={styles.bigAvatarText}>{initials}</Text>
              </View>
            )}
          </View>

          <Text style={styles.nameCenter} numberOfLines={1}>
            {displayName || "Your Profile"}
          </Text>

          {!!profile?.email && (
            <Text style={styles.emailCenter} numberOfLines={1}>
              {profile.email}
            </Text>
          )}

          {/* badges */}
          <View style={[styles.badgesRow, { justifyContent: "center", marginTop: 10 }]}>
            <View style={[styles.badge, profile?.is_vip ? styles.badgeVip : styles.badgeDim]}>
              <Text style={[styles.badgeText, profile?.is_vip ? styles.badgeTextVip : null]}>
                {profile?.is_vip ? "VIP" : "Member"}
              </Text>
            </View>

            <View style={[styles.badge, keysReady ? styles.badgeOk : styles.badgeWarn]}>
              <Text style={styles.badgeText}>{keysReady ? "Keys: Set" : "Keys: Not Set"}</Text>
            </View>

            {profile?.onboarding_completed && (
              <View style={[styles.badge, styles.badgeOk]}>
                <Text style={styles.badgeText}>Onboarding: Done</Text>
              </View>
            )}
          </View>

          <TouchableOpacity onPress={reloadAvatar} style={[styles.ghostBtn, { marginTop: 12 }]}>
            <Text style={styles.ghostBtnText}>Reload Photo</Text>
          </TouchableOpacity>
        </View>

        {/* Profile */}
        <View style={styles.card}>
          <Text style={styles.cardHeader}>Profile</Text>

          {!!profile?.bio && (
            <>
              <Text style={styles.fieldLabel}>Bio</Text>
              <Text style={styles.fieldValue}>{profile.bio}</Text>
            </>
          )}

          <View style={styles.grid}>
            {!!profile?.neighborhood && (
              <View style={styles.gridItem}>
                <Text style={styles.fieldLabel}>Neighborhood</Text>
                <Text style={styles.fieldValue}>{profile.neighborhood}</Text>
              </View>
            )}
            {!!profile?.age && (
              <View style={styles.gridItem}>
                <Text style={styles.fieldLabel}>Age</Text>
                <Text style={styles.fieldValue}>{String(profile.age)}</Text>
              </View>
            )}
          </View>

          <View style={styles.grid}>
            {!!profile?.languages && (
              <View style={styles.gridItem}>
                <Text style={styles.fieldLabel}>Languages</Text>
                <Text style={styles.fieldValue}>{profile.languages}</Text>
              </View>
            )}
            {!!profile?.skills && (
              <View style={styles.gridItem}>
                <Text style={styles.fieldLabel}>Skills</Text>
                <Text style={styles.fieldValue}>{profile.skills}</Text>
              </View>
            )}
          </View>

          {!profile?.bio &&
          !profile?.neighborhood &&
          !profile?.languages &&
          !profile?.skills &&
          !profile?.age ? (
            <Text style={styles.subtle}>No profile details yet. Add your info in onboarding or profile edit.</Text>
          ) : null}
        </View>

        {/* Wallet */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardHeader}>Wallet</Text>
            <TouchableOpacity style={styles.smallBtn} onPress={onRefresh}>
              <Text style={styles.smallBtnText}>Refresh</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.balanceRow}>
            <Text style={styles.balanceNumber}>
              {loadingBalance
                ? "—"
                : (Number(balance) || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })}
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

          <Text style={styles.subtle}>Tip: Long-press the address to toggle full/short view.</Text>
        </View>

        {/* Account */}
        <View style={styles.card}>
          <Text style={styles.cardHeader}>Account</Text>

          <TouchableOpacity
            style={[styles.primaryBtn, anyBusy && styles.btnDisabled]}
            onPress={handleLogout}
            disabled={anyBusy}
          >
            {isLoggingOut ? <ActivityIndicator color="#FFF" /> : <Text style={styles.primaryBtnText}>Logout</Text>}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.dangerBtn, anyBusy && styles.btnDisabled]}
            onPress={handleDelete}
            disabled={anyBusy}
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

/* ================== STYLES ================== */
const BIG_AVATAR = 160;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: THEME.bg },
  scrollContent: { padding: 16, paddingBottom: 40 },

  accent: { position: "absolute", width: 340, height: 340, borderRadius: 999, opacity: 0.1, zIndex: -1 },
  accentTop: { top: -100, right: -70, backgroundColor: THEME.accentGold },
  accentBottom: { bottom: -120, left: -80, backgroundColor: THEME.accentOrange },

  avatarSection: {
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
    marginTop: 12,
  },
  bigAvatarWrap: {
    width: BIG_AVATAR,
    height: BIG_AVATAR,
    borderRadius: BIG_AVATAR / 2,
    overflow: "hidden",
    borderWidth: 3,
    borderColor: THEME.accentGold,
    backgroundColor: "#23242c",
    alignItems: "center",
    justifyContent: "center",
  },
  bigAvatarImg: {
    width: "100%",
    height: "100%",
  },
  bigAvatarFallback: {
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  bigAvatarText: { color: THEME.accentGold, fontWeight: "900", fontSize: 42, letterSpacing: 1 },

  nameCenter: { color: THEME.text, fontSize: 22, fontWeight: "900", marginTop: 12, textAlign: "center" },
  emailCenter: { color: THEME.subtext, textAlign: "center", marginTop: 4 },

  badgesRow: { flexDirection: "row", gap: 8, marginTop: 8, flexWrap: "wrap" },
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

  // cards
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

  // profile fields
  fieldLabel: { color: "#b7b7bf", fontSize: 12, marginTop: 10 },
  fieldValue: { color: THEME.text, fontSize: 14, marginTop: 4 },
  subtle: { color: THEME.subtle, fontSize: 12, marginTop: 10 },
  grid: { flexDirection: "row", gap: 12, marginTop: 6 },
  gridItem: { flex: 1 },

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
