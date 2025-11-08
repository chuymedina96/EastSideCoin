// screens/ServiceDetailScreen.js
import React, { useEffect, useState, useCallback, useRef } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Alert, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { getService, deleteService } from "../utils/api";

const THEME = {
  bg: "#101012",
  card: "#1b1b1f",
  border: "#2a2a2e",
  text: "#EEE",
  subtext: "#cfcfcf",
  accentGold: "#FFD700",
  accentOrange: "#FF4500",
  danger: "#E63946",
};

export default function ServiceDetailScreen({ route, navigation }) {
  const { id, service: initial } = route.params || {};
  const [service, setService] = useState(initial || null);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState("");

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setError("");
      setLoading(true);
      const data = await getService(id);
      if (mountedRef.current) setService(data);
    } catch (e) {
      if (mountedRef.current) {
        setError("Could not load service.");
        setService(null);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!initial) load();
  }, [initial, load]);

  const ownerName = (() => {
    const u = service?.user;
    if (!u) return "Neighbor";
    if (u.first_name || u.last_name) return `${u.first_name || ""} ${u.last_name || ""}`.trim();
    return u.email || "Neighbor";
  })();

  const priceLabel = Number.isFinite(Number(service?.price))
    ? Number(service.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "—";

  const onMessage = () => {
    const email = service?.user?.email;
    if (!email) return;
    navigation?.navigate?.("NewChatOrThread", { toUserEmail: email });
  };

  const onPay = () => {
    navigation?.navigate?.("Wallet", { presetNote: `Service: ${service?.title}` });
  };

  const goEdit = () => {
    navigation?.navigate?.("ServiceEditor", { mode: "edit", service });
  };

  const onDelete = () => {
    Alert.alert("Delete Service", "This will remove your service from the marketplace.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteService(service.id);
            Alert.alert("Deleted", "Your service was removed.");
            navigation?.goBack();
          } catch (e) {
            Alert.alert("Error", "Could not delete right now.");
          }
        },
      },
    ]);
  };

  const isOwner = !!service?.is_owner; // server can set this flag; if not, you can compute via auth user id.

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        {loading ? (
          <View style={styles.card}><ActivityIndicator color={THEME.accentGold} /></View>
        ) : error ? (
          <View style={styles.card}><Text style={styles.error}>{error}</Text></View>
        ) : !service ? (
          <View style={styles.card}><Text style={styles.label}>Not found.</Text></View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.title}>{service.title}</Text>
            <Text style={styles.owner}>by {ownerName}</Text>
            <Text style={styles.price}>{priceLabel} ESC</Text>
            <Text style={styles.desc}>{service.description}</Text>

            <View style={styles.row}>
              {!isOwner ? (
                <>
                  <Pressable style={styles.primaryBtn} onPress={onMessage}>
                    <Text style={styles.primaryBtnText}>Message</Text>
                  </Pressable>
                  <Pressable style={styles.secondaryBtn} onPress={onPay}>
                    <Text style={styles.secondaryBtnText}>Pay</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Pressable style={styles.primaryBtn} onPress={goEdit}>
                    <Text style={styles.primaryBtnText}>Edit</Text>
                  </Pressable>
                  <Pressable style={styles.dangerBtn} onPress={onDelete}>
                    <Text style={styles.primaryBtnText}>Delete</Text>
                  </Pressable>
                </>
              )}
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: THEME.bg },
  content: { padding: 16, paddingBottom: 32 },
  card: {
    backgroundColor: THEME.card,
    borderColor: THEME.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
  },
  title: { color: THEME.text, fontSize: 22, fontWeight: "900" },
  owner: { color: THEME.subtext, marginTop: 4 },
  price: { color: THEME.accentGold, fontWeight: "900", fontSize: 18, marginTop: 10 },
  desc: { color: THEME.text, marginTop: 12, lineHeight: 20 },
  row: { flexDirection: "row", gap: 10, marginTop: 16, justifyContent: "flex-end" },
  primaryBtn: {
    backgroundColor: THEME.accentOrange,
    paddingHorizontal: 16, paddingVertical: 12, borderRadius: 10,
  },
  secondaryBtn: {
    backgroundColor: "#2d2d2f",
    paddingHorizontal: 16, paddingVertical: 12, borderRadius: 10, borderColor: "#3a3a3f", borderWidth: 1,
  },
  dangerBtn: {
    backgroundColor: THEME.danger,
    paddingHorizontal: 16, paddingVertical: 12, borderRadius: 10,
  },
  primaryBtnText: { color: "#fff", fontWeight: "800" },
  secondaryBtnText: { color: THEME.text, fontWeight: "800" },
  error: { color: "#ff6b6b" },
  label: { color: THEME.text },
});
