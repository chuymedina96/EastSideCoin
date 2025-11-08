// screens/BookingListScreen.js
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  RefreshControl,
  ActivityIndicator,
  Alert,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../utils/api"; // same wrapper you use in ServicesScreen

const THEME = {
  bg: "#101012",
  card: "#1b1b1f",
  border: "#2a2a2e",
  text: "#EEE",
  subtext: "#cfcfcf",
  subtle: "#9a9aa1",
  accentGold: "#FFD700",
  accentOrange: "#FF4500",
  green: "#20c997",
  red: "#ff6b6b",
  blue: "#3ea0ff",
  slate: "#2d2d2f",
};

const Roles = ["All", "Provider", "Client"];
const StatusChips = ["All", "pending", "confirmed", "completed", "cancelled", "rejected"];
const Segments = ["Upcoming", "Past"];

// ---------- helpers ----------
const isPast = (startISO) => {
  try {
    return new Date(startISO).getTime() < Date.now();
  } catch {
    return false;
  }
};

// determine which actions to show for the authed user
function actionsFor(meId, booking) {
  const mineAsProvider = meId === booking?.provider?.id;
  const mineAsClient = meId === booking?.client?.id;
  const s = booking?.status;

  const act = [];
  if (s === "pending") {
    if (mineAsProvider) {
      act.push("Confirm", "Reject");
    }
    if (mineAsClient || mineAsProvider) {
      act.push("Cancel");
    }
  } else if (s === "confirmed") {
    if (mineAsProvider) {
      act.push("Complete");
    }
    if (mineAsClient || mineAsProvider) {
      act.push("Cancel");
    }
  }
  // completed/cancelled/rejected => no actions
  return act;
}

const statusPillStyle = (status) => {
  switch (status) {
    case "pending":
      return { borderColor: THEME.accentGold, color: THEME.accentGold };
    case "confirmed":
      return { borderColor: THEME.blue, color: THEME.blue };
    case "completed":
      return { borderColor: THEME.green, color: THEME.green };
    case "cancelled":
    case "rejected":
      return { borderColor: THEME.red, color: THEME.red };
    default:
      return { borderColor: THEME.subtle, color: THEME.subtle };
  }
};

const fmtTime = (iso) => {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
};

// ---------- component ----------
const BookingListScreen = ({ navigation, route }) => {
  // if you pass meId via route params, great; otherwise rely on your auth context if you prefer
  const meId = route?.params?.meId || 0;

  const [role, setRole] = useState(Roles[0]); // All
  const [status, setStatus] = useState(StatusChips[0]); // All
  const [segment, setSegment] = useState(Segments[0]); // Upcoming

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [nextPage, setNextPage] = useState(null);
  const [error, setError] = useState("");

  const abortRef = useRef(null);

  const serverRole = useMemo(() => {
    if (role === "Provider") return "provider";
    if (role === "Client") return "client";
    return "all";
  }, [role]);

  const serverStatus = useMemo(() => (status === "All" ? "" : status), [status]);

  const filterSegment = useCallback(
    (list) => {
      if (!Array.isArray(list)) return [];
      if (segment === "Upcoming") return list.filter((b) => !isPast(b.start_at));
      return list.filter((b) => isPast(b.start_at));
    },
    [segment]
  );

  const resetAndLoad = useCallback(async () => {
    setLoading(true);
    setItems([]);
    setPage(1);
    setNextPage(null);
    setError("");
    await fetchPage(1, true);
  }, [serverRole, serverStatus, segment]);

  const fetchPage = useCallback(
    async (p = 1, replace = false) => {
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const params = { role: serverRole, page: p, limit: 25 };
      if (serverStatus) params.status = serverStatus;

      try {
        const res = await api.get("/bookings/", { params, signal: ctrl.signal });
        const results = Array.isArray(res?.results) ? res.results : Array.isArray(res) ? res : [];
        const filtered = filterSegment(results);
        const merged = replace ? filtered : [...items, ...filtered];

        setItems(merged);
        setNextPage(res?.next_page || null);
        setPage(p);
      } catch (e) {
        if (e.name === "CanceledError" || e.name === "AbortError") return;
        setError("Could not load bookings right now.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [serverRole, serverStatus, filterSegment, items]
  );

  useEffect(() => {
    resetAndLoad();
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverRole, serverStatus, segment]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await resetAndLoad();
  }, [resetAndLoad]);

  const loadMore = useCallback(async () => {
    if (!nextPage || loading) return;
    await fetchPage(page + 1, false);
  }, [nextPage, loading, page, fetchPage]);

  // ----- actions -----
  const postAction = async (id, action) => {
    const endpoint = {
      Confirm: `/bookings/${id}/confirm/`,
      Reject: `/bookings/${id}/reject/`,
      Cancel: `/bookings/${id}/cancel/`,
      Complete: `/bookings/${id}/complete/`,
    }[action];

    if (!endpoint) return;

    // optimistic: if it fails, refresh
    const previous = items.slice();
    try {
      // optimistic transform
      const nextItems = items.map((b) => {
        if (b.id !== id) return b;
        const now = new Date().toISOString();
        if (action === "Confirm") return { ...b, status: "confirmed", updated_at: now };
        if (action === "Reject") return { ...b, status: "rejected", updated_at: now };
        if (action === "Cancel") return { ...b, status: "cancelled", updated_at: now, cancelled_at: now };
        if (action === "Complete") return { ...b, status: "completed", updated_at: now, completed_at: now };
        return b;
      });
      setItems(nextItems);

      await api.post(endpoint, { body: {} });
    } catch (e) {
      setItems(previous);
      Alert.alert("Action failed", "Please try again.");
    }
  };

  const confirmAction = (b, action) => {
    let msg = "";
    if (action === "Confirm") msg = "Confirm this booking?";
    if (action === "Reject") msg = "Reject this booking request?";
    if (action === "Cancel") msg = "Cancel this booking?";
    if (action === "Complete") msg = "Mark this booking as completed?";
    Alert.alert(action, msg, [
      { text: "No", style: "cancel" },
      { text: "Yes", style: "destructive", onPress: () => postAction(b.id, action) },
    ]);
  };

  // ----- UI -----
  const Header = () => (
    <View style={styles.header}>
      <Text style={styles.title}>Bookings</Text>
      <Text style={styles.subtitle}>Manage your service appointments.</Text>
    </View>
  );

  const SegmentBar = () => (
    <View style={styles.segmentBar}>
      {Segments.map((s) => {
        const active = s === segment;
        return (
          <Pressable
            key={s}
            onPress={() => setSegment(s)}
            style={[styles.segmentChip, active && styles.segmentChipActive]}
          >
            <Text style={[styles.segmentChipText, active && styles.segmentChipTextActive]}>{s}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  const RoleBar = () => (
    <View style={styles.roleBar}>
      {Roles.map((r) => {
        const active = r === role;
        return (
          <Pressable
            key={r}
            onPress={() => setRole(r)}
            style={[styles.roleChip, active && styles.roleChipActive]}
          >
            <Text style={[styles.roleChipText, active && styles.roleChipTextActive]}>{r}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  const StatusChipsRow = () => (
    <View style={styles.statusRow}>
      {StatusChips.map((s) => {
        const active = s === status;
        return (
          <Pressable
            key={s}
            onPress={() => setStatus(s)}
            style={[styles.statusChip, active && styles.statusChipActive]}
          >
            <Text style={[styles.statusChipText, active && styles.statusChipTextActive]}>{s}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  const Empty = () => (
    <View style={styles.emptyWrap}>
      <Text style={styles.emptyTitle}>No bookings</Text>
      <Text style={styles.emptyText}>
        {segment === "Upcoming" ? "You have no upcoming bookings." : "You have no past bookings."}
      </Text>
    </View>
  );

  const Footer = () =>
    loading && items.length === 0 ? null : nextPage ? (
      <View style={{ paddingVertical: 16 }}>
        <ActivityIndicator color={THEME.accentGold} />
      </View>
    ) : (
      <View style={{ height: 20 }} />
    );

  const BookingCard = ({ booking }) => {
    const sStyle = statusPillStyle(booking.status);
    const acts = actionsFor(meId, booking);

    const targetUser =
      meId === booking.provider.id ? booking.client : booking.provider;
    const targetName = targetUser?.first_name || targetUser?.last_name
      ? `${targetUser?.first_name || ""} ${targetUser?.last_name || ""}`.trim()
      : targetUser?.email || "Neighbor";

    return (
      <Pressable
        style={({ pressed }) => [styles.card, pressed && { opacity: 0.97 }]}
        onPress={() => navigation?.navigate?.("BookingDetail", { id: booking.id })}
      >
        <View style={styles.cardTopRow}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {booking.service?.title || "Service"}
          </Text>
          <Text style={[styles.statusPill, { borderColor: sStyle.borderColor, color: sStyle.color }]}>
            {booking.status}
          </Text>
        </View>

        <Text style={styles.subline} numberOfLines={1}>
          with {targetName} • {booking.service?.category || "Other"}
        </Text>

        <Text style={styles.timeText}>
          {fmtTime(booking.start_at)} → {fmtTime(booking.end_at)}
        </Text>

        <View style={styles.cardBottomRow}>
          <Text style={styles.priceText}>
            {(booking.price_snapshot ?? 0).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}{" "}
            ESC
          </Text>

          <View style={styles.actionsRow}>
            {acts.map((a) => (
              <Pressable
                key={a}
                onPress={() => confirmAction(booking, a)}
                style={({ pressed }) => [
                  styles.actionBtn,
                  pressed && { transform: [{ scale: 0.98 }] },
                  a === "Cancel" && styles.actionBtnGhost,
                  a === "Reject" && styles.actionBtnGhost,
                  a === "Confirm" && styles.actionBtnPrimary,
                  a === "Complete" && styles.actionBtnSuccess,
                ]}
              >
                <Text style={styles.actionBtnText}>{a}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={styles.safe}>
      <FlatList
        data={items}
        keyExtractor={(b) => String(b.id)}
        renderItem={({ item }) => <BookingCard booking={item} />}
        ListHeaderComponent={
          <>
            <Header />
            <SegmentBar />
            <RoleBar />
            <StatusChipsRow />
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
          </>
        }
        ListEmptyComponent={!loading ? <Empty /> : null}
        ListFooterComponent={<Footer />}
        contentContainerStyle={styles.listContent}
        onEndReachedThreshold={0.4}
        onEndReached={loadMore}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={THEME.accentGold} />
        }
      />

      {loading && items.length === 0 ? (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color={THEME.accentGold} />
        </View>
      ) : null}
    </SafeAreaView>
  );
};

export default BookingListScreen;

// ---------- styles ----------
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: THEME.bg },
  listContent: { paddingHorizontal: 16, paddingBottom: 28 },

  header: { marginTop: 8, marginBottom: 4 },
  title: { color: THEME.accentGold, fontSize: 24, fontWeight: "800" },
  subtitle: { color: THEME.subtext, marginTop: 6 },

  segmentBar: { flexDirection: "row", gap: 8, marginTop: 10 },
  segmentChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: THEME.border,
    backgroundColor: "#1f2026",
  },
  segmentChipActive: { backgroundColor: "#1b2a4b", borderColor: "#22355f" },
  segmentChipText: { color: THEME.subtext, fontWeight: "700" },
  segmentChipTextActive: { color: "#cfe0ff", fontWeight: "800" },

  roleBar: { flexDirection: "row", gap: 8, marginTop: 10 },
  roleChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: THEME.border,
    backgroundColor: "#1f2026",
  },
  roleChipActive: { backgroundColor: "#2a1f1f", borderColor: "#4a2b22" },
  roleChipText: { color: THEME.subtext, fontWeight: "700" },
  roleChipTextActive: { color: "#ffd7c7", fontWeight: "800" },

  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10, marginBottom: 6 },
  statusChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: THEME.border,
    backgroundColor: "#1f2026",
  },
  statusChipActive: { backgroundColor: "#1b2a4b", borderColor: "#22355f" },
  statusChipText: { color: THEME.subtext, fontWeight: "700", fontSize: 12 },
  statusChipTextActive: { color: "#cfe0ff", fontWeight: "800", fontSize: 12 },

  errorText: { color: THEME.red, marginTop: 8 },

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
  cardTitle: { color: THEME.text, fontSize: 16, fontWeight: "800", maxWidth: "66%" },
  statusPill: {
    paddingHorizontal: 10,
    paddingVertical: Platform.select({ ios: 4, android: 2, default: 3 }),
    borderRadius: 999,
    borderWidth: 1,
    textTransform: "capitalize",
    fontWeight: "900",
    fontSize: 12,
  },
  subline: { color: THEME.subtext, fontSize: 12, marginTop: 6 },
  timeText: { color: THEME.text, marginTop: 8, fontWeight: "700" },
  cardBottomRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10 },
  priceText: { color: THEME.accentGold, fontWeight: "900", fontSize: 16 },

  actionsRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  actionBtn: {
    backgroundColor: THEME.slate,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "#3a3a3f",
  },
  actionBtnPrimary: {
    backgroundColor: THEME.accentOrange,
    borderColor: THEME.accentOrange,
  },
  actionBtnSuccess: {
    backgroundColor: "#1f3b2a",
    borderColor: "#2c6e49",
  },
  actionBtnGhost: {
    backgroundColor: "#23242c",
    borderColor: "#3a3a3f",
  },
  actionBtnText: { color: "#fff", fontWeight: "800", fontSize: 12 },

  emptyWrap: { alignItems: "center", paddingVertical: 48 },
  emptyTitle: { color: THEME.text, fontSize: 16, fontWeight: "800" },
  emptyText: { color: THEME.subtext, marginTop: 6 },

  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
});
