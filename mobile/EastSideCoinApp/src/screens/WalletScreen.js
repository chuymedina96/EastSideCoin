// screens/WalletScreen.js
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Pressable,
  ScrollView,
  RefreshControl,
  Animated,
  Easing,
  Alert,
  Platform,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import debounce from "lodash.debounce";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRoute } from "@react-navigation/native";
import { api, listServiceCategories } from "../utils/api"; // ← pulls category list from server

// Flip to false when you wire real send API
const DEMO_MODE = true;

const THEME = {
  bg: "#101012",
  card: "#1b1b1f",
  border: "#2a2a2e",
  text: "#EEE",
  subtext: "#cfcfcf",
  accentGold: "#FFD700",
  accentOrange: "#FF4500",
};

const DEFAULT_CATEGORIES = ["Barber", "Lawn Care", "Studio", "Tutoring", "Cleaning", "Other", "General"];

const fmt = (n) =>
  typeof n === "number" ? n.toLocaleString(undefined, { maximumFractionDigits: 6 }) : n;
const trimAddr = (a, len = 6) => (a?.length > 2 * len ? `${a.slice(0, len)}…${a.slice(-len)}` : a || "");

const WalletScreen = () => {
  const route = useRoute();
  const presetNote = route?.params?.presetNote;

  const [walletAddress, setWalletAddress] = useState(null);
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // send form
  const [toAddress, setToAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [service, setService] = useState(presetNote || ""); // ← pre-fill from navigation
  const [sendCategory, setSendCategory] = useState("General"); // ← NEW: category tag
  const [sending, setSending] = useState(false);

  // categories data
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [catHintSeen, setCatHintSeen] = useState(false);

  // search neighbors
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);

  // UX bits
  const float = useRef(new Animated.Value(0)).current;
  const [showFullAddr, setShowFullAddr] = useState(false);
  const [recent, setRecent] = useState([]);

  // in-flight controllers
  const searchAbortRef = useRef(null);

  // ---- animations ----
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(float, { toValue: 1, duration: 2400, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
        Animated.timing(float, { toValue: 0, duration: 2400, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
      ])
    ).start();
  }, [float]);
  const floatY = float.interpolate({ inputRange: [0, 1], outputRange: [0, -3] });

  // ---- load wallet basics ----
  const loadWallet = useCallback(async () => {
    try {
      const data = await api.get(`/wallet/balance/`);
      setWalletAddress(data?.address || data?.wallet_address || "");
      setBalance(Number(data?.balance ?? 0));
    } catch (e) {
      console.error("❌ Wallet Fetch Error:", e?.data || e?.message || e);
      if (balance == null) setBalance(0);
    }
  }, [balance]);

  // ---- load categories (server → fallback) ----
  const loadCategories = useCallback(async () => {
    try {
      const payload = await listServiceCategories();
      const serverCats = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : [];
      const cleaned = serverCats
        .map((c) => (typeof c === "string" ? c : c?.name))
        .filter(Boolean);
      const uniq = Array.from(new Set([...cleaned, ...DEFAULT_CATEGORIES]));
      setCategories(uniq);
      if (!uniq.includes(sendCategory)) setSendCategory(uniq[0] || "General");
    } catch {
      setCategories(DEFAULT_CATEGORIES);
      if (!DEFAULT_CATEGORIES.includes(sendCategory)) setSendCategory("General");
    }
  }, [sendCategory]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadWallet()]);
    setRefreshing(false);
  }, [loadWallet]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([loadWallet(), loadCategories()]);
      setLoading(false);
    })();
  }, [loadWallet, loadCategories]);

  // ---- validation ----
  const parsedAmt = useMemo(() => {
    const v = parseFloat((amount || "").replace(/,/g, ""));
    return Number.isFinite(v) ? v : NaN;
  }, [amount]);

  const canSend = useMemo(() => {
    if (sending || !walletAddress) return false;
    if (!toAddress || parsedAmt <= 0) return false;
    if (typeof balance === "number" && parsedAmt > balance) return false;
    if (toAddress.length < 10) return false; // basic check
    if (!service.trim()) return false;
    // category optional for send safety; we still allow sending without it
    return true;
  }, [sending, walletAddress, toAddress, parsedAmt, balance, service]);

  // ---- neighbor search (tries /users/search first; falls back to /search_users) ----
  const searchNeighbors = useCallback(
    debounce(async (term) => {
      if (searchAbortRef.current) searchAbortRef.current.abort();
      const ctrl = new AbortController();
      searchAbortRef.current = ctrl;

      if (!term || term.trim().length < 2) {
        setResults([]);
        setSearching(false);
        return;
      }

      try {
        setSearching(true);

        let data = await api.get(`/users/search/`, {
          params: { query: term.trim() },
          signal: ctrl.signal,
        });

        let list = Array.isArray(data) ? data : (Array.isArray(data?.results) ? data.results : null);

        if (!Array.isArray(list)) {
          try {
            data = await api.get(`/search_users/`, {
              params: { q: term.trim(), query: term.trim() },
              signal: ctrl.signal,
            });
            list = Array.isArray(data) ? data : (Array.isArray(data?.results) ? data.results : []);
          } catch {
            list = [];
          }
        }

        const items = (list || [])
          .filter((u) => u.wallet_address)
          .map((u) => ({
            id: u.id,
            name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email,
            email: u.email,
            wallet: u.wallet_address,
          }));

        setResults(items);
      } catch (e) {
        if (e.name !== "CanceledError" && e.name !== "AbortError") {
          console.warn("Neighbor search error:", e?.data || e?.message || e);
        }
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300),
    []
  );

  useEffect(() => {
    return () => {
      if (searchAbortRef.current) searchAbortRef.current.abort();
      searchNeighbors.cancel();
    };
  }, [searchNeighbors]);

  const onChangeQuery = (t) => {
    setQuery(t);
    setShowResults(true);
    searchNeighbors(t);
  };

  const chooseRecipient = (rec) => {
    setShowResults(false);
    setQuery(rec.name || rec.email || rec.wallet);
    setToAddress(rec.wallet);
  };

  // ---- send handler ----
  const handleSend = async () => {
    if (!canSend) return;

    setSending(true);
    try {
      if (DEMO_MODE) {
        await new Promise((r) => setTimeout(r, 700));
        const newBal = Math.max(0, Number(balance ?? 0) - parsedAmt);
        setBalance(newBal);

        const tx = {
          id: `demo_${Date.now()}`,
          from: walletAddress,
          to: toAddress,
          amount: parsedAmt,
          status: "confirmed",
          service,
          category: sendCategory, // ← include category in demo tx
          timestamp: new Date().toISOString(),
        };
        setRecent((prev) => [tx, ...prev].slice(0, 10));
        setAmount("");
        setToAddress("");
        setService("");
        // keep the selected category for the next send
        Alert.alert("Sent (Demo)", `Paid ${parsedAmt} ESC to ${trimAddr(query || toAddress, 6)} for “${service}” (${sendCategory}).`);
      } else {
        // TODO: wire your real endpoint
        // await api.post('/wallet/send/', {
        //   body: { to: toAddress, amount: parsedAmt, note: service, category: sendCategory }
        // });
        // Optionally reload balance + show confirmation
      }
    } catch (e) {
      console.error("❌ Send Error:", e?.data || e?.message || e);
      Alert.alert("Send Failed", "We couldn’t process that transfer. Please try again.");
    } finally {
      setSending(false);
    }
  };

  // ---- UI subcomponents ----
  const BalanceBlock = () => (
    <View style={styles.card}>
      <View style={styles.cardHeaderRow}>
        <Text style={styles.cardHeader}>Wallet</Text>
        <Pressable style={styles.smallBtn} onPress={onRefresh}>
          <Text style={styles.smallBtnText}>Refresh</Text>
        </Pressable>
      </View>

      {!walletAddress ? (
        <Text style={styles.subtle}>No wallet address found on this account.</Text>
      ) : (
        <>
          <Text style={styles.addrLabel}>Address</Text>
          <Pressable onLongPress={() => setShowFullAddr((v) => !v)} hitSlop={8}>
            <Text selectable style={styles.addrValue}>
              {showFullAddr ? walletAddress : trimAddr(walletAddress, 10)}
            </Text>
          </Pressable>

          <View style={styles.balanceRow}>
            <Text style={styles.balanceNumber}>{fmt(balance)}</Text>
            <Text style={styles.balanceTicker}> ESC</Text>
          </View>
          <Text style={styles.subtleStrong}>Keep it local—circulate value on the East Side.</Text>
        </>
      )}
    </View>
  );

  const RecipientRow = ({ item }) => (
    <Pressable style={styles.resultRow} onPress={() => chooseRecipient(item)}>
      <View style={{ flex: 1 }}>
        <Text style={styles.resultName} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={styles.resultMeta} numberOfLines={1}>
          {item.email || trimAddr(item.wallet, 8)}
        </Text>
      </View>
      <Text style={styles.resultWallet}>{trimAddr(item.wallet, 6)}</Text>
    </Pressable>
  );

  const CategoryChips = () => (
    <>
      <Text style={[styles.inputLabel, { marginTop: 10 }]}>Category</Text>
      <Text style={styles.hint}>
        Tag this payment so both sides see what it was for. <Text style={{ fontStyle: "italic" }}>Swipe to see more →</Text>
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} onScroll={() => setCatHintSeen(true)}>
        <View style={styles.chipsRow}>
          {categories.map((c) => {
            const active = c === sendCategory;
            return (
              <Pressable
                key={c}
                onPress={() => setSendCategory(c)}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{c}</Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </>
  );

  const SendBlock = () => (
    <View style={styles.card}>
      <View style={styles.cardHeaderRow}>
        <Text style={styles.cardHeader}>Send ESC</Text>
        {DEMO_MODE ? <Text style={styles.tag}>Demo</Text> : <Text style={styles.tagAlt}>Live</Text>}
      </View>

      {/* Neighbor search */}
      <Text style={styles.inputLabel}>Search neighbor</Text>
      <TextInput
        style={styles.input}
        placeholder="Name, email, or wallet"
        placeholderTextColor="#9a9aa1"
        value={query}
        onChangeText={onChangeQuery}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {showResults ? (
        <View style={styles.resultsBox}>
          {searching ? (
            <ActivityIndicator size="small" color={THEME.accentGold} />
          ) : results.length === 0 ? (
            <Text style={styles.empty}>No matches</Text>
          ) : (
            results.map((r) => <RecipientRow key={r.id} item={r} />)
          )}
        </View>
      ) : null}

      {/* Or paste an address directly */}
      <Text style={[styles.inputLabel, { marginTop: 10 }]}>Recipient Address</Text>
      <TextInput
        style={styles.input}
        placeholder="esc1q... or 0x..."
        placeholderTextColor="#9a9aa1"
        value={toAddress}
        onChangeText={setToAddress}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={[styles.inputLabel, { marginTop: 10 }]}>Amount (ESC)</Text>
      <TextInput
        style={styles.input}
        placeholder="0.00"
        placeholderTextColor="#9a9aa1"
        value={amount}
        onChangeText={setAmount}
        keyboardType={Platform.select({ ios: "decimal-pad", android: "decimal-pad", default: "numeric" })}
      />

      {/* NEW: Category selector */}
      <CategoryChips />

      <Text style={[styles.inputLabel, { marginTop: 10 }]}>What’s this payment for?</Text>
      <Text style={styles.hint}>e.g., haircut with Alan, lawn care, studio time</Text>
      <TextInput
        style={[styles.input, styles.multiline]}
        placeholder="Type a short note…"
        placeholderTextColor="#9a9aa1"
        value={service}
        onChangeText={setService}
        multiline
      />

      <View style={styles.feeRow}>
        <Text style={styles.feeText}>Network fee</Text>
        <Text style={styles.feeTextValue}>{DEMO_MODE ? "—" : "estimate…"}</Text>
      </View>

      <Pressable onPress={handleSend} disabled={!canSend} style={[styles.primaryBtn, !canSend && styles.disabledBtn]}>
        <Text style={styles.primaryBtnText}>{sending ? "Sending…" : "Send"}</Text>
      </Pressable>

      <Text style={styles.disclaimer}>
        {DEMO_MODE
          ? "Demo mode updates balance locally. Connect real transfers when ready."
          : "Transfers are final. Double-check the recipient, category, and purpose."}
      </Text>
    </View>
  );

  const ActivityBlock = () => (
    <View style={styles.card}>
      <Text style={styles.cardHeader}>Recent Activity</Text>
      {recent.length === 0 ? (
        <Text style={styles.empty}>No recent transactions.</Text>
      ) : (
        recent.map((tx) => (
          <View key={tx.id} style={styles.txRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.txTitle}>
                {tx.from?.toLowerCase() === walletAddress?.toLowerCase() ? "Sent" : "Received"} {fmt(tx.amount)} ESC
              </Text>
              <Text style={styles.txMeta}>
                to {trimAddr(tx.to, 8)} • {new Date(tx.timestamp).toLocaleString()}
              </Text>
              {tx.category ? (
                <Text style={styles.txCategory}>Category: {tx.category}</Text>
              ) : null}
              {tx.service ? <Text style={styles.txService}>“{tx.service}”</Text> : null}
            </View>
            <View
              style={[
                styles.statusPill,
                tx.status === "confirmed" ? styles.ok : tx.status === "pending" ? styles.warn : styles.idle,
              ]}
            >
              <Text style={styles.pillText}>{tx.status?.toUpperCase() || "STATUS"}</Text>
            </View>
          </View>
        ))
      )}
    </View>
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator size="large" color={THEME.accentOrange} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      {/* Subtle background accents */}
      <View pointerEvents="none" style={styles.bg}>
        <View style={[styles.accent, styles.accentTop]} />
        <View style={[styles.accent, styles.accentBottom]} />
      </View>

      <Animated.View style={[styles.container, { transform: [{ translateY: floatY }] }]}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={THEME.accentGold} />}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title}>Wallet</Text>
          <Text style={styles.subtitle}>Hold and move value across the neighborhood.</Text>

          <BalanceBlock />
          <SendBlock />
          <ActivityBlock />

          {loading && <ActivityIndicator size="large" color={THEME.accentOrange} style={{ marginTop: 10 }} />}
          <Text style={styles.footer}>America/Chicago</Text>
        </ScrollView>
      </Animated.View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: THEME.bg },

  scroll: { backgroundColor: THEME.bg },
  bg: { ...StyleSheet.absoluteFillObject, zIndex: -1, backgroundColor: THEME.bg },
  accent: {
    position: "absolute",
    width: 360,
    height: 360,
    borderRadius: 999,
    opacity: 0.06,
    transform: [{ rotate: "15deg" }],
  },
  accentTop: { top: -120, right: -90, backgroundColor: THEME.accentGold },
  accentBottom: { bottom: -140, left: -100, backgroundColor: THEME.accentOrange },

  container: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 28 },

  title: { fontSize: 26, fontWeight: "800", color: THEME.accentGold },
  subtitle: { color: THEME.subtext, marginTop: 6, marginBottom: 6 },

  card: {
    backgroundColor: THEME.card,
    borderRadius: 14,
    padding: 14,
    marginTop: 12,
    borderColor: THEME.border,
    borderWidth: 1,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
  },
  cardHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardHeader: { color: THEME.text, fontWeight: "700", fontSize: 16 },

  smallBtn: {
    backgroundColor: "#2d2d2f",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderColor: "#3a3a3f",
    borderWidth: 1,
  },
  smallBtnText: { color: THEME.accentGold, fontWeight: "700" },

  addrLabel: { color: "#b7b7bf", fontSize: 12, marginTop: 8 },
  addrValue: { color: THEME.text, fontSize: 13, marginTop: 2 },

  balanceRow: { flexDirection: "row", alignItems: "flex-end", marginTop: 10 },
  balanceNumber: { color: "#fff", fontSize: 36, fontWeight: "900" },
  balanceTicker: { color: THEME.accentGold, fontWeight: "800", marginLeft: 6, marginBottom: 4 },

  inputLabel: { color: "#e1e1e6", fontSize: 12, marginTop: 4, marginBottom: 6, paddingLeft: 4 },
  hint: { color: "#9a9aa1", fontSize: 12, marginTop: -4, marginBottom: 6, paddingLeft: 4 },
  input: {
    backgroundColor: "#22232a",
    color: "#fff",
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderColor: THEME.border,
    borderWidth: 1,
  },
  multiline: { minHeight: 64, textAlignVertical: "top" },

  resultsBox: {
    backgroundColor: "#1f2026",
    borderColor: THEME.border,
    borderWidth: 1,
    borderRadius: 10,
    marginTop: 8,
    paddingVertical: 6,
    maxHeight: 220,
  },
  resultRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#262730",
  },
  resultName: { color: THEME.text, fontSize: 14, fontWeight: "700" },
  resultMeta: { color: "#a0a0aa", fontSize: 12, marginTop: 2 },
  resultWallet: { color: THEME.accentGold, marginLeft: 10, fontSize: 12, fontWeight: "700" },

  // category chips
  chipsRow: {
    flexDirection: "row",
    gap: 8,
    paddingVertical: 4,
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
  chipText: { color: THEME.subtext, fontWeight: "700", fontSize: 12 },
  chipTextActive: { color: "#cfe0ff", fontWeight: "800" },

  feeRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 10 },
  feeText: { color: "#9a9aa1", fontSize: 12 },
  feeTextValue: { color: "#cfcfcf", fontSize: 12 },

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
  primaryBtnText: { color: "#fff", fontSize: 16, fontWeight: "800", letterSpacing: 0.3 },
  disabledBtn: { opacity: 0.6 },

  subtle: { color: "#b7b7bf" },
  subtleStrong: { color: "#cfcfcf", marginTop: 6 },

  empty: { color: "#8d8d95", textAlign: "left", marginTop: 8 },

  txRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomColor: THEME.border,
    borderBottomWidth: 1,
  },
  txTitle: { color: THEME.text, fontSize: 14, fontWeight: "700" },
  txMeta: { color: "#a0a0aa", fontSize: 12, marginTop: 2 },
  txCategory: { color: "#cfe0ff", fontSize: 12, marginTop: 2, fontWeight: "800" },
  txService: { color: "#cfcfcf", fontSize: 12, marginTop: 2, fontStyle: "italic" },

  statusPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    alignSelf: "flex-start",
    marginLeft: 10,
  },
  ok: { borderColor: "#2f8f46" },
  warn: { borderColor: "#d1a000" },
  idle: { borderColor: "#555" },
  pillText: { color: "#DDD", fontSize: 11, fontWeight: "800", letterSpacing: 0.5 },

  footer: { color: "#7a7a7a", textAlign: "center", marginTop: 14, fontSize: 12 },
});

export default WalletScreen;
