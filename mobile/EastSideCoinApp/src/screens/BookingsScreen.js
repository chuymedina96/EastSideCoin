// screens/BookingsScreen.js
import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  Pressable,
  Alert,
  Platform,
  KeyboardAvoidingView,
  Modal,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRoute } from "@react-navigation/native";
import { AuthContext } from "../context/AuthProvider";
import {
  api,
  listBookings,
  confirmBooking,
  rejectBooking,
  cancelBookingAction,
  completeBooking,
} from "../utils/api";
import { API_URL } from "../config";
import avatarPlaceholder from "../../assets/avatar-placeholder.png";

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
const StatusChips = [
  "All",
  "pending",
  "confirmed",
  "completed",
  "cancelled",
  "rejected",
];
const Segments = ["Upcoming", "Past"];

const toArray = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.bookings)) return data.bookings;
  return [];
};

function resolveAvatarUri(userLike, fallback) {
  const raw = userLike?.avatar_url || fallback || "";
  if (!raw) return null;
  const lower = String(raw).toLowerCase();
  const isAbsolute =
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("data:") ||
    lower.startsWith("file:") ||
    lower.startsWith("content:");
  const base = isAbsolute
    ? raw
    : `${API_URL.replace(/\/+$/, "")}/${String(raw).replace(/^\/+/, "")}`;
  const ts =
    userLike?.avatar_updated_at ||
    userLike?.updated_at ||
    userLike?.profile_updated_at ||
    Date.now();
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}t=${encodeURIComponent(String(ts))}`;
}

// local-day helper from ISO string
const localDayFromISO = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const isoDay = (d) => {
  const dd = new Date(d);
  dd.setHours(0, 0, 0, 0);
  return dd.toISOString().slice(0, 10);
};

const startOfMonthISO = (date) =>
  isoDay(new Date(date.getFullYear(), date.getMonth(), 1));
const endOfMonthISO = (date) =>
  isoDay(new Date(date.getFullYear(), date.getMonth() + 1, 0));

const BookingsScreen = ({ navigation }) => {
  const route = useRoute();
  const { user, accessToken } = useContext(AuthContext);
  const meId = user?.id ?? 0;

  const imageHeaders = useMemo(() => {
    if (!accessToken) return undefined;
    return { Authorization: `Bearer ${accessToken}` };
  }, [accessToken]);

  // filters
  const [bkSegment, setBkSegment] = useState(Segments[0]);
  const [bkRole, setBkRole] = useState(Roles[0]);
  const [bkStatus, setBkStatus] = useState(StatusChips[0]);
  const [bkDayISO, setBkDayISO] = useState(""); // selected day filter (YYYY-MM-DD)

  // state
  const [bkItems, setBkItems] = useState([]);
  const [bkLoading, setBkLoading] = useState(false);
  const [bkRefreshing, setBkRefreshing] = useState(false);
  const [bkError, setBkError] = useState("");
  const [bkPage, setBkPage] = useState(1);
  const [bkNextPage, setBkNextPage] = useState(null);
  const bkAbortRef = useRef(null);

  // calendar-day availability (dots) for Bookings pane month view
  const [bkMonthAvailability, setBkMonthAvailability] = useState({}); // { 'YYYY-MM-DD': count }

  const serverRole = useMemo(() => {
    if (bkRole === "Provider") return "provider";
    if (bkRole === "Client") return "client";
    return "all";
  }, [bkRole]);

  const serverStatus = useMemo(
    () => (bkStatus === "All" ? "" : bkStatus),
    [bkStatus]
  );

  const isPast = (startISO) => {
    try {
      return new Date(startISO).getTime() < Date.now();
    } catch {
      return false;
    }
  };

  const filterBySegment = useCallback(
    (list) =>
      bkSegment === "Upcoming"
        ? list.filter((b) => !isPast(b.start_at))
        : list.filter((b) => isPast(b.start_at)),
    [bkSegment]
  );

  const filterByDay = useCallback(
    (list) => {
      if (!bkDayISO) return list;
      return list.filter((b) => localDayFromISO(b.start_at) === bkDayISO);
    },
    [bkDayISO]
  );

  const fmtTime = (iso) => {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    } catch {
      return iso;
    }
  };

  const fmtTimeOnly = (iso) => {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    } catch {
      return iso;
    }
  };

  // ---------- DEMO PAYMENT RECEIPTS ----------

  const applyDemoReceipt = useCallback((bookingId, tx) => {
    if (!bookingId || !tx) return;
    setBkItems((prev) =>
      prev.map((b) =>
        String(b.id) === String(bookingId)
          ? {
              ...b,
              paid_demo: true,
              last_payment_demo: {
                ...tx,
                timestamp: tx.timestamp || new Date().toISOString(),
              },
            }
          : b
      )
    );
  }, []);

  // Listen for navigation params from Wallet: { paidBookingId, paidTx }
  useEffect(() => {
    const paidId = route?.params?.paidBookingId;
    const paidTx = route?.params?.paidTx;
    if (!paidId || !paidTx) return;

    applyDemoReceipt(paidId, paidTx);

    // Clear params so it doesn't re-apply on every re-focus
    try {
      navigation?.setParams?.({
        ...route.params,
        paidBookingId: undefined,
        paidTx: undefined,
      });
    } catch {}
  }, [
    route?.params?.paidBookingId,
    route?.params?.paidTx,
    route?.params,
    navigation,
    applyDemoReceipt,
  ]);

  // start payment flow for a completed booking
  const startPaymentForBooking = useCallback(
    (booking) => {
      if (!booking) return;
      const mineAsProvider = String(meId) === String(booking?.provider?.id);
      const otherUser = mineAsProvider ? booking?.client : booking?.provider;

      const otherName =
        (otherUser?.first_name || otherUser?.last_name)
          ? `${otherUser?.first_name || ""} ${
              otherUser?.last_name || ""
            }`.trim()
          : otherUser?.email || "Neighbor";

      const recipientWallet = otherUser?.wallet_address || ""; // may be empty if backend doesn’t expose it yet

      const note = `${
        booking?.service?.title || "Service"
      } on ${fmtTime(booking?.start_at)}`;

      const category = booking?.service?.category || "General";
      const amount =
        booking?.price_snapshot ?? booking?.service?.price ?? 0;

      navigation?.navigate?.("Wallet", {
        fromBookingId: booking.id,
        presetNote: note,
        presetAmount: amount,
        presetCategory: category,
        presetToAddress: recipientWallet,
        presetRecipientLabel: otherName,
      });
    },
    [meId, navigation, fmtTime]
  );

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

  const actionsFor = (booking) => {
    const mineAsProvider = String(meId) === String(booking?.provider?.id);
    const mineAsClient = String(meId) === String(booking?.client?.id);
    const s = booking?.status;
    const alreadyPaid = booking?.paid_demo || !!booking?.last_payment_demo;
    const act = [];

    if (s === "pending") {
      if (mineAsProvider) act.push("Confirm", "Reject");
      if (mineAsClient || mineAsProvider) act.push("Cancel");
    } else if (s === "confirmed") {
      if (mineAsProvider) act.push("Complete");
      if (mineAsClient || mineAsProvider) act.push("Cancel");
    } else if (s === "completed") {
      // After completion:
      // - client can Pay if not yet paid (demo)
      // - once there's a last_payment_demo, both sides can view the receipt
      if (mineAsClient && !alreadyPaid) act.push("Pay");
      if (alreadyPaid && (mineAsClient || mineAsProvider)) act.push("Receipt");
    }
    return act;
  };

  const postAction = async (id, action) => {
    // "Pay" and "Receipt" are handled locally (Wallet / modal), no server mutation
    if (action === "Pay" || action === "Receipt") return;

    const call = {
      Confirm: () => confirmBooking(id),
      Reject: () => rejectBooking(id),
      Cancel: () => cancelBookingAction(id),
      Complete: () => completeBooking(id),
    }[action];

    if (!call) return;
    const previous = bkItems.slice();
    try {
      const now = new Date().toISOString();
      const next = bkItems.map((b) => {
        if (b.id !== id) return b;
        if (action === "Confirm")
          return { ...b, status: "confirmed", updated_at: now };
        if (action === "Reject")
          return { ...b, status: "rejected", updated_at: now };
        if (action === "Cancel")
          return { ...b, status: "cancelled", updated_at: now, cancelled_at: now };
        if (action === "Complete")
          return { ...b, status: "completed", updated_at: now, completed_at: now };
        return b;
      });
      setBkItems(next);
      await call();
      refreshMonthAvailability(monthCursor);
    } catch (e) {
      setBkItems(previous);
      Alert.alert("Action failed", "Please try again.");
    }
  };

  // ---------- Booking Detail Modal ----------
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailBk, setDetailBk] = useState(null);

  const openDetail = (b) => {
    setDetailBk(b);
    setDetailOpen(true);
  };
  const closeDetail = () => {
    setDetailOpen(false);
    setDetailBk(null);
  };

  const confirmBkAction = (b, action) => {
    // Special handling: Pay → go to Wallet, Receipt → open detail
    if (action === "Pay") {
      startPaymentForBooking(b);
      return;
    }
    if (action === "Receipt") {
      openDetail(b);
      return;
    }

    let msg = {
      Confirm: "Confirm this booking?",
      Reject: "Reject this booking request?",
      Cancel: "Cancel this booking?",
      Complete: "Mark this booking as completed?",
    }[action];
    Alert.alert(action, msg, [
      { text: "No", style: "cancel" },
      { text: "Yes", style: "destructive", onPress: () => postAction(b.id, action) },
    ]);
  };

  const openProviderProfile = useCallback(
    (userId) => {
      if (!userId) return;
      try {
        if (meId && String(userId) === String(meId)) {
          navigation?.navigate?.("Profile");
          return;
        }
      } catch {}

      try {
        navigation?.navigate?.("UserProfile", { userId });
        return;
      } catch {}
      try {
        navigation?.navigate?.("ProfileView", { userId });
        return;
      } catch {}
      try {
        navigation?.navigate?.("Profile", {
          screen: "UserProfile",
          params: { userId },
        });
        return;
      } catch {}
      Alert.alert(
        "Profile",
        "Couldn’t open the user’s profile. Add a 'UserProfile' route to your navigator."
      );
    },
    [navigation, meId]
  );

  const BookingCard = ({ item }) => {
    const sStyle = statusPillStyle(item.status);
    const acts = actionsFor(item);
    const mineAsProvider = String(meId) === String(item?.provider?.id);
    const targetUser = mineAsProvider ? item?.client : item?.provider;
    const targetName =
      targetUser?.first_name || targetUser?.last_name
        ? `${targetUser?.first_name || ""} ${
            targetUser?.last_name || ""
          }`.trim()
        : targetUser?.email || "Neighbor";

    const avatarUri = resolveAvatarUri(targetUser);
    const lastPay = item.last_payment_demo;

    return (
      <Pressable
        style={({ pressed }) => [styles.card, pressed && { opacity: 0.97 }]}
        onPress={() => openDetail(item)}
      >
        <View style={styles.cardTopRow}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {item.service?.title || "Service"}
          </Text>
          <Text
            style={[
              styles.statusPill,
              { borderColor: sStyle.borderColor, color: sStyle.color },
            ]}
          >
            {item.status}
          </Text>
        </View>

        <Pressable
          style={styles.ownerRow}
          onPress={() => openProviderProfile(targetUser?.id)}
        >
          <Image
            source={
              avatarUri
                ? { uri: avatarUri, headers: imageHeaders }
                : avatarPlaceholder
            }
            style={styles.avatarSm}
            resizeMode="cover"
          />
          <Text style={styles.owner} numberOfLines={1}>
            with <Text style={styles.ownerLink}>{targetName}</Text> •{" "}
            <Text style={styles.categoryText}>
              {item.service?.category || "Other"}
            </Text>
          </Text>
        </Pressable>

        <Text style={[styles.desc, { marginTop: 6 }]}>
          {fmtTime(item.start_at)} → {fmtTimeOnly(item.end_at)}
        </Text>

        {/* Demo receipt block */}
        {lastPay ? (
          <View style={styles.receiptBox}>
            <Text style={styles.receiptTitle}>Last payment (demo)</Text>
            <Text style={styles.receiptLine}>
              {`${(lastPay.amount ?? 0).toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 6,
              })} ESC • ${new Date(
                lastPay.timestamp
              ).toLocaleString()}`}
            </Text>
          </View>
        ) : null}

        <View className="cardFooter" style={styles.cardFooter}>
          <Text style={styles.price}>
            {(item.price_snapshot ?? 0).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}{" "}
            ESC
          </Text>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {acts.map((a) => (
              <Pressable
                key={a}
                onPress={() => confirmBkAction(item, a)}
                style={[
                  styles.actionBtn,
                  a === "Confirm" && styles.actionBtnPrimary,
                  a === "Complete" && styles.actionBtnSuccess,
                  a === "Pay" && styles.actionBtnPay,
                  a === "Receipt" && styles.actionBtnReceipt,
                ]}
              >
                <Text style={styles.actionBtnText}>
                  {a === "Receipt" ? "View receipt" : a}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </Pressable>
    );
  };

  /* ---------- Date Helpers & Calendars ---------- */
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const [stripAnchorDate, setStripAnchorDate] = useState(today);
  const makeDaysStrip = useCallback(
    (anchorDate) => {
      const start = new Date(anchorDate);
      start.setDate(start.getDate() - 7);
      start.setHours(0, 0, 0, 0);
      const arr = [];
      for (let i = 0; i < 21; i++) {
        const d = new Date(start.getTime() + i * 86400000);
        const dayIso = d.toISOString().slice(0, 10);
        arr.push({
          iso: dayIso,
          labelTop: d.toLocaleString(undefined, { weekday: "short" }),
          labelBottom: d.getDate(),
          isToday: d.toDateString() === today.toDateString(),
        });
      }
      return arr;
    },
    [today]
  );

  const [daysStrip, setDaysStrip] = useState(() => makeDaysStrip(today));

  useEffect(() => {
    if (bkDayISO) {
      const d = new Date(bkDayISO + "T00:00:00");
      setStripAnchorDate(d);
    }
  }, [bkDayISO]);

  const buildMonthInfo = useCallback(
    (cursor) => {
      const first = new Date(cursor);
      const year = first.getFullYear();
      const month = first.getMonth();
      const startWeekday = new Date(year, month, 1).getDay();
      const grid = [];
      let dayNum = 1 - startWeekday;
      for (let r = 0; r < 6; r++) {
        const row = [];
        for (let c = 0; c < 7; c++) {
          const cellDate = new Date(year, month, dayNum);
          const inMonth = cellDate.getMonth() === month;
          const iso = cellDate.toISOString().slice(0, 10);
          row.push({
            iso,
            inMonth,
            isToday: cellDate.toDateString() === today.toDateString(),
            label: cellDate.getDate(),
          });
          dayNum++;
        }
        grid.push(row);
      }
      const title = first.toLocaleString(undefined, {
        month: "long",
        year: "numeric",
      });
      return { grid, title, year, month };
    },
    [today]
  );

  const [monthCursor, setMonthCursor] = useState(() => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  });

  const monthInfo = useMemo(
    () => buildMonthInfo(monthCursor),
    [buildMonthInfo, monthCursor]
  );

  const gotoPrevMonth = () => {
    const d = new Date(monthCursor);
    d.setMonth(d.getMonth() - 1);
    setMonthCursor(d);
  };
  const gotoNextMonth = () => {
    const d = new Date(monthCursor);
    d.setMonth(d.getMonth() + 1);
    setMonthCursor(d);
  };

  useEffect(() => {
    setStripAnchorDate(new Date(monthCursor));
  }, [monthCursor]);

  useEffect(() => {
    setDaysStrip(makeDaysStrip(stripAnchorDate));
  }, [stripAnchorDate, makeDaysStrip]);

  const refreshMonthAvailability = useCallback(async (cursorDate) => {
    const startISO = startOfMonthISO(cursorDate);
    const endISO = endOfMonthISO(cursorDate);
    try {
      const params = {
        role: "all",
        from: `${startISO}T00:00:00`,
        to: `${endISO}T23:59:59`,
        limit: 500,
        page: 1,
      };
      const res = await api.get("/bookings/", { params });
      const list = toArray(res);
      const map = {};
      for (const b of list) {
        const day = localDayFromISO(b?.start_at);
        if (!day) continue;
        map[day] = (map[day] || 0) + 1;
      }
      setBkMonthAvailability(map);
    } catch {
      setBkMonthAvailability({});
    }
  }, []);

  const fetchBookings = useCallback(
    async (p = 1, replace = false) => {
      if (bkAbortRef.current) bkAbortRef.current.abort();
      const ctrl = new AbortController();
      bkAbortRef.current = ctrl;

      const params = { role: serverRole, page: p, limit: 50 };
      if (serverStatus) params.status = serverStatus;

      try {
        if (replace) setBkLoading(true);
        setBkError("");
        const res = await listBookings(params);
        const base = Array.isArray(res?.results)
          ? res.results
          : Array.isArray(res)
          ? res
          : [];

        let seg = filterBySegment(base);
        let filtered = filterByDay(seg);

        filtered = [...filtered].sort((a, b) => {
          const aT =
            new Date(a.start_at || a.start || "").getTime() || 0;
          const bT =
            new Date(b.start_at || b.start || "").getTime() || 0;
          return aT - bT;
        });

        const merged = replace ? filtered : [...bkItems, ...filtered];
        merged.sort((a, b) => {
          const aT =
            new Date(a.start_at || a.start || "").getTime() || 0;
          const bT =
            new Date(b.start_at || b.start || "").getTime() || 0;
          return aT - bT;
        });

        setBkItems(merged);
        setBkNextPage(res?.next_page || null);
        setBkPage(p);
      } catch (e) {
        if (e.name === "CanceledError" || e.name === "AbortError") return;
        setBkError("Could not load bookings right now.");
      } finally {
        setBkLoading(false);
        setBkRefreshing(false);
      }
    },
    [serverRole, serverStatus, filterBySegment, filterByDay, bkItems]
  );

  const fetchBookingsRef = useRef(fetchBookings);
  useEffect(() => {
    fetchBookingsRef.current = fetchBookings;
  }, [fetchBookings]);
  const fetchBookingsProxy = (...args) => fetchBookingsRef.current(...args);

  // load when filters or date change
  useEffect(() => {
    fetchBookingsProxy(1, true);
    refreshMonthAvailability(monthCursor);
    return () => {
      if (bkAbortRef.current) bkAbortRef.current.abort();
    };
  }, [
    serverRole,
    serverStatus,
    bkSegment,
    bkDayISO,
    monthCursor,
    refreshMonthAvailability,
  ]);

  useEffect(() => {
    if (navigation?.setOptions) {
      navigation.setOptions({ title: "Bookings" });
    }
  }, [navigation]);

  const bkLoadMore = useCallback(async () => {
    if (!bkNextPage || bkLoading) return;
    await fetchBookingsProxy(bkPage + 1, false);
  }, [bkNextPage, bkLoading, bkPage]);

  const onRefresh = useCallback(async () => {
    setBkRefreshing(true);
    await Promise.all([
      fetchBookingsProxy(1, true),
      refreshMonthAvailability(monthCursor),
    ]);
    setBkRefreshing(false);
  }, [fetchBookingsProxy, refreshMonthAvailability, monthCursor]);

  const CalendarStrip = () => (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginTop: 10 }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable
          onPress={() => setBkDayISO("")}
          style={[styles.dayChip, bkDayISO === "" && styles.dayChipActive]}
        >
          <Text
            style={[
              styles.dayChipTop,
              bkDayISO === "" && styles.dayChipTextActive,
            ]}
          >
            All
          </Text>
          <Text
            style={[
              styles.dayChipBottom,
              bkDayISO === "" && styles.dayChipTextActive,
            ]}
          >
            Dates
          </Text>
        </Pressable>
        {daysStrip.map((d) => {
          const active = bkDayISO === d.iso;
          return (
            <Pressable
              key={d.iso}
              onPress={() => setBkDayISO(d.iso)}
              style={[styles.dayChip, active && styles.dayChipActive]}
            >
              <Text
                style={[
                  styles.dayChipTop,
                  active && styles.dayChipTextActive,
                ]}
              >
                {d.isToday ? "Today" : d.labelTop}
              </Text>
              <Text
                style={[
                  styles.dayChipBottom,
                  active && styles.dayChipTextActive,
                ]}
              >
                {d.labelBottom}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );

  const MonthCalendar = () => (
    <View style={styles.monthWrap}>
      <View style={styles.monthHeader}>
        <Pressable onPress={gotoPrevMonth} style={styles.monthNavBtn}>
          <Text style={styles.monthNavText}>‹</Text>
        </Pressable>
        <Text style={styles.monthTitle}>{monthInfo.title}</Text>
        <Pressable onPress={gotoNextMonth} style={styles.monthNavBtn}>
          <Text style={styles.monthNavText}>›</Text>
        </Pressable>
      </View>

      <View style={styles.weekHeaderRow}>
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((w) => (
          <Text key={w} style={styles.weekHeaderText}>
            {w}
          </Text>
        ))}
      </View>

      {monthInfo.grid.map((row, idx) => (
        <View key={idx} style={styles.weekRow}>
          {row.map((cell) => {
            const active = bkDayISO === cell.iso;
            const hasBookings = bkMonthAvailability[cell.iso] > 0;
            return (
              <Pressable
                key={cell.iso}
                onPress={() => setBkDayISO(cell.iso)}
                style={[
                  styles.dayCell,
                  !cell.inMonth && { opacity: 0.4 },
                  active && styles.dayCellActive,
                  cell.isToday && !active && styles.dayCellToday,
                ]}
              >
                <Text
                  style={[
                    styles.dayCellText,
                    active && styles.dayCellTextActive,
                    cell.isToday && !active && styles.dayCellTextToday,
                  ]}
                >
                  {cell.label}
                </Text>
                {hasBookings ? <View style={styles.dot} /> : null}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );

  const Header = () => (
    <View style={styles.header}>
      <Text style={styles.title}>Bookings</Text>
      <Text style={styles.subtitle}>
        See all your upcoming and past bookings.
      </Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe}>
      <FlatList
        data={bkItems}
        keyExtractor={(b) => String(b.id)}
        renderItem={({ item }) => <BookingCard item={item} />}
        ListHeaderComponent={
          <>
            <Header />

            {/* Filters */}
            <View style={styles.segmentBar}>
              {Segments.map((s) => {
                const active = s === bkSegment;
                return (
                  <Pressable
                    key={s}
                    onPress={() => setBkSegment(s)}
                    style={[
                      styles.segmentChip,
                      active && styles.segmentChipActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.segmentChipText,
                        active && styles.segmentChipTextActive,
                      ]}
                    >
                      {s}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.roleBar}>
              {Roles.map((r) => {
                const active = r === bkRole;
                return (
                  <Pressable
                    key={r}
                    onPress={() => setBkRole(r)}
                    style={[styles.roleChip, active && styles.roleChipActive]}
                  >
                    <Text
                      style={[
                        styles.roleChipText,
                        active && styles.roleChipTextActive,
                      ]}
                    >
                      {r}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.statusRow}>
              {StatusChips.map((s) => {
                const active = s === bkStatus;
                return (
                  <Pressable
                    key={s}
                    onPress={() => setBkStatus(s)}
                    style={[
                      styles.statusChip,
                      active && styles.statusChipActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusChipText,
                        active && styles.statusChipTextActive,
                      ]}
                    >
                      {s}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <MonthCalendar />
            <CalendarStrip />

            {bkError ? <Text style={styles.errorText}>{bkError}</Text> : null}
          </>
        }
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          !bkLoading ? (
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyTitle}>No bookings</Text>
              <Text style={styles.emptyText}>
                {bkSegment === "Upcoming"
                  ? "You have no upcoming bookings."
                  : "You have no past bookings."}
              </Text>
            </View>
          ) : null
        }
        onEndReachedThreshold={0.4}
        onEndReached={bkLoadMore}
        ListFooterComponent={
          bkNextPage ? (
            <View style={{ paddingVertical: 16 }}>
              <ActivityIndicator color={THEME.accentGold} />
            </View>
          ) : (
            <View style={{ height: 10 }} />
          )
        }
        refreshControl={
          <RefreshControl
            refreshing={bkRefreshing}
            onRefresh={onRefresh}
            tintColor={THEME.accentGold}
          />
        }
        keyboardShouldPersistTaps="handled"
      />

      {bkLoading && bkItems.length === 0 ? (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color={THEME.accentGold} />
        </View>
      ) : null}

      {/* Booking Detail Modal */}
      <Modal
        visible={detailOpen}
        transparent
        animationType="fade"
        onRequestClose={closeDetail}
      >
        <KeyboardAvoidingView
          behavior={Platform.select({ ios: "padding", android: undefined })}
          style={styles.modalBackdrop}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Booking Details</Text>
            {detailBk ? (
              <View>
                <Text style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Service:</Text>{" "}
                  {detailBk?.service?.title || "Service"}
                </Text>
                <Text style={styles.detailRow}>
                  <Text style={styles.detailLabel}>When:</Text>{" "}
                  {fmtTime(detailBk?.start_at)} →{" "}
                  {fmtTimeOnly(detailBk?.end_at)}
                </Text>
                <Text style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Status:</Text>{" "}
                  <Text
                    style={{
                      color: statusPillStyle(detailBk?.status).color,
                    }}
                  >
                    {detailBk?.status}
                  </Text>
                </Text>
                <Text style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Client:</Text>{" "}
                  {detailBk?.client?.email || "—"}
                </Text>
                <Text style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Provider:</Text>{" "}
                  <Text
                    style={styles.ownerLink}
                    onPress={() => {
                      closeDetail();
                      openProviderProfile(detailBk?.provider?.id);
                    }}
                  >
                    {detailBk?.provider?.email || "—"}
                  </Text>
                </Text>
                {detailBk?.note ? (
                  <View style={{ marginTop: 8 }}>
                    <Text style={styles.detailLabel}>Note from client</Text>
                    <Text style={styles.desc}>{detailBk.note}</Text>
                  </View>
                ) : null}

                {detailBk?.last_payment_demo ? (
                  <View style={[styles.receiptBox, { marginTop: 10 }]}>
                    <Text style={styles.receiptTitle}>Last payment (demo)</Text>
                    <Text style={styles.receiptLine}>
                      {`${(detailBk.last_payment_demo.amount ?? 0).toLocaleString(
                        undefined,
                        {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 6,
                        }
                      )} ESC • ${new Date(
                        detailBk.last_payment_demo.timestamp
                      ).toLocaleString()}`}
                    </Text>
                  </View>
                ) : null}

                <View
                  style={[
                    styles.row,
                    { gap: 8, marginTop: 16, flexWrap: "wrap" },
                  ]}
                >
                  {actionsFor(detailBk)
                    .filter((a) => a !== "Receipt") // already in this modal
                    .map((a) => (
                      <Pressable
                        key={a}
                        onPress={() => {
                          closeDetail();
                          confirmBkAction(detailBk, a);
                        }}
                        style={[
                          styles.primaryBtn,
                          a === "Confirm" && {
                            backgroundColor: THEME.accentOrange,
                          },
                          a === "Complete" && { backgroundColor: "#1f3b2a" },
                          a === "Pay" && { backgroundColor: "#1b2a4b" },
                        ]}
                      >
                        <Text style={styles.primaryBtnText}>{a}</Text>
                      </Pressable>
                    ))}
                  <Pressable onPress={closeDetail} style={styles.secondaryBtn}>
                    <Text style={styles.secondaryBtnText}>Close</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <ActivityIndicator color={THEME.accentGold} />
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
};

export default BookingsScreen;

const AVATAR_SM = 28;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: THEME.bg },
  listContent: { paddingHorizontal: 16, paddingBottom: 28 },

  header: { marginBottom: 8, marginTop: 8 },
  title: { color: THEME.accentGold, fontSize: 24, fontWeight: "800" },
  subtitle: { color: THEME.subtext, marginTop: 6 },

  segmentBar: { flexDirection: "row", gap: 8, marginTop: 6 },
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

  statusRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 10,
    marginBottom: 6,
  },
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

  dayChip: {
    width: 68,
    borderWidth: 1,
    borderColor: THEME.border,
    backgroundColor: "#1f2026",
    borderRadius: 12,
    paddingVertical: 8,
    alignItems: "center",
  },
  dayChipActive: { backgroundColor: "#1b2a4b", borderColor: "#22355f" },
  dayChipTop: { color: THEME.subtext, fontSize: 12, fontWeight: "700" },
  dayChipBottom: {
    color: THEME.text,
    fontSize: 16,
    fontWeight: "900",
    marginTop: 2,
  },
  dayChipTextActive: { color: "#cfe0ff" },

  monthWrap: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: THEME.border,
    backgroundColor: "#16171c",
    borderRadius: 12,
    padding: 10,
  },
  monthHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  monthTitle: { color: THEME.text, fontWeight: "900" },
  monthNavBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: "#1f2026",
    borderWidth: 1,
    borderColor: THEME.border,
    alignItems: "center",
    justifyContent: "center",
  },
  monthNavText: { color: THEME.text, fontWeight: "900", fontSize: 16 },
  weekHeaderRow: { flexDirection: "row", marginTop: 4, marginBottom: 4 },
  weekHeaderText: {
    flex: 1,
    textAlign: "center",
    color: THEME.subtle,
    fontSize: 12,
    fontWeight: "800",
  },
  weekRow: { flexDirection: "row", marginBottom: 6 },
  dayCell: {
    flex: 1,
    aspectRatio: 1.3,
    marginHorizontal: 2,
    borderRadius: 10,
    backgroundColor: "#1f2026",
    borderWidth: 1,
    borderColor: THEME.border,
    alignItems: "center",
    justifyContent: "center",
  },
  dayCellActive: { backgroundColor: "#1b2a4b", borderColor: "#22355f" },
  dayCellToday: { borderColor: THEME.accentGold },
  dayCellText: { color: THEME.subtext, fontWeight: "800" },
  dayCellTextActive: { color: "#cfe0ff" },
  dayCellTextToday: { color: THEME.accentGold },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: THEME.accentGold,
    marginTop: 4,
  },

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
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardTitle: {
    color: THEME.text,
    fontSize: 16,
    fontWeight: "800",
    maxWidth: "64%",
  },
  price: { color: THEME.accentGold, fontWeight: "900", fontSize: 16 },

  ownerRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  avatarSm: {
    width: AVATAR_SM,
    height: AVATAR_SM,
    borderRadius: AVATAR_SM / 2,
    borderWidth: 1,
    borderColor: "#2d2d33",
    backgroundColor: "#23242c",
  },
  owner: { color: "#b7b7bf", fontSize: 12, flexShrink: 1 },
  ownerLink: { color: "#cfe0ff", fontWeight: "800" },
  categoryText: { color: "#cfe0ff", fontWeight: "700" },

  desc: { color: THEME.subtext, marginTop: 8, lineHeight: 18 },

  receiptBox: {
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: "#181d26",
    borderWidth: 1,
    borderColor: "#22355f",
  },
  receiptTitle: {
    color: "#cfe0ff",
    fontWeight: "800",
    fontSize: 12,
    marginBottom: 2,
  },
  receiptLine: { color: THEME.subtext, fontSize: 12 },

  cardFooter: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },

  statusPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    fontSize: 12,
    fontWeight: "900",
    textTransform: "capitalize",
  },

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
  actionBtnSuccess: { backgroundColor: "#1f3b2a", borderColor: "#2c6e49" },
  actionBtnPay: { backgroundColor: "#1b2a4b", borderColor: "#22355f" },
  actionBtnReceipt: { backgroundColor: "#181d26", borderColor: "#22355f" },
  actionBtnText: { color: "#fff", fontWeight: "800", fontSize: 12 },

  emptyWrap: { alignItems: "center", paddingVertical: 48 },
  emptyTitle: { color: THEME.text, fontSize: 16, fontWeight: "800" },
  emptyText: { color: THEME.subtext, marginTop: 6 },

  errorText: { color: THEME.red, marginTop: 8 },

  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    padding: 16,
    justifyContent: "center",
  },
  modalCard: {
    width: "100%",
    maxWidth: 520,
    alignSelf: "center",
    backgroundColor: THEME.card,
    borderColor: THEME.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
  },
  modalTitle: {
    color: THEME.text,
    fontSize: 18,
    fontWeight: "900",
    marginBottom: 12,
    textAlign: "center",
  },

  row: { flexDirection: "row", alignItems: "center" },

  primaryBtn: {
    backgroundColor: THEME.accentOrange,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
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

  detailRow: { color: THEME.text, marginTop: 6 },
  detailLabel: { color: THEME.subtext, fontWeight: "800" },
});
