// screens/ServicesScreen.js
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Platform,
  Animated,
  Easing,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import debounce from "lodash.debounce";
import { api } from "../utils/api"; // ✅ shared axios instance with auth
import { API_URL } from "../config"; // kept in case you need it elsewhere

// Toggle to true to show local demo items if your API route isn't finished yet
const DEMO_MODE = false;

const THEME = {
  bg: "#101012",
  card: "#1b1b1f",
  border: "#2a2a2e",
  text: "#EEE",
  subtext: "#cfcfcf",
  subtle: "#9a9aa1",
  accentGold: "#FFD700",
  accentOrange: "#FF4500",
};

const DEFAULT_CATEGORIES = ["All", "Barber", "Lawn Care", "Studio", "Tutoring", "Cleaning", "Other"];

const demoItems = [
  {
    id: "demo-1",
    title: "Fresh Fade w/ Alan",
    description: "Skin fade, beard lineup, hot towel. East Side special.",
    price: 25.0,
    category: "Barber",
    user: { first_name: "Alan", last_name: "M.", email: "alan@example.com" },
  },
  {
    id: "demo-2",
    title: "Front Lawn Cut",
    description: "Mow + edge + quick clean up. Same-day slots.",
    price: 30.0,
    category: "Lawn Care",
    user: { first_name: "Marco", last_name: "R.", email: "marco@example.com" },
  },
  {
    id: "demo-3",
    title: "Vocal Recording (1 hr)",
    description: "Pro mic chain + light mixing while you track.",
    price: 40.0,
    category: "Studio",
    user: { first_name: "Chuy", last_name: "M.", email: "chuy@example.com" },
  },
];

// Normalize any common API list shapes into a plain array
const toArray = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.services)) return data.services;
  return [];
};

const ServicesScreen = ({ navigation }) => {
  const insets = useSafeAreaInsets();

  // query state
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");

  // data/load state
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  // small float accent animation (subtle)
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

  // Single in-flight controller for fetches (so we can cancel stale ones)
  const abortRef = useRef(null);

  // fetch services (debounced gateway)
  const doFetch = useCallback(
    debounce(async (q, cat) => {
      // Cancel older in-flight request (if any)
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      if (DEMO_MODE) {
        setError("");
        const filtered = demoItems.filter((it) => {
          const catOk = cat === "All" || it.category?.toLowerCase() === cat.toLowerCase();
          const qLower = (q || "").toLowerCase();
          const qOk =
            !qLower ||
            it.title.toLowerCase().includes(qLower) ||
            it.description.toLowerCase().includes(qLower) ||
            it.user?.first_name?.toLowerCase().includes(qLower) ||
            it.user?.last_name?.toLowerCase().includes(qLower);
          return catOk && qOk;
        });
        setServices(filtered);
        setLoading(false);
        setRefreshing(false);
        return;
      }

      try {
        setError("");
        const params = {};
        if (q && q.trim().length > 0) params.q = q.trim();
        if (cat && cat !== "All") params.category = cat;

        // Expected response shapes handled by toArray()
        const res = await api.get("/services/", { params, signal: ctrl.signal });
        const list = toArray(res?.data);
        setServices(list);
      } catch (e) {
        if (e.name === "CanceledError" || e.name === "AbortError") return;
        console.warn("Services fetch error:", e?.response?.data || e?.message || e);
        setError("Could not load services right now.");
        setServices([]);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    }, 300),
    []
  );

  const load = useCallback(async () => {
    setLoading(true);
    await doFetch(query, category);
  }, [doFetch, query, category]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await doFetch(query, category);
  }, [doFetch, query, category]);

  useEffect(() => {
    load();
    return () => {
      // cleanup: cancel any in-flight on unmount
      if (abortRef.current) abortRef.current.abort();
      doFetch.cancel();
    };
  }, [load, doFetch]);

  // UI helpers
  const onChangeQuery = (t) => {
    setQuery(t);
    doFetch(t, category);
  };

  const onSelectCategory = (cat) => {
    setCategory(cat);
    doFetch(query, cat);
  };

  const Header = () => (
    <View style={[styles.header, { paddingTop: 6 }]}>
      <Text style={styles.title}>Available Services</Text>
      <Text style={styles.subtitle}>Book neighbors. Keep value local.</Text>
    </View>
  );

  const SearchBar = () => (
    <View style={styles.searchWrap}>
      <TextInput
        value={query}
        onChangeText={onChangeQuery}
        placeholder="Search by title, person, or keyword…"
        placeholderTextColor={THEME.subtle}
        style={styles.searchInput}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />
    </View>
  );

  const CategoryChips = () => (
    <View style={styles.chipsRow}>
      {DEFAULT_CATEGORIES.map((c) => {
        const active = c === category;
        return (
          <Pressable
            key={c}
            onPress={() => onSelectCategory(c)}
            style={({ pressed }) => [
              styles.chip,
              active && styles.chipActive,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{c}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  const EmptyState = () =>
    !loading && (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyTitle}>No services found</Text>
        <Text style={styles.emptyText}>Try a different keyword or switch categories.</Text>
      </View>
    );

  const Skeleton = () => (
    <View style={styles.card}>
      <View style={[styles.skeleton, { width: "62%" }]} />
      <View style={[styles.skeleton, { width: "88%", marginTop: 8 }]} />
      <View style={[styles.skeleton, { width: "45%", height: 14, marginTop: 10 }]} />
    </View>
  );

  const ServiceCard = ({ item }) => {
    const owner =
      item.user?.first_name || item.user?.last_name
        ? `${item.user?.first_name || ""} ${item.user?.last_name || ""}`.trim()
        : item.user?.email || "Neighbor";

    const priceNum = Number(item.price);
    const priceLabel = Number.isFinite(priceNum)
      ? priceNum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "—";

    return (
      <Pressable
        onPress={() => navigation?.navigate?.("ServiceDetail", { id: item.id, service: item })}
        style={({ pressed }) => [styles.card, pressed && { opacity: 0.96 }]}
      >
        <View style={styles.cardTopRow}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.price}>{priceLabel} ESC</Text>
        </View>
        <Text style={styles.owner} numberOfLines={1}>
          by {owner} • <Text style={styles.categoryText}>{item.category || "Other"}</Text>
        </Text>
        <Text style={styles.desc} numberOfLines={3}>
          {item.description}
        </Text>

        <View style={styles.cardFooter}>
          <Pressable
            style={({ pressed }) => [
              styles.primaryBtn,
              pressed && { transform: [{ scale: 0.98 }] },
            ]}
            onPress={() => navigation?.navigate?.("NewChatOrThread", { toUserEmail: item.user?.email })}
          >
            <Text style={styles.primaryBtnText}>Message</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.secondaryBtn, pressed && { opacity: 0.9 }]}
            onPress={() =>
              navigation?.navigate?.("Wallet", {
                presetNote: `Service: ${item.title}`,
              })
            }
          >
            <Text style={styles.secondaryBtnText}>Pay</Text>
          </Pressable>
        </View>
      </Pressable>
    );
  };

  const renderItem = ({ item }) => <ServiceCard item={item} />;
  const keyExtractor = (item) => String(item.id);

  // Skeleton overlay should respect safe area:
  const skeletonTop = useMemo(() => insets.top + 120, [insets.top]);

  return (
    <SafeAreaView style={styles.safe}>
      {/* Subtle animated accents */}
      <Animated.View style={[styles.accent, styles.accentTop, { transform: [{ translateY: floatY }] }]} />
      <Animated.View style={[styles.accent, styles.accentBottom, { transform: [{ translateY: floatY }] }]} />

      <FlatList
        data={services}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListHeaderComponent={
          <>
            <Header />
            <SearchBar />
            <CategoryChips />
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
          </>
        }
        ListEmptyComponent={loading ? null : <EmptyState />}
        contentContainerStyle={[styles.listContent, { paddingTop: 8 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={THEME.accentGold} />}
        keyboardShouldPersistTaps="handled"
      />

      {/* Initial skeletons */}
      {loading && (
        <View style={[styles.skeletonWrap, { top: skeletonTop }]}>
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </View>
      )}
    </SafeAreaView>
  );
};

export default ServicesScreen;

/* ======= styles ======= */
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: THEME.bg },
  listContent: { paddingHorizontal: 16, paddingBottom: 28 },

  header: { marginBottom: 8 },
  title: { color: THEME.accentGold, fontSize: 24, fontWeight: "800" },
  subtitle: { color: THEME.subtext, marginTop: 6 },

  searchWrap: {
    marginTop: 10,
    backgroundColor: "#22232a",
    borderColor: THEME.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: Platform.select({ ios: 10, android: 6, default: 8 }),
  },
  searchInput: {
    color: THEME.text,
    paddingVertical: Platform.select({ ios: 6, android: 2, default: 4 }),
  },

  chipsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 12,
    marginBottom: 6,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: THEME.border,
    backgroundColor: "#1f2026",
  },
  chipActive: {
    borderColor: "#22355f",
    backgroundColor: "#1b2a4b",
  },
  chipText: { color: THEME.subtext, fontWeight: "600", fontSize: 12 },
  chipTextActive: { color: "#cfe0ff" },

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
  cardTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardTitle: { color: THEME.text, fontSize: 16, fontWeight: "800", maxWidth: "70%" },
  price: { color: THEME.accentGold, fontWeight: "900", fontSize: 16 },

  owner: { color: "#b7b7bf", fontSize: 12, marginTop: 6 },
  categoryText: { color: "#cfe0ff", fontWeight: "700" },
  desc: { color: THEME.subtext, marginTop: 8, lineHeight: 18 },

  cardFooter: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 12,
  },
  primaryBtn: {
    backgroundColor: THEME.accentOrange,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    shadowColor: THEME.accentOrange,
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  primaryBtnText: { color: "#fff", fontWeight: "800" },
  secondaryBtn: {
    backgroundColor: "#2d2d2f",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderColor: "#3a3a3f",
    borderWidth: 1,
  },
  secondaryBtnText: { color: THEME.text, fontWeight: "800" },

  emptyWrap: { alignItems: "center", paddingVertical: 48 },
  emptyTitle: { color: THEME.text, fontSize: 16, fontWeight: "800" },
  emptyText: { color: THEME.subtext, marginTop: 6 },

  errorText: { color: "#ff6b6b", marginTop: 8 },

  skeletonWrap: {
    position: "absolute",
    left: 16,
    right: 16,
  },
  skeleton: {
    height: 16,
    backgroundColor: "#23242c",
    borderRadius: 8,
    borderColor: THEME.border,
    borderWidth: 1,
  },

  // accents
  accent: {
    position: "absolute",
    width: 300,
    height: 300,
    borderRadius: 999,
    opacity: 0.10,
  },
  accentTop: { top: -70, right: -60, backgroundColor: THEME.accentGold },
  accentBottom: { bottom: -90, left: -70, backgroundColor: THEME.accentOrange },
});
