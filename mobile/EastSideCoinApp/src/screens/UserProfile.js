// screens/UserProfile.js
import React, { useEffect, useMemo, useState, useContext } from "react";
import { View, Text, StyleSheet, Image, ActivityIndicator, ScrollView, Alert, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../utils/api";
import { API_URL } from "../config";
import avatarPlaceholder from "../../assets/avatar-placeholder.png";
import { AuthContext } from "../context/AuthProvider";

const THEME = { bg: "#101012", card: "#1b1b1f", border: "#2a2a2e", text: "#EEE", subtext: "#cfcfcf", gold: "#FFD700" };

/** Try a lot of common keys and nested shapes returned by different APIs */
function pickAvatarRaw(u) {
  if (!u) return null;
  const cands = [
    u.avatar_url, u.avatar, u.photo_url, u.image_url, u.picture, u.photo,
    u.profile?.avatar_url, u.profile?.avatar, u.media?.avatar, u.media?.avatar_url,
  ].filter(Boolean);
  return cands.length ? cands[0] : null;
}

/** Make absolute URL, add cache-bust ts, optionally append token if headers aren’t honored by Image on some RN builds */
function resolveAvatarUri(user, token) {
  const raw = pickAvatarRaw(user);
  if (!raw) return null;

  const isAbs = /^https?:|^data:|^file:|^content:/i.test(String(raw));
  const base = isAbs ? String(raw) : `${API_URL.replace(/\/+$/, "")}/${String(raw).replace(/^\/+/, "")}`;

  const ts = user?.avatar_updated_at || user?.updated_at || Date.now();
  const sep = base.includes("?") ? "&" : "?";
  // If your media server does NOT accept token via query, set includeToken=false below
  const includeToken = false; // flip to true only if your backend supports ?token=
  const tokenPart = includeToken && token ? `&token=${encodeURIComponent(token)}` : "";
  return `${base}${sep}t=${encodeURIComponent(String(ts))}${tokenPart}`;
}

export default function UserProfile({ route, navigation }) {
  const { accessToken } = useContext(AuthContext);
  const { userId } = route?.params || {};

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const headers = useMemo(
    () => (accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined),
    [accessToken]
  );

  useEffect(() => {
    (async () => {
      try {
        // Try a couple of likely endpoints
        let res = null;
        try {
          res = await api.get(`/users/${userId}/`);
        } catch {
          try {
            res = await api.get(`/profiles/${userId}/`);
          } catch {
            res = await api.get(`/api/users/${userId}/`);
          }
        }
        setData(res);
      } catch (e) {
        Alert.alert("Error", "Could not load profile.");
      } finally {
        setLoading(false);
      }
    })();
  }, [userId]);

  if (loading) {
    return (
      <SafeAreaView style={{ flex:1, backgroundColor: THEME.bg, alignItems:"center", justifyContent:"center" }}>
        <ActivityIndicator color={THEME.gold} />
      </SafeAreaView>
    );
  }

  const avatarUri = resolveAvatarUri(data, accessToken);

  return (
    <SafeAreaView style={{ flex:1, backgroundColor: THEME.bg }}>
      <ScrollView contentContainerStyle={{ padding:16 }}>
        <View style={[styles.card, { alignItems:"center" }]}>
          <View style={styles.avatarWrap}>
            {avatarUri ? (
              <Image
                key={avatarUri}
                source={{ uri: avatarUri, headers }}
                style={styles.avatar}
                resizeMode="cover"
                defaultSource={Platform.OS === "ios" ? avatarPlaceholder : undefined}
                onError={() => {/* swallow errors so UI doesn’t break */}}
              />
            ) : (
              <Image source={avatarPlaceholder} style={styles.avatar} resizeMode="cover" />
            )}
          </View>
          <Text style={styles.name}>
            {[data?.first_name, data?.last_name].filter(Boolean).join(" ") || data?.email || "Neighbor"}
          </Text>
          {!!data?.bio && <Text style={styles.bio}>{data.bio}</Text>}
        </View>

        <View style={styles.card}>
          <Text style={styles.h}>Details</Text>
          {!!data?.neighborhood && <Text style={styles.kv}>Neighborhood: <Text style={styles.v}>{data.neighborhood}</Text></Text>}
          {!!data?.skills && <Text style={styles.kv}>Skills: <Text style={styles.v}>{data.skills}</Text></Text>}
          {!!data?.languages && <Text style={styles.kv}>Languages: <Text style={styles.v}>{data.languages}</Text></Text>}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  card:{ backgroundColor:"#1b1b1f", borderColor:"#2a2a2e", borderWidth:1, borderRadius:16, padding:16, marginTop:12 },
  avatarWrap:{ width:120, height:120, borderRadius:60, overflow:"hidden", borderWidth:3, borderColor:"#FFD700" },
  avatar:{ width:"100%", height:"100%" },
  name:{ color:"#EEE", fontWeight:"900", fontSize:20, marginTop:10, textAlign:"center" },
  bio:{ color:"#cfcfcf", marginTop:8, textAlign:"center" },
  h:{ color:"#EEE", fontWeight:"900", marginBottom:8 },
  kv:{ color:"#cfcfcf", marginTop:4 },
  v:{ color:"#EEE", fontWeight:"800" },
});
