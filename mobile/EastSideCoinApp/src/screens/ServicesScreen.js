// screens/ServicesScreen.js
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
  Modal,
  KeyboardAvoidingView,
  ScrollView,
  Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import debounce from "lodash.debounce";
import { AuthContext } from "../context/AuthProvider";
import {
  api, // raw api for arbitrary GETs + abort + patch/put/delete
  listMyServices,
  listServiceCategories,
  createService,
  listBookings,
  confirmBooking,
  rejectBooking,
  cancelBookingAction,
  completeBooking,
  bookService,
} from "../utils/api";

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

const DEFAULT_CATEGORIES = ["All", "Barber", "Lawn Care", "Studio", "Tutoring", "Cleaning", "Other"];
const Tabs = { Browse: "Browse", Mine: "Mine", Bookings: "Bookings" };
const Roles = ["All", "Provider", "Client"];
const StatusChips = ["All", "pending", "confirmed", "completed", "cancelled", "rejected"];
const Segments = ["Upcoming", "Past"];

const toArray = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.services)) return data.services;
  return [];
};

const isoDay = (d) => {
  const dd = new Date(d);
  dd.setHours(0, 0, 0, 0);
  return dd.toISOString().slice(0, 10);
};
const startOfMonthISO = (date) => isoDay(new Date(date.getFullYear(), date.getMonth(), 1));
const endOfMonthISO = (date) => isoDay(new Date(date.getFullYear(), date.getMonth() + 1, 0));

/* ======================== MAIN ======================== */
const ServicesScreen = ({ navigation, route }) => {
  const insets = useSafeAreaInsets();
  const { user } = useContext(AuthContext);
  const meId = user?.id ?? route?.params?.meId ?? 0;

  // -------- UI/Query State --------
  const [tab, setTab] = useState(Tabs.Browse);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");

  // -------- Data/Load State (Services) --------
  const [browse, setBrowse] = useState([]);
  const [mine, setMine] = useState([]);
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [loading, setLoading] = useState(true);
  const [loadingMine, setLoadingMine] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  // -------- Create Modal State --------
  const [createOpen, setCreateOpen] = useState(false);
  const [cTitle, setCTitle] = useState("");
  const [cDesc, setCDesc] = useState("");
  const [cPrice, setCPrice] = useState("");
  const [cCategory, setCCategory] = useState("Other");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  // -------- Edit Modal State --------
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [eTitle, setETitle] = useState("");
  const [eDesc, setEDesc] = useState("");
  const [ePrice, setEPrice] = useState("");
  const [eCategory, setECategory] = useState("Other");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState("");

  // -------- Service Detail Modal --------
  const [svcDetailOpen, setSvcDetailOpen] = useState(false);
  const [svcDetailItem, setSvcDetailItem] = useState(null);

  // Category UI helpers (in create modal)
  const catScrollRef = useRef(null);
  const [catCanLeft, setCatCanLeft] = useState(false);
  const [catCanRight, setCatCanRight] = useState(false);
  const [catHintSeen, setCatHintSeen] = useState(false);
  const [catGridOpen, setCatGridOpen] = useState(false);

  // small float accent animation
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

  // Single in-flight controllers for browse + mine
  const abortBrowseRef = useRef(null);
  const abortMineRef = useRef(null);

  // -------- Fetch: Categories --------
  const loadCategories = useCallback(async () => {
    try {
      const serverCats = toArray(await listServiceCategories());
      const cleaned = serverCats
        .map((c) => (typeof c === "string" ? c : c?.name))
        .filter(Boolean);
      const uniq = Array.from(new Set(["All", ...cleaned, ...DEFAULT_CATEGORIES]));
      setCategories(uniq);
      setCategory((prev) => (uniq.includes(prev) ? prev : "All"));
    } catch {
      setCategories(DEFAULT_CATEGORIES);
    }
  }, []);

  // -------- Fetch: Browse (debounced, abortable) --------
  const doFetchBrowse = useCallback(
    debounce(async (q, cat) => {
      if (abortBrowseRef.current) abortBrowseRef.current.abort();
      const ctrl = new AbortController();
      abortBrowseRef.current = ctrl;

      try {
        setError("");
        const params = {};
        if (q && q.trim().length > 0) params.q = q.trim();
        if (cat && cat !== "All") params.category = cat;

        const payload = await api.get("/services/", { params, signal: ctrl.signal });
        setBrowse(toArray(payload));
      } catch (e) {
        if (e.name === "CanceledError" || e.name === "AbortError") return;
        setError("Could not load services right now.");
        setBrowse([]);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    }, 300),
    []
  );

  const loadBrowse = useCallback(async () => {
    setLoading(true);
    await doFetchBrowse(query, category);
  }, [doFetchBrowse, query, category]);

  // -------- Fetch: Mine --------
  const loadMine = useCallback(async () => {
    if (abortMineRef.current) abortMineRef.current.abort();
    const ctrl = new AbortController();
    abortMineRef.current = ctrl;

    try {
      setLoadingMine(true);
      const payload = await listMyServices({ signal: ctrl.signal });
      setMine(toArray(payload));
    } catch {
      // soft fail
    } finally {
      setLoadingMine(false);
    }
  }, []);

  // initial boot
  useEffect(() => {
    loadCategories();
    loadBrowse();
    loadMine();
    return () => {
      if (abortBrowseRef.current) abortBrowseRef.current.abort();
      if (abortMineRef.current) abortMineRef.current.abort();
      doFetchBrowse.cancel();
    };
  }, [loadCategories, loadBrowse, loadMine, doFetchBrowse]);

  // -------- Handlers --------
  const onChangeQuery = (t) => {
    setQuery(t);
    doFetchBrowse(t, category);
  };
  const onSelectCategory = (cat) => {
    setCategory(cat);
    doFetchBrowse(query, cat);
  };

  const reloadBookings = useCallback(
    async (force = false) => {
      if (tab !== Tabs.Bookings && !force) return;
      await fetchBookings(1, true);
    },
    [tab] // fetchBookings is ref-proxied below
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      loadBrowse(),
      loadMine(),
      tab === Tabs.Bookings ? reloadBookings(true) : Promise.resolve(),
      tab === Tabs.Bookings ? refreshMonthAvailability(monthCursor) : Promise.resolve(),
    ]);
    setRefreshing(false);
  }, [loadBrowse, loadMine, tab, reloadBookings, refreshMonthAvailability, monthCursor]);

  // ----- CREATE -----
  const openCreate = () => {
    setCTitle("");
    setCDesc("");
    setCPrice("");
    setCCategory(categories.find((c) => c !== "All") || "Other");
    setCreateError("");
    setCatHintSeen(false);
    setCreateOpen(true);
  };
  const closeCreate = () => {
    if (creating) return;
    setCreateOpen(false);
  };
  const validateCreate = () => {
    if (!cTitle.trim()) return "Please add a title.";
    if (!cDesc.trim()) return "Please add a short description.";
    const price = Number(cPrice);
    if (!Number.isFinite(price) || price < 0) return "Enter a valid non-negative price.";
    if (!cCategory || cCategory === "All") return "Select a category.";
    return null;
  };
  const handleCreate = async () => {
    const err = validateCreate();
    if (err) {
      setCreateError(err);
      return;
    }
    try {
      setCreating(true);
      setCreateError("");

      const payload = {
        title: cTitle.trim(),
        description: cDesc.trim(),
        price: Number(cPrice),
        category: cCategory,
      };

      const created = await createService(payload);

      const normalized = {
        id: created?.id ?? `${Date.now()}`,
        ...payload,
        user: created?.user || created?.owner || null,
      };
      setMine((cur) => [normalized, ...cur]);

      const matchesCat = category === "All" || cCategory.toLowerCase() === category.toLowerCase();
      const qLower = query.trim().toLowerCase();
      const matchesQuery =
        !qLower ||
        payload.title.toLowerCase().includes(qLower) ||
        payload.description.toLowerCase().includes(qLower);
      if (matchesCat && matchesQuery) setBrowse((cur) => [normalized, ...cur]);

      setCreateOpen(false);
    } catch (e) {
      setCreateError(e?.data?.error || "Could not create service right now.");
    } finally {
      setCreating(false);
    }
  };

  // ----- EDIT -----
  const openEdit = (svc) => {
    setEditId(svc.id);
    setETitle(svc.title || "");
    setEDesc(svc.description || "");
    setEPrice(String(svc.price ?? ""));
    setECategory(svc.category || "Other");
    setEditError("");
    setEditOpen(true);
  };
  const closeEdit = () => {
    if (savingEdit) return;
    setEditOpen(false);
  };
  const validateEdit = () => {
    if (!eTitle.trim()) return "Please add a title.";
    if (!eDesc.trim()) return "Please add a short description.";
    const price = Number(ePrice);
    if (!Number.isFinite(price) || price < 0) return "Enter a valid non-negative price.";
    if (!eCategory || eCategory === "All") return "Select a category.";
    return null;
  };
  const handleSaveEdit = async () => {
    const err = validateEdit();
    if (err) {
      setEditError(err);
      return;
    }
    try {
      setSavingEdit(true);
      setEditError("");

      const payload = {
        title: eTitle.trim(),
        description: eDesc.trim(),
        price: Number(ePrice),
        category: eCategory,
      };

      // Try PATCH (standard), fallback to PUT or PATCH-with-body wrapper
      let updated;
      try {
        updated = await api.patch(`/services/${editId}/`, payload);
      } catch {
        try {
          updated = await api.put(`/services/${editId}/`, payload);
        } catch {
          updated = await api.patch(`/services/${editId}/`, { body: payload });
        }
      }

      const normalized = {
        id: updated?.id ?? editId,
        ...payload,
        user: updated?.user || updated?.owner || null,
      };

      setMine((cur) => cur.map((s) => (String(s.id) === String(editId) ? { ...s, ...normalized } : s)));
      setBrowse((cur) => cur.map((s) => (String(s.id) === String(editId) ? { ...s, ...normalized } : s)));

      setEditOpen(false);
    } catch (e) {
      setEditError(e?.data?.error || "Could not save changes right now.");
    } finally {
      setSavingEdit(false);
    }
  };
  const confirmDelete = (svc) => {
    Alert.alert("Delete Service", `Delete “${svc.title}”?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => handleDelete(svc) },
    ]);
  };
  const handleDelete = async (svc) => {
    try {
      setMine((cur) => cur.filter((s) => String(s.id) !== String(svc.id)));
      setBrowse((cur) => cur.filter((s) => String(s.id) !== String(svc.id)));
      try {
        await api.delete(`/services/${svc.id}/`);
      } catch {
        await onRefresh();
      }
    } catch {}
  };

  // --- Category scroller helpers (in create modal) ---
  const onCatScroll = (e) => {
    const {
      contentOffset: { x },
      contentSize: { width: contentW },
      layoutMeasurement: { width: layoutW },
    } = e.nativeEvent;
    setCatCanLeft(x > 2);
    setCatCanRight(x + layoutW < contentW - 2);
    if (!catHintSeen && x > 4) setCatHintSeen(true);
  };
  const scrollCatsToStart = () => catScrollRef.current?.scrollTo({ x: 0, animated: true });
  const scrollCatsToEnd = () => catScrollRef.current?.scrollToEnd({ animated: true });

  /* =================== BOOKINGS PANE =================== */
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
  const serverStatus = useMemo(() => (bkStatus === "All" ? "" : bkStatus), [bkStatus]);

  const isPast = (startISO) => {
    try {
      return new Date(startISO).getTime() < Date.now();
    } catch {
      return false;
    }
  };

  const filterBySegment = useCallback(
    (list) => (bkSegment === "Upcoming" ? list.filter((b) => !isPast(b.start_at)) : list.filter((b) => isPast(b.start_at))),
    [bkSegment]
  );
  const filterByDay = useCallback(
    (list) => {
      if (!bkDayISO) return list;
      return list.filter((b) => (b.start_at || "").slice(0, 10) === bkDayISO);
    },
    [bkDayISO]
  );

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
        const base = Array.isArray(res?.results) ? res.results : Array.isArray(res) ? res : [];
        const seg = filterBySegment(base);
        const filtered = filterByDay(seg);
        const merged = replace ? filtered : [...bkItems, ...filtered];
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

  // month availability loader for Bookings pane month calendar
  const refreshMonthAvailability = useCallback(
    async (cursorDate) => {
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
        const list = Array.isArray(res?.results) ? res.results : Array.isArray(res) ? res : [];
        const map = {};
        for (const b of list) {
          const day = (b?.start_at || "").slice(0, 10);
          if (!day) continue;
          map[day] = (map[day] || 0) + 1;
        }
        setBkMonthAvailability(map);
      } catch {
        setBkMonthAvailability({});
      }
    },
    []
  );

  // connect reload ref to latest fetchBookings
  const fetchBookingsRef = useRef(fetchBookings);
  useEffect(() => {
    fetchBookingsRef.current = fetchBookings;
  }, [fetchBookings]);
  const fetchBookingsProxy = (...args) => fetchBookingsRef.current(...args);

  useEffect(() => {
    if (tab === Tabs.Bookings) {
      fetchBookingsProxy(1, true);
      refreshMonthAvailability(monthCursor);
    }
    return () => {
      if (bkAbortRef.current) bkAbortRef.current.abort();
    };
  }, [tab, serverRole, serverStatus, bkSegment, bkDayISO, refreshMonthAvailability]); // Month refresh handled separately

  const bkLoadMore = useCallback(async () => {
    if (!bkNextPage || bkLoading) return;
    await fetchBookingsProxy(bkPage + 1, false);
  }, [bkNextPage, bkLoading, bkPage]);

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
      return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
    } catch {
      return iso;
    }
  };

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
    const act = [];
    if (s === "pending") {
      if (mineAsProvider) act.push("Confirm", "Reject");
      if (mineAsClient || mineAsProvider) act.push("Cancel");
    } else if (s === "confirmed") {
      if (mineAsProvider) act.push("Complete");
      if (mineAsClient || mineAsProvider) act.push("Cancel");
    }
    return act;
  };

  const postAction = async (id, action) => {
    const call = {
      Confirm: () => confirmBooking(id),
      Reject: () => rejectBooking(id),
      Cancel: () => cancelBookingAction(id),
      Complete: () => completeBooking(id),
    }[action];

    if (!call) return;
    const previous = bkItems.slice();
    try {
      const next = bkItems.map((b) => {
        if (b.id !== id) return b;
        const now = new Date().toISOString();
        if (action === "Confirm") return { ...b, status: "confirmed", updated_at: now };
        if (action === "Reject") return { ...b, status: "rejected", updated_at: now };
        if (action === "Cancel") return { ...b, status: "cancelled", updated_at: now, cancelled_at: now };
        if (action === "Complete") return { ...b, status: "completed", updated_at: now, completed_at: now };
        return b;
      });
      setBkItems(next);
      await call();
      // keep availability fresh
      refreshMonthAvailability(monthCursor);
    } catch (e) {
      setBkItems(previous);
      Alert.alert("Action failed", "Please try again.");
    }
  };

  const confirmBkAction = (b, action) => {
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

  const BookingCard = ({ item }) => {
    const sStyle = statusPillStyle(item.status);
    const acts = actionsFor(item);
    const mineAsProvider = String(meId) === String(item?.provider?.id);
    const targetUser = mineAsProvider ? item?.client : item?.provider;
    const targetName =
      targetUser?.first_name || targetUser?.last_name
        ? `${targetUser?.first_name || ""} ${targetUser?.last_name || ""}`.trim()
        : targetUser?.email || "Neighbor";

    return (
      <Pressable style={({ pressed }) => [styles.card, pressed && { opacity: 0.97 }]} onPress={() => openDetail(item)}>
        <View style={styles.cardTopRow}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {item.service?.title || "Service"}
          </Text>
          <Text style={[styles.statusPill, { borderColor: sStyle.borderColor, color: sStyle.color }]}>
            {item.status}
          </Text>
        </View>

        <Text style={styles.owner} numberOfLines={1}>
          with {targetName} • <Text style={styles.categoryText}>{item.service?.category || "Other"}</Text>
        </Text>

        <Text style={[styles.desc, { marginTop: 6 }]}>
          {fmtTime(item.start_at)} → {fmtTimeOnly(item.end_at)}
        </Text>

        <View style={styles.cardFooter}>
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

  /* ---------- Date Helpers & Calendars ---------- */
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  // ---- 3-week strip that recenters around an anchor date ----
  const [stripAnchorDate, setStripAnchorDate] = useState(today);
  const makeDaysStrip = useCallback(
    (anchorDate) => {
      // 21 days; center on anchor -> start 7 days before anchor
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

  // update strip when selected day changes or when month changes
  useEffect(() => {
    if (bkDayISO) {
      const d = new Date(bkDayISO + "T00:00:00");
      setStripAnchorDate(d);
    }
  }, [bkDayISO]);

  // Mini Month Grid base (shared logic)
  const buildMonthInfo = useCallback(
    (cursor) => {
      const first = new Date(cursor);
      const year = first.getFullYear();
      const month = first.getMonth();
      const startWeekday = new Date(year, month, 1).getDay(); // 0=Sun..6=Sat
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
      const title = first.toLocaleString(undefined, { month: "long", year: "numeric" });
      return { grid, title, year, month };
    },
    [today]
  );

  // Bookings filter month calendar
  const [monthCursor, setMonthCursor] = useState(() => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const monthInfo = useMemo(() => buildMonthInfo(monthCursor), [buildMonthInfo, monthCursor]);

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

  // re-center 3-week strip when month changes
  useEffect(() => {
    setStripAnchorDate(new Date(monthCursor));
  }, [monthCursor]);

  // rebuild strip whenever anchor changes
  useEffect(() => {
    setDaysStrip(makeDaysStrip(stripAnchorDate));
  }, [stripAnchorDate, makeDaysStrip]);

  // also refresh month availability when month changes (Bookings tab only)
  useEffect(() => {
    if (tab === Tabs.Bookings) refreshMonthAvailability(monthCursor);
  }, [monthCursor, tab, refreshMonthAvailability]);

  const CalendarStrip = () => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }} keyboardShouldPersistTaps="handled">
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable onPress={() => setBkDayISO("")} style={[styles.dayChip, bkDayISO === "" && styles.dayChipActive]}>
          <Text style={[styles.dayChipTop, bkDayISO === "" && styles.dayChipTextActive]}>All</Text>
          <Text style={[styles.dayChipBottom, bkDayISO === "" && styles.dayChipTextActive]}>Dates</Text>
        </Pressable>
        {daysStrip.map((d) => {
          const active = bkDayISO === d.iso;
          return (
            <Pressable key={d.iso} onPress={() => setBkDayISO(d.iso)} style={[styles.dayChip, active && styles.dayChipActive]}>
              <Text style={[styles.dayChipTop, active && styles.dayChipTextActive]}>
                {d.isToday ? "Today" : d.labelTop}
              </Text>
              <Text style={[styles.dayChipBottom, active && styles.dayChipTextActive]}>{d.labelBottom}</Text>
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

  const BookingsPane = () => (
    <>
      {/* Filters */}
      <View style={styles.segmentBar}>
        {Segments.map((s) => {
          const active = s === bkSegment;
          return (
            <Pressable key={s} onPress={() => setBkSegment(s)} style={[styles.segmentChip, active && styles.segmentChipActive]}>
              <Text style={[styles.segmentChipText, active && styles.segmentChipTextActive]}>{s}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.roleBar}>
        {Roles.map((r) => {
          const active = r === bkRole;
          return (
            <Pressable key={r} onPress={() => setBkRole(r)} style={[styles.roleChip, active && styles.roleChipActive]}>
              <Text style={[styles.roleChipText, active && styles.roleChipTextActive]}>{r}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.statusRow}>
        {StatusChips.map((s) => {
          const active = s === bkStatus;
          return (
            <Pressable key={s} onPress={() => setBkStatus(s)} style={[styles.statusChip, active && styles.statusChipActive]}>
              <Text style={[styles.statusChipText, active && styles.statusChipTextActive]}>{s}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* Month Calendar (with availability dots) */}
      <MonthCalendar />

      {/* Quick calendar strip (re-centered) */}
      <CalendarStrip />

      {bkError ? <Text style={styles.errorText}>{bkError}</Text> : null}

      {/* List */}
      <FlatList
        data={bkItems}
        keyExtractor={(b) => String(b.id)}
        renderItem={({ item }) => <BookingCard item={item} />}
        contentContainerStyle={{ paddingBottom: 28 }}
        onEndReachedThreshold={0.4}
        onEndReached={bkLoadMore}
        ListEmptyComponent={
          !bkLoading ? (
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyTitle}>No bookings</Text>
              <Text style={styles.emptyText}>
                {bkSegment === "Upcoming" ? "You have no upcoming bookings." : "You have no past bookings."}
              </Text>
            </View>
          ) : null
        }
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
            onRefresh={() => {
              setBkRefreshing(true);
              fetchBookingsProxy(1, true);
              refreshMonthAvailability(monthCursor);
            }}
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
    </>
  );

  /* =================== BOOK MODAL (create a booking) =================== */
  const [bookOpen, setBookOpen] = useState(false);
  const [bookSvc, setBookSvc] = useState(null);
  const [bookDay, setBookDay] = useState(""); // YYYY-MM-DD
  const [bookTime, setBookTime] = useState(""); // "HH:mm"
  const [bookDuration, setBookDuration] = useState(60); // minutes
  const [bookNote, setBookNote] = useState("");
  const [bookSaving, setBookSaving] = useState(false);
  const [bookErr, setBookErr] = useState("");

  // double-booking guard: fetch provider bookings that day and block overlap
  const hasOverlap = (startA, endA, startB, endB) => {
    const a = new Date(startA).getTime();
    const b = new Date(endA).getTime();
    const c = new Date(startB).getTime();
    const d = new Date(endB).getTime();
    return a < d && c < b; // strict overlap
  };

  const fetchProviderBookingsForDay = useCallback(async (providerId, dayISO) => {
    const start = `${dayISO}T00:00:00`;
    const end = `${dayISO}T23:59:59`;
    // Use raw api for flexible params
    const params = {
      role: "provider",
      provider_id: providerId,
      from: start,
      to: end,
      limit: 200,
      page: 1,
    };
    const res = await api.get("/bookings/", { params });
    return Array.isArray(res?.results) ? res.results : Array.isArray(res) ? res : [];
  }, []);

  const openBook = (svc) => {
    if (svc?.user?.id && meId && String(svc.user.id) === String(meId)) {
      Alert.alert("Heads up", "You can’t book your own service.");
      return;
    }
    const now = new Date();
    const roundUp = new Date(Math.ceil((now.getTime() + 5 * 60 * 1000) / (30 * 60 * 1000)) * (30 * 60 * 1000));
    const iso = isoDay(roundUp);
    const hh = String(roundUp.getHours()).padStart(2, "0");
    const mm = String(roundUp.getMinutes()).padStart(2, "0");
    setBookSvc(svc);
    setBookDay(iso);
    setBookTime(`${hh}:${mm}`);
    setBookDuration(60);
    setBookNote("");
    setBookErr("");
    setBookOpen(true);
  };
  const closeBook = () => {
    if (bookSaving) return;
    setBookOpen(false);
    setBookSvc(null);
  };

  const makeISO = (day, time24) => {
    try {
      const [H, M] = time24.split(":").map((n) => parseInt(n, 10));
      const [y, mo, d] = day.split("-").map((n) => parseInt(n, 10));
      const local = new Date(y, mo - 1, d, H, M, 0, 0);
      return local.toISOString();
    } catch {
      return null;
    }
  };

  const validateBooking = () => {
    if (!bookSvc?.id) return "No service selected.";
    if (!bookDay) return "Choose a day.";
    if (!bookTime) return "Choose a start time.";
    if (!Number.isFinite(bookDuration) || bookDuration <= 0) return "Duration must be positive.";
    return null;
  };

  const handleCreateBooking = async () => {
    const err = validateBooking();
    if (err) {
      setBookErr(err);
      return;
    }
    const startISO = makeISO(bookDay, bookTime);
    const endISO = new Date(new Date(startISO).getTime() + bookDuration * 60 * 1000).toISOString();

    try {
      setBookSaving(true);
      setBookErr("");

      // DOUBLE BOOKING GUARD
      const providerId = bookSvc?.user?.id;
      if (providerId) {
        const dayBookings = await fetchProviderBookingsForDay(providerId, bookDay);
        const overlapping = dayBookings.find((b) => hasOverlap(startISO, endISO, b.start_at, b.end_at));
        if (overlapping) {
          setBookErr("This provider is already booked during that time.");
          setBookSaving(false);
          return;
        }
      }

      // Create booking
      await bookService(bookSvc.id, {
        start: startISO,
        end: endISO,
        note: bookNote?.trim() || "",
      });

      setBookOpen(false);
      setTab(Tabs.Bookings);
      await fetchBookingsProxy(1, true);
      refreshMonthAvailability(monthCursor);

      Alert.alert("Requested", "Your booking request was sent to the provider.");
    } catch (e) {
      const msg = e?.data?.error || e?.message || "Could not create booking.";
      setBookErr(msg);
    } finally {
      setBookSaving(false);
    }
  };

  // Time slots helper (08:00 → 20:00, 30-min steps)
  const timeSlots = useMemo(() => {
    const slots = [];
    for (let h = 8; h <= 20; h++) {
      for (let m of [0, 30]) {
        const hh = String(h).padStart(2, "0");
        const mm = String(m).padStart(2, "0");
        const label = new Date(1970, 0, 1, h, m, 0).toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        slots.push({ value: `${hh}:${mm}`, label });
      }
    }
    return slots;
  }, []);

  /* =================== SERVICES UI PIECES =================== */

  // robust chat navigation (handles nested stacks)
  const navigateToChat = useCallback(
    (toUserEmail) => {
      try {
        navigation?.navigate?.("ChatScreen", { toUserEmail });
        return;
      } catch {}
      try {
        navigation?.navigate?.("Messages", { screen: "ChatScreen", params: { toUserEmail } });
        return;
      } catch {}
      try {
        navigation?.navigate?.("ChatStack", { screen: "ChatScreen", params: { toUserEmail } });
        return;
      } catch {}
      try {
        navigation?.push?.("ChatScreen", { toUserEmail });
      } catch {
        Alert.alert(
          "Messaging not available",
          "Couldn’t find ChatScreen in the current navigator. Make sure it's registered or adjust the route names in ServicesScreen."
        );
      }
    },
    [navigation]
  );

  const Header = () => (
    <View style={[styles.header, { paddingTop: 6 }]}>
      <Text style={styles.title}>Services</Text>
      <Text style={styles.subtitle}>Offer your skills. Book your neighbors.</Text>
    </View>
  );

  const TabBar = () => (
    <View style={styles.tabBar}>
      {[Tabs.Browse, Tabs.Mine, Tabs.Bookings].map((t) => {
        const active = tab === t;
        return (
          <Pressable
            key={t}
            onPress={() => setTab(t)}
            style={({ pressed }) => [styles.tab, active && styles.tabActive, pressed && { opacity: 0.9 }]}
          >
            <Text style={[styles.tabText, active && styles.tabTextActive]}>{t}</Text>
          </Pressable>
        );
      })}
      <View style={{ flex: 1 }} />
      {tab !== Tabs.Bookings && (
        <Pressable onPress={openCreate} style={({ pressed }) => [styles.createBtn, pressed && { transform: [{ scale: 0.98 }] }]}>
          <Text style={styles.createBtnText}>+ New</Text>
        </Pressable>
      )}
    </View>
  );

  const SearchBar = () =>
    tab === Tabs.Browse ? (
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
    ) : null;

  const CategoryChips = () =>
    tab === Tabs.Browse ? (
      <View style={styles.chipsRow}>
        {categories.map((c) => {
          const active = c === category;
          return (
            <Pressable
              key={c}
              onPress={() => onSelectCategory(c)}
              style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && { opacity: 0.85 }]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{c}</Text>
            </Pressable>
          );
        })}
      </View>
    ) : null;

  const EmptyState = ({ kind }) => (
    <View style={styles.emptyWrap}>
      <Text style={styles.emptyTitle}>{kind === "mine" ? "You haven’t posted a service yet" : "No services found"}</Text>
      <Text style={styles.emptyText}>
        {kind === "mine" ? "Tap “+ New” to publish your first service." : "Try a different keyword or switch categories."}
      </Text>
    </View>
  );

  const Skeleton = () => (
    <View style={styles.card}>
      <View style={[styles.skeleton, { width: "62%" }]} />
      <View style={[styles.skeleton, { width: "88%", marginTop: 8 }]} />
      <View style={[styles.skeleton, { width: "45%", height: 14, marginTop: 10 }]} />
    </View>
  );

  const openServiceDetail = (svc) => {
    setSvcDetailItem(svc);
    setSvcDetailOpen(true);
  };
  const closeServiceDetail = () => {
    setSvcDetailOpen(false);
    setSvcDetailItem(null);
  };

  const ServiceCard = ({ item }) => {
    const owner =
      item.user?.first_name || item.user?.last_name
        ? `${item.user?.first_name || ""} ${item.user?.last_name || ""}`.trim()
        : item.user?.email || "Neighbor";

    const priceNum = Number(item.price);
    const priceLabel = Number.isFinite(priceNum)
      ? priceNum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "—";

    const isMineTab = tab === Tabs.Mine;
    const amOwner = String(item?.user?.id) === String(meId);

    return (
      <Pressable
        onPress={() => openServiceDetail(item)} // open modal instead of route
        onLongPress={() => (isMineTab ? openEdit(item) : undefined)}
        delayLongPress={250}
        style={({ pressed }) => [styles.card, pressed && { opacity: 0.96 }]}
      >
        <View style={styles.cardTopRow}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {item.title}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {isMineTab ? (
              <Pressable onPress={() => openEdit(item)} style={styles.editPill}>
                <Text style={styles.editPillText}>Edit</Text>
              </Pressable>
            ) : !amOwner ? (
              <Pressable onPress={() => openBook(item)} style={styles.editPill}>
                <Text style={styles.editPillText}>Book</Text>
              </Pressable>
            ) : null}
            <Text style={styles.price}>{priceLabel} ESC</Text>
          </View>
        </View>

        <Text style={styles.owner} numberOfLines={1}>
          by {owner} • <Text style={styles.categoryText}>{item.category || "Other"}</Text>
        </Text>
        <Text style={styles.desc} numberOfLines={3}>
          {item.description}
        </Text>

        <View style={styles.cardFooter}>
          {!isMineTab && !amOwner && (
            <>
              <Pressable
                style={({ pressed }) => [styles.primaryBtn, pressed && { transform: [{ scale: 0.98 }] }]}
                onPress={() => navigateToChat(item.user?.email)}
              >
                <Text style={styles.primaryBtnText}>Message</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.secondaryBtn, pressed && { opacity: 0.9 }]}
                onPress={() => navigation?.navigate?.("Wallet", { presetNote: `Service: ${item.title}` })}
              >
                <Text style={styles.secondaryBtnText}>Pay</Text>
              </Pressable>
            </>
          )}

          {isMineTab && (
            <>
              <Pressable
                style={({ pressed }) => [styles.primaryBtn, pressed && { transform: [{ scale: 0.98 }] }]}
                onPress={() => openEdit(item)}
              >
                <Text style={styles.primaryBtnText}>Edit</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.secondaryBtn, pressed && { opacity: 0.9 }]}
                onPress={() => confirmDelete(item)}
              >
                <Text style={styles.secondaryBtnText}>Delete</Text>
              </Pressable>
            </>
          )}
        </View>
      </Pressable>
    );
  };

  const data = tab === Tabs.Browse ? browse : mine;
  const isLoadingList = tab === Tabs.Browse ? loading : loadingMine;

  const skeletonTop = useMemo(() => insets.top + 160, [insets.top]);

  /* ===== Booking Month Picker (for modal; separate state from filters) ===== */
  const [bookMonthCursor, setBookMonthCursor] = useState(() => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const bookMonthInfo = useMemo(() => buildMonthInfo(bookMonthCursor), [buildMonthInfo, bookMonthCursor]);
  const bookPrevMonth = () => {
    const d = new Date(bookMonthCursor);
    d.setMonth(d.getMonth() - 1);
    setBookMonthCursor(d);
  };
  const bookNextMonth = () => {
    const d = new Date(bookMonthCursor);
    d.setMonth(d.getMonth() + 1);
    setBookMonthCursor(d);
  };
  const MonthCalendarBooking = () => (
    <View style={styles.monthWrap}>
      <View style={styles.monthHeader}>
        <Pressable onPress={bookPrevMonth} style={styles.monthNavBtn}>
          <Text style={styles.monthNavText}>‹</Text>
        </Pressable>
        <Text style={styles.monthTitle}>{bookMonthInfo.title}</Text>
        <Pressable onPress={bookNextMonth} style={styles.monthNavBtn}>
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

      {bookMonthInfo.grid.map((row, idx) => (
        <View key={idx} style={styles.weekRow}>
          {row.map((cell) => {
            const active = bookDay === cell.iso;
            return (
              <Pressable
                key={cell.iso}
                onPress={() => setBookDay(cell.iso)}
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
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );

  return (
    <SafeAreaView style={styles.safe}>
      {/* Accents */}
      <Animated.View style={[styles.accent, styles.accentTop, { transform: [{ translateY: floatY }] }]} />
      <Animated.View style={[styles.accent, styles.accentBottom, { transform: [{ translateY: floatY }] }]} />

      {/* HEAD + TABS */}
      <FlatList
        data={tab === Tabs.Bookings ? [] : data}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => <ServiceCard item={item} />}
        ListHeaderComponent={
          <>
            <View style={styles.header}>
              <Header />
              <TabBar />
            </View>

            {/* Bookings pane replaces search/chips/list when active */}
            {tab === Tabs.Bookings ? (
              <BookingsPane />
            ) : (
              <>
                <SearchBar />
                <CategoryChips />
                {error && tab === Tabs.Browse ? <Text style={styles.errorText}>{error}</Text> : null}
              </>
            )}
          </>
        }
        ListEmptyComponent={
          tab !== Tabs.Bookings && !isLoadingList ? <EmptyState kind={tab === Tabs.Mine ? "mine" : "browse"} /> : null
        }
        contentContainerStyle={[styles.listContent, { paddingTop: 8 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={THEME.accentGold} />}
        keyboardShouldPersistTaps="handled"
      />

      {/* Initial skeletons for services lists (not for bookings) */}
      {tab !== Tabs.Bookings && isLoadingList && (
        <View style={[styles.skeletonWrap, { top: skeletonTop }]}>
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </View>
      )}

      {/* Create Service Modal */}
      <Modal visible={createOpen} transparent animationType="fade" onRequestClose={closeCreate}>
        <KeyboardAvoidingView
          behavior={Platform.select({ ios: "padding", android: undefined })}
          style={styles.modalBackdrop}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Create a Service</Text>
            <ScrollView keyboardShouldPersistTaps="handled">
              <View style={styles.inputWrap}>
                <Text style={styles.inputLabel}>Title</Text>
                <TextInput
                  value={cTitle}
                  onChangeText={setCTitle}
                  placeholder="e.g., Fresh Fade, Math Tutoring, Studio Hour"
                  placeholderTextColor={THEME.subtle}
                  style={styles.input}
                />
              </View>

              <View style={styles.inputWrap}>
                <Text style={styles.inputLabel}>Description</Text>
                <TextInput
                  value={cDesc}
                  onChangeText={setCDesc}
                  placeholder="Short details about what’s included"
                  placeholderTextColor={THEME.subtle}
                  style={[styles.input, styles.textarea]}
                  multiline
                />
              </View>

              <View style={styles.rowBetween}>
                <View style={[styles.inputWrap, { flex: 1, marginRight: 8 }]}>
                  <Text style={styles.inputLabel}>Price (ESC)</Text>
                  <TextInput
                    value={cPrice}
                    onChangeText={(t) => setCPrice(t.replace(/[^0-9.]/g, ""))}
                    placeholder="e.g., 25"
                    placeholderTextColor={THEME.subtle}
                    keyboardType="decimal-pad"
                    style={styles.input}
                  />
                </View>

                <View style={[styles.inputWrap, { flex: 1, marginLeft: 8 }]}>
                  <View style={styles.catHeaderRow}>
                    <Text style={styles.inputLabel}>Category</Text>
                    <Pressable onPress={() => setCatGridOpen(true)} style={styles.viewAllBtn}>
                      <Text style={styles.viewAllText}>All categories</Text>
                    </Pressable>
                  </View>

                  {/* Category scroller */}
                  <View style={styles.catScrollerBox}>
                    {catCanLeft && (
                      <Pressable onPress={scrollCatsToStart} style={[styles.chev, styles.chevLeft]}>
                        <Text style={styles.chevText}>‹</Text>
                      </Pressable>
                    )}
                    {catCanRight && (
                      <Pressable onPress={scrollCatsToEnd} style={[styles.chev, styles.chevRight]}>
                        <Text style={styles.chevText}>›</Text>
                      </Pressable>
                    )}
                    <View pointerEvents="none" style={[styles.fade, styles.fadeLeft]} />
                    <View pointerEvents="none" style={[styles.fade, styles.fadeRight]} />

                    <ScrollView
                      ref={catScrollRef}
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      onScroll={onCatScroll}
                      scrollEventThrottle={16}
                      keyboardShouldPersistTaps="handled"
                    >
                      <View style={styles.chipsRowTight}>
                        {categories
                          .filter((c) => c !== "All")
                          .map((c) => {
                            const active = c === cCategory;
                            return (
                              <Pressable
                                key={c}
                                onPress={() => setCCategory(c)}
                                style={({ pressed }) => [styles.chipSmall, active && styles.chipActive, pressed && { opacity: 0.9 }]}
                              >
                                <Text style={[styles.chipSmallText, active && styles.chipTextActive]}>{c}</Text>
                              </Pressable>
                            );
                          })}
                      </View>
                    </ScrollView>
                  </View>

                  {!catHintSeen && <Text style={styles.catHint}>Swipe to see more →</Text>}
                </View>
              </View>

              {createError ? <Text style={styles.errorText}>{createError}</Text> : null}

              <View style={[styles.row, { marginTop: 14 }]}>
                <Pressable
                  onPress={closeCreate}
                  style={({ pressed }) => [styles.secondaryBtnWide, pressed && { opacity: 0.9 }]}
                  disabled={creating}
                >
                  <Text style={styles.secondaryBtnText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleCreate}
                  style={({ pressed }) => [styles.primaryBtnWide, pressed && { transform: [{ scale: 0.98 }] }]}
                  disabled={creating}
                >
                  {creating ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Publish</Text>}
                </Pressable>
              </View>
            </ScrollView>
          </View>

          {/* Category grid sheet */}
          <Modal visible={catGridOpen} transparent animationType="fade" onRequestClose={() => setCatGridOpen(false)}>
            <View style={styles.modalBackdrop}>
              <View style={styles.gridCard}>
                <Text style={styles.gridTitle}>Select a category</Text>
                <View style={styles.gridWrap}>
                  {categories
                    .filter((c) => c !== "All")
                    .map((c) => {
                      const active = c === cCategory;
                      return (
                        <Pressable
                          key={c}
                          onPress={() => {
                            setCCategory(c);
                            setCatGridOpen(false);
                          }}
                          style={[styles.gridItem, active && styles.gridItemActive]}
                        >
                          <Text style={[styles.gridItemText, active && styles.gridItemTextActive]}>{c}</Text>
                        </Pressable>
                      );
                    })}
                </View>
                <Pressable onPress={() => setCatGridOpen(false)} style={styles.gridCloseBtn}>
                  <Text style={styles.gridCloseText}>Close</Text>
                </Pressable>
              </View>
            </View>
          </Modal>
        </KeyboardAvoidingView>
      </Modal>

      {/* Edit Service Modal */}
      <Modal visible={editOpen} transparent animationType="fade" onRequestClose={closeEdit}>
        <KeyboardAvoidingView
          behavior={Platform.select({ ios: "padding", android: undefined })}
          style={styles.modalBackdrop}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Edit Service</Text>
            <ScrollView keyboardShouldPersistTaps="handled">
              <View style={styles.inputWrap}>
                <Text style={styles.inputLabel}>Title</Text>
                <TextInput
                  value={eTitle}
                  onChangeText={setETitle}
                  placeholder="Title"
                  placeholderTextColor={THEME.subtle}
                  style={styles.input}
                />
              </View>

              <View style={styles.inputWrap}>
                <Text style={styles.inputLabel}>Description</Text>
                <TextInput
                  value={eDesc}
                  onChangeText={setEDesc}
                  placeholder="Description"
                  placeholderTextColor={THEME.subtle}
                  style={[styles.input, styles.textarea]}
                  multiline
                />
              </View>

              <View style={styles.rowBetween}>
                <View style={[styles.inputWrap, { flex: 1, marginRight: 8 }]}>
                  <Text style={styles.inputLabel}>Price (ESC)</Text>
                  <TextInput
                    value={ePrice}
                    onChangeText={(t) => setEPrice(t.replace(/[^0-9.]/g, ""))}
                    placeholder="0.00"
                    placeholderTextColor={THEME.subtle}
                    keyboardType="decimal-pad"
                    style={styles.input}
                  />
                </View>

                <View style={[styles.inputWrap, { flex: 1, marginLeft: 8 }]}>
                  <Text style={styles.inputLabel}>Category</Text>
                  <View style={styles.chipsRowTight}>
                    {categories
                      .filter((c) => c !== "All")
                      .map((c) => {
                        const active = c === eCategory;
                        return (
                          <Pressable key={c} onPress={() => setECategory(c)} style={[styles.chipSmall, active && styles.chipActive]}>
                            <Text style={[styles.chipSmallText, active && styles.chipTextActive]}>{c}</Text>
                          </Pressable>
                        );
                      })}
                  </View>
                </View>
              </View>

              {editError ? <Text style={styles.errorText}>{editError}</Text> : null}

              <View style={[styles.row, { marginTop: 14 }]}>
                <Pressable
                  onPress={closeEdit}
                  style={({ pressed }) => [styles.secondaryBtnWide, pressed && { opacity: 0.9 }]}
                  disabled={savingEdit}
                >
                  <Text style={styles.secondaryBtnText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleSaveEdit}
                  style={({ pressed }) => [styles.primaryBtnWide, pressed && { transform: [{ scale: 0.98 }] }]}
                  disabled={savingEdit}
                >
                  {savingEdit ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Save Changes</Text>}
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Service Detail Modal (Tap -> Modal; Book / Message / Pay) */}
      <Modal visible={svcDetailOpen} transparent animationType="fade" onRequestClose={closeServiceDetail}>
        <KeyboardAvoidingView
          behavior={Platform.select({ ios: "padding", android: undefined })}
          style={styles.modalBackdrop}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{svcDetailItem?.title || "Service"}</Text>
            {svcDetailItem ? (
              <>
                <Text style={styles.desc}>{svcDetailItem?.description || "—"}</Text>
                <Text style={[styles.owner, { marginTop: 8 }]}>
                  Category: <Text style={styles.categoryText}>{svcDetailItem?.category || "Other"}</Text>
                </Text>
                <Text style={[styles.price, { marginTop: 6 }]}>
                  {Number(svcDetailItem?.price || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ESC
                </Text>
                <View style={[styles.row, { gap: 8, marginTop: 14, flexWrap: "wrap" }]}>
                  {String(svcDetailItem?.user?.id) !== String(meId) && (
                    <>
                      <Pressable
                        style={styles.primaryBtn}
                        onPress={() => {
                          closeServiceDetail();
                          openBook(svcDetailItem);
                        }}
                      >
                        <Text style={styles.primaryBtnText}>Book</Text>
                      </Pressable>
                      <Pressable
                        style={styles.secondaryBtn}
                        onPress={() => {
                          closeServiceDetail();
                          navigateToChat(svcDetailItem?.user?.email);
                        }}
                      >
                        <Text style={styles.secondaryBtnText}>Message</Text>
                      </Pressable>
                      <Pressable
                        style={styles.secondaryBtn}
                        onPress={() => {
                          closeServiceDetail();
                          navigation?.navigate?.("Wallet", { presetNote: `Service: ${svcDetailItem?.title}` });
                        }}
                      >
                        <Text style={styles.secondaryBtnText}>Pay</Text>
                      </Pressable>
                    </>
                  )}
                  <Pressable style={styles.secondaryBtn} onPress={closeServiceDetail}>
                    <Text style={styles.secondaryBtnText}>Close</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <ActivityIndicator color={THEME.accentGold} />
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Book Modal */}
      <Modal visible={bookOpen} transparent animationType="fade" onRequestClose={closeBook}>
        <KeyboardAvoidingView
          behavior={Platform.select({ ios: "padding", android: undefined })}
          style={styles.modalBackdrop}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Book: {bookSvc?.title || "Service"} </Text>
            <ScrollView keyboardShouldPersistTaps="handled">
              {/* Day picker (month calendar for booking) */}
              <Text style={styles.inputLabel}>Pick a day</Text>
              <MonthCalendarBooking />

              {/* Time picker */}
              <Text style={styles.inputLabel}>Start time</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }} keyboardShouldPersistTaps="handled">
                <View style={{ flexDirection: "row", gap: 8 }}>
                  {timeSlots.map((t) => {
                    const active = bookTime === t.value;
                    return (
                      <Pressable
                        key={t.value}
                        onPress={() => setBookTime(t.value)}
                        style={[styles.timeChip, active && styles.timeChipActive]}
                      >
                        <Text style={[styles.timeChipText, active && styles.timeChipTextActive]}>{t.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </ScrollView>

              {/* Duration */}
              <Text style={styles.inputLabel}>Duration (minutes)</Text>
              <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}>
                {[30, 60, 90, 120].map((d) => {
                  const active = bookDuration === d;
                  return (
                    <Pressable key={d} onPress={() => setBookDuration(d)} style={[styles.timeChip, active && styles.timeChipActive]}>
                      <Text style={[styles.timeChipText, active && styles.timeChipTextActive]}>{d}</Text>
                    </Pressable>
                  );
                })}
              </View>

              {/* Note */}
              <View style={styles.inputWrap}>
                <Text style={styles.inputLabel}>Note (optional)</Text>
                <TextInput
                  value={bookNote}
                  onChangeText={setBookNote}
                  placeholder="Any details or requests for the provider"
                  placeholderTextColor={THEME.subtle}
                  style={[styles.input, styles.textarea]}
                  multiline
                />
              </View>

              {bookErr ? <Text style={styles.errorText}>{bookErr}</Text> : null}

              <View style={[styles.row, { marginTop: 14 }]}>
                <Pressable
                  onPress={closeBook}
                  style={({ pressed }) => [styles.secondaryBtnWide, pressed && { opacity: 0.9 }]}
                  disabled={bookSaving}
                >
                  <Text style={styles.secondaryBtnText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleCreateBooking}
                  style={({ pressed }) => [styles.primaryBtnWide, pressed && { transform: [{ scale: 0.98 }] }]}
                  disabled={bookSaving}
                >
                  {bookSaving ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Request Booking</Text>}
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Booking Detail Modal (view/approve/deny) */}
      <Modal visible={detailOpen} transparent animationType="fade" onRequestClose={closeDetail}>
        <KeyboardAvoidingView
          behavior={Platform.select({ ios: "padding", android: undefined })}
          style={styles.modalBackdrop}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Booking Details</Text>
            {detailBk ? (
              <View>
                <Text style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Service:</Text> {detailBk?.service?.title || "Service"}
                </Text>
                <Text style={styles.detailRow}>
                  <Text style={styles.detailLabel}>When:</Text> {fmtTime(detailBk?.start_at)} → {fmtTimeOnly(detailBk?.end_at)}
                </Text>
                <Text style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Status:</Text>{" "}
                  <Text style={{ color: statusPillStyle(detailBk?.status).color }}>{detailBk?.status}</Text>
                </Text>
                <Text style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Client:</Text> {detailBk?.client?.email || "—"}
                </Text>
                <Text style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Provider:</Text> {detailBk?.provider?.email || "—"}
                </Text>
                {detailBk?.note ? (
                  <View style={{ marginTop: 8 }}>
                    <Text style={styles.detailLabel}>Note from client</Text>
                    <Text style={styles.desc}>{detailBk.note}</Text>
                  </View>
                ) : null}

                <View style={[styles.row, { gap: 8, marginTop: 16, flexWrap: "wrap" }]}>
                  {actionsFor(detailBk).map((a) => (
                    <Pressable
                      key={a}
                      onPress={() => {
                        closeDetail();
                        confirmBkAction(detailBk, a);
                      }}
                      style={[
                        styles.primaryBtn,
                        a === "Confirm" && { backgroundColor: THEME.accentOrange },
                        a === "Complete" && { backgroundColor: "#1f3b2a" },
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

export default ServicesScreen;

/* ======= styles ======= */
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: THEME.bg },
  listContent: { paddingHorizontal: 16, paddingBottom: 28 },

  header: { marginBottom: 8 },
  title: { color: THEME.accentGold, fontSize: 24, fontWeight: "800" },
  subtitle: { color: THEME.subtext, marginTop: 6 },

  tabBar: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 10,
    marginBottom: 6,
  },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "#1f2026",
    borderWidth: 1,
    borderColor: THEME.border,
    marginRight: 8,
  },
  tabActive: { backgroundColor: "#1b2a4b", borderColor: "#22355f" },
  tabText: { color: THEME.subtext, fontWeight: "700" },
  tabTextActive: { color: "#cfe0ff" },

  createBtn: {
    backgroundColor: THEME.accentOrange,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  createBtnText: { color: "#fff", fontWeight: "900", letterSpacing: 0.2 },

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
  chipsRowTight: {
    flexDirection: "row",
    gap: 8,
    paddingVertical: 4,
    flexWrap: "wrap",
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: THEME.border,
    backgroundColor: "#1f2026",
  },
  chipSmall: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: THEME.border,
    backgroundColor: "#1f2026",
  },
  chipActive: { borderColor: "#22355f", backgroundColor: "#1b2a4b" },
  chipText: { color: THEME.subtext, fontWeight: "700", fontSize: 12 },
  chipSmallText: { color: THEME.subtext, fontWeight: "700", fontSize: 12 },
  chipTextActive: { color: "#cfe0ff", fontWeight: "800" },

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
  cardTitle: { color: THEME.text, fontSize: 16, fontWeight: "800", maxWidth: "64%" },
  price: { color: THEME.accentGold, fontWeight: "900", fontSize: 16 },

  editPill: {
    backgroundColor: "#2b2e36",
    borderColor: "#3a3f4a",
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  editPillText: { color: "#cfe0ff", fontWeight: "800", fontSize: 12 },

  owner: { color: "#b7b7bf", fontSize: 12, marginTop: 6 },
  categoryText: { color: "#cfe0ff", fontWeight: "700" },
  desc: { color: THEME.subtext, marginTop: 8, lineHeight: 18 },

  cardFooter: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },
  primaryBtn: {
    backgroundColor: THEME.accentOrange,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  primaryBtnWide: {
    backgroundColor: THEME.accentOrange,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 18,
    alignItems: "center",
    flex: 1,
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
  secondaryBtnWide: {
    backgroundColor: "#2d2d2f",
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderColor: "#3a3a3f",
    borderWidth: 1,
    alignItems: "center",
    flex: 1,
    marginRight: 10,
  },
  secondaryBtnText: { color: THEME.text, fontWeight: "800" },

  // Bookings UI
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

  // Calendar strip chips
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
  dayChipBottom: { color: THEME.text, fontSize: 16, fontWeight: "900", marginTop: 2 },
  dayChipTextActive: { color: "#cfe0ff" },

  // Month calendar
  monthWrap: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: THEME.border,
    backgroundColor: "#16171c",
    borderRadius: 12,
    padding: 10,
  },
  monthHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
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
  weekHeaderText: { flex: 1, textAlign: "center", color: THEME.subtle, fontSize: 12, fontWeight: "800" },
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

  // time chips
  timeChip: {
    borderWidth: 1,
    borderColor: THEME.border,
    backgroundColor: "#1f2026",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  timeChipActive: { backgroundColor: "#1b2a4b", borderColor: "#22355f" },
  timeChipText: { color: THEME.subtext, fontWeight: "800", fontSize: 12 },
  timeChipTextActive: { color: "#cfe0ff" },

  emptyWrap: { alignItems: "center", paddingVertical: 48 },
  emptyTitle: { color: THEME.text, fontSize: 16, fontWeight: "800" },
  emptyText: { color: THEME.subtext, marginTop: 6 },

  statusPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    fontSize: 12,
    fontWeight: "900",
    textTransform: "capitalize",
  },

  errorText: { color: THEME.red, marginTop: 8 },

  skeletonWrap: { position: "absolute", left: 16, right: 16 },
  skeleton: {
    height: 16,
    backgroundColor: "#23242c",
    borderRadius: 8,
    borderColor: THEME.border,
    borderWidth: 1,
  },

  // accents
  accent: { position: "absolute", width: 300, height: 300, borderRadius: 999, opacity: 0.1 },
  accentTop: { top: -70, right: -60, backgroundColor: THEME.accentGold },
  accentBottom: { bottom: -90, left: -70, backgroundColor: THEME.accentOrange },

  // modal
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", padding: 16, justifyContent: "center" },
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
  modalTitle: { color: THEME.text, fontSize: 18, fontWeight: "900", marginBottom: 12, textAlign: "center" },

  inputWrap: { marginTop: 10 },
  inputLabel: { color: THEME.subtext, fontSize: 12, marginBottom: 6 },
  input: {
    backgroundColor: "#22232a",
    borderColor: THEME.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: Platform.select({ ios: 12, android: 8, default: 10 }),
    color: THEME.text,
  },
  textarea: { minHeight: 88, textAlignVertical: "top" },

  row: { flexDirection: "row", alignItems: "center" },
  rowBetween: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },

  // Category scroller (modal)
  catHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  viewAllBtn: { paddingHorizontal: 6, paddingVertical: 4 },
  viewAllText: { color: THEME.accentGold, fontWeight: "800", fontSize: 12 },

  catScrollerBox: {
    marginTop: 4,
    borderWidth: 1,
    borderColor: THEME.border,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "#1f2026",
  },
  fade: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 18,
    zIndex: 5,
    backgroundColor: "rgba(16,16,18,0.6)",
  },
  fadeLeft: { left: 0 },
  fadeRight: { right: 0 },
  chev: {
    position: "absolute",
    top: "50%",
    marginTop: -14,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 6,
  },
  chevLeft: { left: 6 },
  chevRight: { right: 6 },
  chevText: { color: "#fff", fontSize: 20, fontWeight: "900" },

  gridCard: {
    width: "100%",
    maxWidth: 460,
    alignSelf: "center",
    backgroundColor: THEME.card,
    borderColor: THEME.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
  },
  gridTitle: { color: THEME.text, fontSize: 16, fontWeight: "900", textAlign: "center", marginBottom: 8 },
  gridWrap: { flexDirection: "row", flexWrap: "wrap", gap: 10, justifyContent: "space-between" },
  gridItem: {
    width: "48%",
    borderWidth: 1,
    borderColor: THEME.border,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    backgroundColor: "#1f2026",
  },
  gridItemActive: { backgroundColor: "#1b2a4b", borderColor: "#22355f" },
  gridItemText: { color: THEME.subtext, fontWeight: "700" },
  gridItemTextActive: { color: "#cfe0ff", fontWeight: "800" },
  gridCloseBtn: { marginTop: 10, backgroundColor: THEME.accentOrange, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  gridCloseText: { color: "#fff", fontWeight: "900" },

  // actions on booking cards
  actionBtn: {
    backgroundColor: THEME.slate,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "#3a3a3f",
  },
  actionBtnPrimary: { backgroundColor: THEME.accentOrange, borderColor: THEME.accentOrange },
  actionBtnSuccess: { backgroundColor: "#1f3b2a", borderColor: "#2c6e49" },
  actionBtnText: { color: "#fff", fontWeight: "800", fontSize: 12 },

  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },

  catHint: { color: THEME.subtle, marginTop: 6, fontSize: 12 },

  // booking detail modal small bits
  detailRow: { color: THEME.text, marginTop: 6 },
  detailLabel: { color: THEME.subtext, fontWeight: "800" },
});
