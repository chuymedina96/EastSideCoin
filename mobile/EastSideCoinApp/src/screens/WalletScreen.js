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
  SafeAreaView,
  Platform,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";
import debounce from "lodash.debounce";
import { API_URL } from "../config";

// Flip to false when you wire real send API
const DEMO_MODE = true;

const fmt = (n) =>
  typeof n === "number" ? n.toLocaleString(undefined, { maximumFractionDigits: 6 }) : n;
const trimAddr = (a, len = 6) => (a?.length > 2 * len ? `${a.slice(0, len)}…${a.slice(-len)}` : a || "");

const WalletScreen = () => {
  const [walletAddress, setWalletAddress] = useState(null);
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // send form
  const [toAddress, setToAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [service, setService] = useState(""); // 👈 what the payment is for
  const [sending, setSending] = useState(false);

  // search neighbors
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);

  // UX bits
  const fadeIn = useRef(new Animated.Value(0)).current;
  const float = useRef(new Animated.Value(0)).current;
  const [showFullAddr, setShowFullAddr] = useState(false);
  const [recent, setRecent] = useState([]);

  // ---- animations ----
  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 700, useNativeDriver: true, easing: Easing.out(Easing.cubic) }).start();
    Animated.loop(
      Animated.sequence([
        Animated.timing(float, { toValue: 1, duration: 2400, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
        Animated.timing(float, { toValue: 0, duration: 2400, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
      ])
    ).start();
  }, [fadeIn, float]);

  const floatY = float.interpolate({ inputRange: [0, 1], outputRange: [0, -4] });

  // ---- load wallet basics ----
  const loadWallet = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem("user");
      const parsed = raw ? JSON.parse(raw) : null;
      const addr = parsed?.wallet_address || null;
      setWalletAddress(addr);

      if (!addr) {
        setBalance(0);
        return;
      }

      const url = `${API_URL}/balance/${addr}/`;
      const res = await axios.get(url);
      setBalance(Number(res?.data?.balance ?? 0));

      // optionally hydrate activity from API
      // const txRes = await axios.get(`${API_URL}/transactions/${addr}/?limit=10`);
      // setRecent(txRes.data?.results ?? []);
    } catch (e) {
      console.error("❌ Wallet Fetch Error:", e?.response?.data || e?.message || e);
      if (balance == null) setBalance(0);
    }
  }, [balance]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadWallet();
    setRefreshing(false);
  }, [loadWallet]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await loadWallet();
      setLoading(false);
    })();
  }, [loadWallet]);

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
    // not strictly required but nice:
    if (!service.trim()) return false;
    return true;
  }, [sending, walletAddress, toAddress, parsedAmt, balance, service]);

  // ---- neighbor search ----
  const searchNeighbors = useCallback(
    debounce(async (term) => {
      if (!term || term.trim().length < 2) {
        setResults([]);
        setSearching(false);
        return;
      }
      try {
        setSearching(true);
        // adjust query param to match your backend
        const res = await axios.get(`${API_URL}/search_users/`, { params: { q: term.trim() } });
        const items = Array.isArray(res?.data?.results) ? res.data.results : [];
        setResults(
          items
            .filter((u) => u.wallet_address)
            .map((u) => ({
              id: u.id,
              name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email,
              email: u.email,
              wallet: u.wallet_address,
            }))
        );
      } catch (e) {
        console.warn("Neighbor search error:", e?.response?.data || e?.message || e);
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250),
    []
  );

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
          timestamp: new Date().toISOString(),
        };
        setRecent((prev) => [tx, ...prev].slice(0, 10));
        setAmount("");
        // keep query text (the name) but clear raw address so user sees who they paid
        setToAddress("");
        setService("");
        Alert.alert("Sent (Demo)", `Paid ${parsedAmt} ESC to ${trimAddr(query || toAddress, 6)} for “${service}”.`);
      } else {
        // Example real request (adjust to your backend contract)
        // const res = await axios.post(`${API_URL}/transfer/`, {
        //   from_address: walletAddress,
        //   to_address: toAddress,
        //   amount: parsedAmt,
        //   memo: service, // 👈 send along service/purpose
        // });
        // if (!res?.data?.tx_id) throw new Error("No tx id");
        // await onRefresh();
        // setAmount(""); setService(""); setToAddress("");
        // Alert.alert("Success", `Transaction ${res.data.tx_id} submitted.`);
      }
    } catch (e) {
      console.error("❌ Send Error:", e?.response?.data || e?.message || e);
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
          {/* 🔧 color/contrast fixed (lighter grey) */}
          <Text style={styles.subtleStrong}>
            Keep it local—circulate value on the East Side.
          </Text>
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
        placeholder="Name or email"
        placeholderTextColor="#9a9aa1"
        value={query}
        onChangeText={onChangeQuery}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {showResults ? (
        <View style={styles.resultsBox}>
          {searching ? (
            <ActivityIndicator size="small" color="#FFD700" />
          ) : results.length === 0 ? (
            <Text style={styles.empty}>No matches</Text>
          ) : (
            results.map((r) => <RecipientRow key={r.id} item={r} />)
          )}
        </View>
      ) : null}

      {/* Or paste an address directly (auto-filled if you picked a neighbor) */}
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

      {/* Service / purpose field */}
      <Text style={[styles.inputLabel, { marginTop: 10 }]}>What’s this payment for?</Text>
      <TextInput
        style={[styles.input, styles.multiline]}
        placeholder="e.g., haircut with Alan, lawn care, studio time, etc."
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
          : "Transfers are final. Double-check the recipient and purpose."}
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

  return (
    <SafeAreaView style={styles.safe}>
      {/* Background accents */}
      <View style={styles.bg}>
        <View className="accent" style={[styles.accent, styles.accentTop]} />
        <View className="accent" style={[styles.accent, styles.accentBottom]} />
      </View>

      <Animated.View style={[styles.container, { opacity: fadeIn, transform: [{ translateY: floatY }] }]}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#FFD700" />}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title}>Wallet</Text>
          <Text style={styles.subtitle}>Hold and move value across the neighborhood.</Text>

          <BalanceBlock />
          <SendBlock />
          <ActivityBlock />

          {loading && <ActivityIndicator size="large" color="#FF4500" style={{ marginTop: 10 }} />}
          <Text style={styles.footer}>America/Chicago</Text>
        </ScrollView>
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
    opacity: 0.12,
    transform: [{ rotate: "15deg" }],
  },
  accentTop: { top: -90, right: -70, backgroundColor: "#FFD700" },
  accentBottom: { bottom: -110, left: -80, backgroundColor: "#FF4500" },

  container: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 28 },

  title: { fontSize: 26, fontWeight: "800", color: "#FFD700" },
  subtitle: { color: "#cfcfcf", marginTop: 6, marginBottom: 6 },

  card: {
    backgroundColor: "#1b1b1f",
    borderRadius: 14,
    padding: 14,
    marginTop: 12,
    borderColor: "#2a2a2e",
    borderWidth: 1,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
  },
  cardHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardHeader: { color: "#EEE", fontWeight: "700", fontSize: 16 },

  smallBtn: {
    backgroundColor: "#2d2d2f",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderColor: "#3a3a3f",
    borderWidth: 1,
  },
  smallBtnText: { color: "#FFD700", fontWeight: "700" },

  addrLabel: { color: "#b7b7bf", fontSize: 12, marginTop: 8 },
  addrValue: { color: "#EEE", fontSize: 13, marginTop: 2 },

  balanceRow: { flexDirection: "row", alignItems: "flex-end", marginTop: 10 },
  balanceNumber: { color: "#fff", fontSize: 36, fontWeight: "900" },
  balanceTicker: { color: "#FFD700", fontWeight: "800", marginLeft: 6, marginBottom: 4 },

  inputLabel: { color: "#e1e1e6", fontSize: 12, marginTop: 4, marginBottom: 6, paddingLeft: 4 },
  input: {
    backgroundColor: "#22232a",
    color: "#fff",
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderColor: "#2a2a2e",
    borderWidth: 1,
  },
  multiline: { minHeight: 64, textAlignVertical: "top" },

  // search results popover
  resultsBox: {
    backgroundColor: "#1f2026",
    borderColor: "#2a2a2e",
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
  resultName: { color: "#EEE", fontSize: 14, fontWeight: "700" },
  resultMeta: { color: "#a0a0aa", fontSize: 12, marginTop: 2 },
  resultWallet: { color: "#FFD700", marginLeft: 10, fontSize: 12, fontWeight: "700" },

  feeRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 10 },
  feeText: { color: "#9a9aa1", fontSize: 12 },
  feeTextValue: { color: "#cfcfcf", fontSize: 12 },

  primaryBtn: {
    backgroundColor: "#FF4500",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 14,
    shadowColor: "#FF4500",
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  primaryBtnText: { color: "#fff", fontSize: 16, fontWeight: "800", letterSpacing: 0.3 },
  disabledBtn: { opacity: 0.6 },

  disclaimer: { color: "#8b8b95", fontSize: 12, marginTop: 8 },

  empty: { color: "#8d8d95", textAlign: "left", marginTop: 8 },

  txRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomColor: "#2a2a2e",
    borderBottomWidth: 1,
  },
  txTitle: { color: "#EEE", fontSize: 14, fontWeight: "700" },
  txMeta: { color: "#a0a0aa", fontSize: 12, marginTop: 2 },
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
