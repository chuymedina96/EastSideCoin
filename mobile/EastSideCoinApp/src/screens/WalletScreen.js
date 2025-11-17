// screens/WalletScreen.js
import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
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
import debounce from "lodash.debounce";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRoute, useNavigation } from "@react-navigation/native";
import {
  api, // kept for future live send wiring
  listServiceCategories,
  searchUsersSmart,
  walletBalance,
} from "../utils/api";

// Flip to false when you wire real send API
const DEMO_MODE = true;
const DEMO_LEDGER_KEY = "esc_demo_ledger_v1";
const DEMO_TX_KEY = "esc_demo_tx_v1";
const DEMO_SEED = 100;

const THEME = {
  bg: "#101012",
  card: "#1b1b1f",
  border: "#2a2a2e",
  text: "#EEE",
  subtext: "#cfcfcf",
  accentGold: "#FFD700",
  accentOrange: "#FF4500",
};

const DEFAULT_CATEGORIES = [
  "Barber",
  "Lawn Care",
  "Studio",
  "Tutoring",
  "Cleaning",
  "Other",
  "General",
];

const fmt = (n) =>
  typeof n === "number"
    ? n.toLocaleString(undefined, { maximumFractionDigits: 6 })
    : n;

const trimAddr = (a, len = 6) =>
  a?.length > 2 * len ? `${a.slice(0, len)}…${a.slice(-len)}` : a || "";

// ---- demo ledger helpers (per-wallet, per-device) ----
async function getDemoLedger() {
  try {
    const raw = await AsyncStorage.getItem(DEMO_LEDGER_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    console.warn("Demo ledger load error:", e?.message || e);
    return {};
  }
}

async function saveDemoLedger(ledger) {
  try {
    await AsyncStorage.setItem(DEMO_LEDGER_KEY, JSON.stringify(ledger || {}));
  } catch (e) {
    console.warn("Demo ledger save error:", e?.message || e);
  }
}

// ---- demo tx history helpers (per-wallet, per-device) ----
async function getDemoTxStore() {
  try {
    const raw = await AsyncStorage.getItem(DEMO_TX_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    console.warn("Demo tx load error:", e?.message || e);
    return {};
  }
}

async function saveDemoTxStore(store) {
  try {
    await AsyncStorage.setItem(DEMO_TX_KEY, JSON.stringify(store || {}));
  } catch (e) {
    console.warn("Demo tx save error:", e?.message || e);
  }
}

// 🔧 DEV helper to hard-reset all demo balances + txs
export async function resetDemoLedger() {
  try {
    await AsyncStorage.removeItem(DEMO_LEDGER_KEY);
    await AsyncStorage.removeItem(DEMO_TX_KEY);
    Alert.alert(
      "Demo ledger reset",
      "All demo balances and demo transactions were cleared. Reload wallets to reseed."
    );
  } catch (e) {
    console.warn("Failed to reset demo ledger:", e?.message || e);
    Alert.alert("Error", "Could not reset demo ledger.");
  }
}

const WalletScreen = () => {
  const route = useRoute();
  const navigation = useNavigation();

  const {
    presetNote,
    presetAmount,
    presetToAddress,
    presetCategory,
    presetRecipientLabel,
    fromBookingId,
  } = route?.params || {};

  const [walletAddress, setWalletAddress] = useState(null);
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // send form
  const [toAddress, setToAddress] = useState(presetToAddress || "");
  const [amount, setAmount] = useState(
    presetAmount != null ? String(presetAmount) : ""
  );
  const [service, setService] = useState(presetNote || "");
  const [sendCategory, setSendCategory] = useState(
    presetCategory || "General"
  );
  const [sending, setSending] = useState(false);

  // categories data
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);

  // search neighbors
  const [query, setQuery] = useState(presetRecipientLabel || "");
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
        Animated.timing(float, {
          toValue: 1,
          duration: 2400,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.quad),
        }),
        Animated.timing(float, {
          toValue: 0,
          duration: 2400,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.quad),
        }),
      ])
    ).start();
  }, [float]);

  const floatY = float.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -3],
  });

  // ---- load wallet basics (with demo ledger seeding) ----
  const loadWallet = useCallback(async () => {
    try {
      const data = await walletBalance();
      let addr = data?.address || data?.wallet_address || "";

      if (!addr && DEMO_MODE) {
        addr = "esc_demo_wallet_local";
      }

      if (!addr) {
        setWalletAddress("");
        setBalance(0);
        return;
      }

      let balNum = Number(data?.balance);
      if (!Number.isFinite(balNum) || balNum < 0) balNum = 0;

      if (DEMO_MODE) {
        const ledger = await getDemoLedger();
        if (ledger[addr] == null) {
          const seed = balNum > 0 ? balNum : DEMO_SEED; // default seed
          ledger[addr] = seed;
          await saveDemoLedger(ledger);
          balNum = seed;
        } else {
          balNum = Number(ledger[addr]);
          if (!Number.isFinite(balNum) || balNum < 0) balNum = 0;
        }
      }

      setWalletAddress(addr);
      setBalance(balNum);
    } catch (e) {
      console.error("❌ Wallet Fetch Error:", e?.data || e?.message || e);
      if (DEMO_MODE) {
        const addr = "esc_demo_wallet_local";
        const ledger = await getDemoLedger();
        if (ledger[addr] == null) {
          ledger[addr] = DEMO_SEED;
          await saveDemoLedger(ledger);
        }
        const stored = Number(ledger[addr]);
        setWalletAddress(addr);
        setBalance(
          Number.isFinite(stored) && stored > 0 ? stored : DEMO_SEED
        );
      } else {
        setWalletAddress("");
        setBalance(0);
      }
    }
  }, []);

  // ---- seed categories ----
  const loadCategories = useCallback(async () => {
    try {
      const payload = await listServiceCategories();
      const serverCats = Array.isArray(payload?.results)
        ? payload.results
        : Array.isArray(payload)
        ? payload
        : [];
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

  // initial load
  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([loadWallet(), loadCategories()]);
      setLoading(false);
    })();
  }, [loadWallet, loadCategories]);

  // After we know the wallet address, load its demo history
  useEffect(() => {
    if (!DEMO_MODE || !walletAddress) return;
    (async () => {
      const store = await getDemoTxStore();
      const list = Array.isArray(store[walletAddress])
        ? store[walletAddress]
        : [];
      setRecent(list);
    })();
  }, [walletAddress]);

  // Sync when navigation presets change (while mounted)
  useEffect(() => {
    if (presetToAddress && !toAddress) setToAddress(presetToAddress);
    if (presetAmount != null && !amount) setAmount(String(presetAmount));
    if (presetNote && !service) setService(presetNote);
    if (presetCategory && sendCategory === "General")
      setSendCategory(presetCategory);
    if (presetRecipientLabel && !query) setQuery(presetRecipientLabel);
  }, [
    presetToAddress,
    presetAmount,
    presetNote,
    presetCategory,
    presetRecipientLabel,
    toAddress,
    amount,
    service,
    sendCategory,
    query,
  ]);

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
    return true;
  }, [sending, walletAddress, toAddress, parsedAmt, balance, service]);

  // ---- neighbor search (uses searchUsersSmart helper) ----
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
        const list = await searchUsersSmart(term.trim(), {
          signal: ctrl.signal,
        });

        const items = (list || [])
          .filter((u) => u.wallet_address)
          .map((u) => ({
            id: u.id,
            name:
              [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email,
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
        if (!walletAddress) {
          throw new Error("No wallet address for this account");
        }

        await new Promise((r) => setTimeout(r, 500));

        // Load ledger, adjust sender & recipient
        const ledger = await getDemoLedger();
        const sender = walletAddress;
        const recipient = (toAddress || "").trim();

        const rawSenderBal =
          typeof ledger[sender] === "number" && Number.isFinite(ledger[sender])
            ? ledger[sender]
            : typeof balance === "number"
            ? balance
            : 0;

        if (!Number.isFinite(parsedAmt) || parsedAmt <= 0) {
          Alert.alert("Invalid amount", "Enter a valid positive amount.");
          setSending(false);
          return;
        }

        if (parsedAmt > rawSenderBal) {
          Alert.alert(
            "Insufficient funds",
            "This demo wallet doesn’t have enough ESC for that transfer."
          );
          setSending(false);
          return;
        }

        const newSenderBal = Math.max(0, rawSenderBal - parsedAmt);

        // Recipient gets seeded if first time
        let rawRecipientBal;
        if (
          typeof ledger[recipient] === "number" &&
          Number.isFinite(ledger[recipient])
        ) {
          rawRecipientBal = ledger[recipient];
        } else {
          rawRecipientBal = DEMO_SEED;
          ledger[recipient] = DEMO_SEED;
        }
        const newRecipientBal = rawRecipientBal + parsedAmt;

        ledger[sender] = newSenderBal;
        if (recipient && recipient.length >= 10) {
          ledger[recipient] = newRecipientBal;
        }

        await saveDemoLedger(ledger);

        setBalance(newSenderBal);

        const tx = {
          id: `demo_${Date.now()}`,
          from: sender,
          to: recipient,
          amount: parsedAmt,
          status: "confirmed",
          service,
          category: sendCategory,
          timestamp: new Date().toISOString(),
          fromBookingId,
        };

        // Persist tx history per wallet (sender + recipient)
        const txStore = await getDemoTxStore();
        const senderList = Array.isArray(txStore[sender])
          ? txStore[sender]
          : [];
        txStore[sender] = [tx, ...senderList].slice(0, 20);

        if (recipient && recipient.length >= 10) {
          const recipList = Array.isArray(txStore[recipient])
            ? txStore[recipient]
            : [];
          txStore[recipient] = [tx, ...recipList].slice(0, 20);
        }
        await saveDemoTxStore(txStore);

        // Update local recent from sender perspective
        setRecent((prev) => [tx, ...prev].slice(0, 10));

        Alert.alert(
          "Sent (Demo)",
          `Paid ${parsedAmt} ESC to ${trimAddr(
            query || recipient,
            6
          )} for “${service}” (${sendCategory}).`
        );

        // Let Bookings screen know this booking just got paid (demo)
        if (fromBookingId && navigation?.navigate) {
          navigation.navigate("Bookings", {
            paidBookingId: fromBookingId,
            paidTx: tx,
          });
        }

        // Clear form AFTER using query/toAddress in alert
        setAmount("");
        setToAddress("");
        setService("");
      } else {
        // TODO: wire your real endpoint
        // const payload = await api.post("/wallet/send/", {
        //   to: toAddress,
        //   amount: parsedAmt,
        //   note: service,
        //   category: sendCategory,
        //   booking_id: fromBookingId,
        // });
        // await loadWallet();
        // // Optional: update recent from server payload
      }
    } catch (e) {
      console.error("❌ Send Error:", e?.data || e?.message || e);
      Alert.alert(
        "Send Failed",
        "We couldn’t process that transfer. Please try again."
      );
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
        <Text style={styles.subtle}>
          No wallet address found on this account.
        </Text>
      ) : (
        <>
          <Text style={styles.addrLabel}>Address</Text>
          <Pressable
            onLongPress={() => setShowFullAddr((v) => !v)}
            hitSlop={8}
          >
            <Text selectable style={styles.addrValue}>
              {showFullAddr ? walletAddress : trimAddr(walletAddress, 10)}
            </Text>
          </Pressable>

          <View style={styles.balanceRow}>
            <Text style={styles.balanceNumber}>{fmt(balance)}</Text>
            <Text style={styles.balanceTicker}> ESC</Text>
          </View>
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

  const CategoryChips = () => (
    <>
      <Text style={[styles.inputLabel, { marginTop: 10 }]}>Category</Text>
      <Text style={styles.hint}>
        Tag this payment so both sides see what it was for.{" "}
        <Text style={{ fontStyle: "italic" }}>Swipe to see more →</Text>
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.chipsRow}>
          {categories.map((c) => {
            const active = c === sendCategory;
            return (
              <Pressable
                key={c}
                onPress={() => setSendCategory(c)}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text
                  style={[styles.chipText, active && styles.chipTextActive]}
                >
                  {c}
                </Text>
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
        {DEMO_MODE ? (
          <Text style={styles.tag}>Demo</Text>
        ) : (
          <Text style={styles.tagAlt}>Live</Text>
        )}
      </View>

      {fromBookingId ? (
        <Text style={styles.bookingBanner}>
          Prefilled from booking #{fromBookingId}. Double-check recipient and
          amount before sending.
        </Text>
      ) : null}

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
      <Text style={[styles.inputLabel, { marginTop: 10 }]}>
        Recipient Address
      </Text>
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
        keyboardType={Platform.select({
          ios: "decimal-pad",
          android: "decimal-pad",
          default: "numeric",
        })}
      />

      {/* Category selector */}
      <CategoryChips />

      <Text style={[styles.inputLabel, { marginTop: 10 }]}>
        What’s this payment for?
      </Text>
      <Text style={styles.hint}>
        e.g., haircut with Alan, lawn care, studio time
      </Text>
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
        <Text style={styles.feeTextValue}>
          {DEMO_MODE ? "—" : "estimate…"}
        </Text>
      </View>

      <Pressable
        onPress={handleSend}
        disabled={!canSend}
        style={[styles.primaryBtn, !canSend && styles.disabledBtn]}
      >
        <Text style={styles.primaryBtnText}>
          {sending ? "Sending…" : "Send"}
        </Text>
      </Pressable>

      <Text style={styles.disclaimer}>
        {DEMO_MODE
          ? "Demo mode updates balances locally per wallet on this device. Connect real transfers when ready."
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
                {tx.from?.toLowerCase() === walletAddress?.toLowerCase()
                  ? "Sent"
                  : "Received"}{" "}
                {fmt(tx.amount)} ESC
              </Text>
              <Text style={styles.txMeta}>
                to {trimAddr(tx.to, 8)} •{" "}
                {new Date(tx.timestamp).toLocaleString()}
              </Text>
              {tx.category ? (
                <Text style={styles.txCategory}>
                  Category: {tx.category}
                </Text>
              ) : null}
              {tx.service ? (
                <Text style={styles.txService}>“{tx.service}”</Text>
              ) : null}
              {tx.fromBookingId ? (
                <Text style={styles.txBooking}>
                  From booking #{tx.fromBookingId}
                </Text>
              ) : null}
            </View>
            <View
              style={[
                styles.statusPill,
                tx.status === "confirmed"
                  ? styles.ok
                  : tx.status === "pending"
                  ? styles.warn
                  : styles.idle,
              ]}
            >
              <Text style={styles.pillText}>
                {tx.status?.toUpperCase() || "STATUS"}
              </Text>
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

      <Animated.View
        style={[styles.container, { transform: [{ translateY: floatY }] }]}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={THEME.accentGold}
            />
          }
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title}>Wallet</Text>
          <Text style={styles.subtitle}>
            Hold and move value across the neighborhood.
          </Text>

          <BalanceBlock />
          <SendBlock />
          <ActivityBlock />

          {loading && (
            <ActivityIndicator
              size="large"
              color={THEME.accentOrange}
              style={{ marginTop: 10 }}
            />
          )}
          <Text style={styles.footer}>America/Chicago</Text>

          {/* DEV ONLY: reset demo ledger */}
          <Pressable
            onPress={resetDemoLedger}
            style={[styles.smallBtn, { alignSelf: "center", marginTop: 8 }]}
          >
            <Text style={styles.smallBtnText}>Reset Demo Ledger</Text>
          </Pressable>
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
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
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
  balanceTicker: {
    color: THEME.accentGold,
    fontWeight: "800",
    marginLeft: 6,
    marginBottom: 4,
  },

  inputLabel: {
    color: "#e1e1e6",
    fontSize: 12,
    marginTop: 4,
    marginBottom: 6,
    paddingLeft: 4,
  },
  hint: {
    color: "#9a9aa1",
    fontSize: 12,
    marginTop: -4,
    marginBottom: 6,
    paddingLeft: 4,
  },
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

  bookingBanner: {
    backgroundColor: "#1b2a4b",
    borderRadius: 10,
    padding: 8,
    marginTop: 8,
    marginBottom: 6,
    borderColor: "#22355f",
    borderWidth: 1,
    color: "#cfe0ff",
    fontSize: 12,
  },

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
  resultWallet: {
    color: THEME.accentGold,
    marginLeft: 10,
    fontSize: 12,
    fontWeight: "700",
  },

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

  feeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
  },
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
  primaryBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
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
  txCategory: {
    color: "#cfe0ff",
    fontSize: 12,
    marginTop: 2,
    fontWeight: "800",
  },
  txService: {
    color: "#cfcfcf",
    fontSize: 12,
    marginTop: 2,
    fontStyle: "italic",
  },
  txBooking: { color: "#9a9aa1", fontSize: 11, marginTop: 2 },

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
  pillText: {
    color: "#DDD",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.5,
  },

  disclaimer: {
    color: "#9a9aa1",
    fontSize: 11,
    marginTop: 8,
  },

  footer: {
    color: "#7a7a7a",
    textAlign: "center",
    marginTop: 14,
    fontSize: 12,
  },
});

export default WalletScreen;
