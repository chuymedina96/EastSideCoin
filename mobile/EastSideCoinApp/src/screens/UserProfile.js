// screens/UserProfile.js
import React, { useEffect, useMemo, useState, useContext } from "react";
import {
  View,
  Text,
  StyleSheet,
  Image,
  ActivityIndicator,
  ScrollView,
  Alert,
  Platform,
  TouchableOpacity,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../utils/api";
import { API_URL } from "../config";
import avatarPlaceholder from "../../assets/avatar-placeholder.png";
import { AuthContext } from "../context/AuthProvider";

const THEME = {
  bg: "#101012",
  card: "#1b1b1f",
  border: "#2a2a2e",
  text: "#EEE",
  subtext: "#cfcfcf",
  gold: "#FFD700",
  muted: "#888",
};

/** Try a lot of common keys and nested shapes returned by different APIs */
function pickAvatarRaw(u) {
  if (!u) return null;
  const cands = [
    u.avatar_url,
    u.avatar,
    u.photo_url,
    u.image_url,
    u.picture,
    u.photo,
    u.profile?.avatar_url,
    u.profile?.avatar,
    u.media?.avatar,
    u.media?.avatar_url,
  ].filter(Boolean);
  return cands.length ? cands[0] : null;
}

/** Make absolute URL, add cache-bust ts */
function resolveAvatarUri(user, token) {
  const raw = pickAvatarRaw(user);
  if (!raw) return null;

  const isAbs = /^https?:|^data:|^file:|^content:/i.test(String(raw));
  const base = isAbs
    ? String(raw)
    : `${API_URL.replace(/\/+$/, "")}/${String(raw).replace(/^\/+/, "")}`;

  const ts = user?.avatar_updated_at || user?.updated_at || Date.now();
  const sep = base.includes("?") ? "&" : "?";
  const includeToken = false; // flip to true only if your backend supports ?token=
  const tokenPart = includeToken && token ? `&token=${encodeURIComponent(token)}` : "";
  return `${base}${sep}t=${encodeURIComponent(String(ts))}${tokenPart}`;
}

export default function UserProfile({ route, navigation }) {
  const { accessToken } = useContext(AuthContext);
  const { userId } = route?.params || {};

  const [data, setData] = useState(null);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);

  const headers = useMemo(
    () => (accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined),
    [accessToken]
  );

  useEffect(() => {
    (async () => {
      if (!userId) {
        Alert.alert("Error", "Missing user id for profile.");
        setLoading(false);
        return;
      }

      try {
        console.log("🔎 Loading profile for userId:", userId);
        const profile = await api.get(`/users/${userId}/`);
        console.log("✅ Profile loaded:", profile);

        // Load services and filter client-side by owner
        let svcResults = [];
        try {
          const svc = await api.get(`/services/?limit=100&page=1`);
          svcResults = Array.isArray(svc?.results) ? svc.results : [];
        } catch (svcErr) {
          console.log("⚠️ Error loading services for profile", svcErr);
        }

        const userServices = svcResults.filter(
          (s) => s?.user?.id === userId || s?.user?.id === Number(userId)
        );

        setData(profile);
        setServices(userServices);
      } catch (e) {
        console.log("❌ Error loading profile", e);
        Alert.alert("Error", "Could not load profile.");
      } finally {
        setLoading(false);
      }
    })();
  }, [userId]);

  if (loading) {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: THEME.bg, alignItems: "center", justifyContent: "center" }}
      >
        <ActivityIndicator color={THEME.gold} />
      </SafeAreaView>
    );
  }

  if (!data) {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: THEME.bg, alignItems: "center", justifyContent: "center" }}
      >
        <Text style={{ color: THEME.text }}>Profile not found.</Text>
      </SafeAreaView>
    );
  }

  const avatarUri = resolveAvatarUri(data, accessToken);
  const fullName =
    [data?.first_name, data?.last_name].filter(Boolean).join(" ") || data?.email || "Neighbor";

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: THEME.bg }}>
      <View style={styles.headerRow}>
        <TouchableOpacity
          onPress={() => {
            if (navigation.canGoBack()) navigation.goBack();
            else navigation.navigate("ServicesScreen"); // fallback if you have a services screen route
          }}
          style={styles.backBtn}
        >
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text numberOfLines={1} style={styles.headerTitle}>
          Neighbor
        </Text>
        <View style={{ width: 60 }} />{/* spacer to balance flex */}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
        {/* Avatar + Name + Bio */}
        <View style={[styles.card, { alignItems: "center" }]}>
          <View style={styles.avatarWrap}>
            {avatarUri ? (
              <Image
                key={avatarUri}
                source={{ uri: avatarUri, headers }}
                style={styles.avatar}
                resizeMode="cover"
                defaultSource={Platform.OS === "ios" ? avatarPlaceholder : undefined}
                onError={() => {
                  /* swallow errors */
                }}
              />
            ) : (
              <Image source={avatarPlaceholder} style={styles.avatar} resizeMode="cover" />
            )}
          </View>

          <Text style={styles.name}>{fullName}</Text>

          {!!data?.neighborhood && (
            <Text style={styles.subline}>{data.neighborhood}</Text>
          )}

          {/* Ratings placeholder */}
          <View style={styles.ratingRow}>
            <Text style={styles.stars}>★ ★ ★ ★ ★</Text>
            <Text style={styles.ratingText}>
              Neighbor ratings coming soon
            </Text>
          </View>

          {!!data?.bio && <Text style={styles.bio}>{data.bio}</Text>}
        </View>

        {/* Details */}
        <View style={styles.card}>
          <Text style={styles.h}>Details</Text>
          {!!data?.skills && (
            <Text style={styles.kv}>
              Skills: <Text style={styles.v}>{data.skills}</Text>
            </Text>
          )}
          {!!data?.languages && (
            <Text style={styles.kv}>
              Languages: <Text style={styles.v}>{data.languages}</Text>
            </Text>
          )}
          {!!data?.wallet_address && (
            <Text style={styles.kv}>
              Wallet:{" "}
              <Text style={styles.v}>
                {String(data.wallet_address).slice(0, 6)}…
                {String(data.wallet_address).slice(-4)}
              </Text>
            </Text>
          )}
        </View>

        {/* Services offered by this neighbor */}
        <View style={styles.card}>
          <Text style={styles.h}>Services</Text>
          {services.length === 0 ? (
            <Text style={styles.emptyText}>
              This neighbor hasn’t listed any services yet.
            </Text>
          ) : (
            services.map((svc) => (
              <View key={svc.id} style={styles.serviceRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.serviceTitle}>{svc.title}</Text>
                  {!!svc.category && (
                    <Text style={styles.serviceMeta}>{svc.category}</Text>
                  )}
                  {!!svc.description && (
                    <Text style={styles.serviceDesc} numberOfLines={2}>
                      {svc.description}
                    </Text>
                  )}
                </View>
                <View style={styles.servicePricePill}>
                  <Text style={styles.servicePriceText}>
                    {Number(svc.price).toFixed(2)} ESC
                  </Text>
                </View>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
    backgroundColor: THEME.bg,
  },
  backBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: THEME.border,
  },
  backBtnText: {
    color: THEME.text,
    fontSize: 14,
  },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    color: THEME.subtext,
    fontWeight: "700",
    fontSize: 14,
  },

  card: {
    backgroundColor: THEME.card,
    borderColor: THEME.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginTop: 12,
  },

  avatarWrap: {
    width: 120,
    height: 120,
    borderRadius: 60,
    overflow: "hidden",
    borderWidth: 3,
    borderColor: THEME.gold,
  },
  avatar: { width: "100%", height: "100%" },

  name: {
    color: THEME.text,
    fontWeight: "900",
    fontSize: 20,
    marginTop: 10,
    textAlign: "center",
  },
  subline: {
    color: THEME.subtext,
    marginTop: 4,
    fontSize: 13,
    textAlign: "center",
  },
  ratingRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
  },
  stars: {
    color: THEME.gold,
    fontWeight: "900",
    marginRight: 8,
    fontSize: 14,
  },
  ratingText: {
    color: THEME.subtext,
    fontSize: 12,
  },
  bio: {
    color: THEME.subtext,
    marginTop: 10,
    textAlign: "center",
    fontSize: 14,
  },

  h: {
    color: THEME.text,
    fontWeight: "900",
    marginBottom: 8,
    fontSize: 15,
  },
  kv: {
    color: THEME.subtext,
    marginTop: 4,
    fontSize: 13,
  },
  v: {
    color: THEME.text,
    fontWeight: "800",
  },

  emptyText: {
    color: THEME.muted,
    fontSize: 13,
  },

  serviceRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#25252a",
  },
  serviceTitle: {
    color: THEME.text,
    fontWeight: "700",
    fontSize: 14,
  },
  serviceMeta: {
    color: THEME.subtext,
    fontSize: 12,
    marginTop: 2,
  },
  serviceDesc: {
    color: THEME.subtext,
    fontSize: 12,
    marginTop: 4,
  },
  servicePricePill: {
    marginLeft: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: THEME.gold,
    alignSelf: "center",
  },
  servicePriceText: {
    color: THEME.gold,
    fontWeight: "800",
    fontSize: 12,
  },
});
