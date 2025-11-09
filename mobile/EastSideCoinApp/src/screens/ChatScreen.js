// screens/ChatScreen.js
import React, { useState, useEffect, useContext, useCallback, useRef, useMemo } from "react";
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet,
  Alert, KeyboardAvoidingView, Platform, RefreshControl, ActivityIndicator, Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import debounce from "lodash.debounce";
import { Audio } from "expo-av";

import { AuthContext } from "../context/AuthProvider";
import { WS_URL } from "../config";
import { encryptAES, encryptRSA, decryptAES, decryptRSA } from "../utils/encryption";
import { isKeysReady, loadPrivateKeyForUser } from "../utils/keyManager";
import { createOrGetChatSocket } from "../utils/wsClient";

// ⭐ NEW: pull helpers that can return public keys even if not in index
import {
  api,
  searchUsersSmart,
  fetchUserPublicKey as apiFetchUserPublicKey, // single/batch/me-aware
  fetchMe as apiFetchMe, // ensure my own public key in storage
} from "../utils/api";

const THREADS_KEY = "chat_threads_index_v1";
const MSGS_KEY_PREFIX = "chat_msgs_";
const FETCH_LIMIT = 5000;
const CACHE_LIMIT = 20;

// ensure bundler includes the asset
const INCOMING_SOUND = require("../../assets/incoming.mp3");

/* ---------------- helpers ---------------- */
const asId = (v) => String(v ?? "");
const nameOf = (u) => (`${u?.first_name || ""} ${u?.last_name || ""}`.trim() || u?.email || "Neighbor");

const b64FixPadding = (b64) => {
  if (!b64) return b64;
  const s = String(b64).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  return pad === 0 ? s : s + "=".repeat(4 - pad);
};

const normalizeWrapAliases = (m) => {
  const x = { ...m };
  if (!x.encrypted_key_for_receiver && x.encrypted_key) x.encrypted_key_for_receiver = x.encrypted_key;
  if (!x.encrypted_key_for_sender && x.encrypted_key_sender) x.encrypted_key_for_sender = x.encrypted_key_sender;
  return x;
};

const pickWrapForMe = (raw, meId) => {
  const m = normalizeWrapAliases(raw);
  if (m.encrypted_key_for_me) return { value: m.encrypted_key_for_me };
  const me = String(meId);
  const sender = String(m.sender ?? m.sender_id);
  const receiver = String(m.receiver ?? m.receiver_id);
  if (receiver === me && (m.encrypted_key_for_receiver || m.encrypted_key)) {
    return { value: m.encrypted_key_for_receiver || m.encrypted_key };
  }
  if (sender === me && m.encrypted_key_for_sender) {
    return { value: m.encrypted_key_for_sender };
  }
  return { value: null };
};

const decryptServerMessage = (raw, privateKeyPem, meId, otherUser) => {
  try {
    const m = normalizeWrapAliases(raw);
    const { value } = pickWrapForMe(m, meId);
    if (!value) return null;

    let keyB64;
    try { keyB64 = decryptRSA(b64FixPadding(value), privateKeyPem); } catch { return null; }

    const text = decryptAES({
      ciphertextB64: b64FixPadding(m.encrypted_message),
      ivB64: b64FixPadding(m.iv),
      macB64: b64FixPadding(m.mac),
      keyB64: b64FixPadding(keyB64),
    });
    if (!text || text === "[Auth Failed]" || text === "[Decryption Failed]") return null;

    const isMine = String(m.sender ?? m.sender_id) === String(meId);
    const createdAt = (m.timestamp ? new Date(m.timestamp) :
                       m.created_at ? new Date(m.created_at) : new Date());
    return {
      _id: String(m.id || `${Date.now()}_${Math.random()}`),
      text,
      createdAt,
      user: { _id: isMine ? String(meId) : String(otherUser.id), name: isMine ? "You" : nameOf(otherUser) },
      __server: true,
    };
  } catch {
    return null;
  }
};

const pruneToCacheLimit = (arr, limit = CACHE_LIMIT) => {
  if (!Array.isArray(arr) || arr.length <= limit) return arr;
  const sorted = arr.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return sorted.slice(-limit);
};

// tiny guard to avoid noisy state flips
const setStateIfChanged = (setter, prevRef, nextVal, eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)) => {
  if (!eq(prevRef.current, nextVal)) {
    prevRef.current = nextVal;
    setter(nextVal);
  }
};

/* ------ Avatar helpers (NEW) ------ */
const Avatar = React.memo(({ uri, name, size = 44 }) => {
  const fallback = (name?.[0] || "N").toUpperCase();
  if (uri && typeof uri === "string") {
    return (
      <Image
        source={{ uri }}
        style={[styles.avatarImg, { width: size, height: size, borderRadius: size / 2 }]}
        resizeMode="cover"
      />
    );
  }
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={styles.avatarTxt}>{fallback}</Text>
    </View>
  );
});

/* ================== Component ================== */
const ChatScreen = () => {
  const { user, keysReady, getAccessToken } = useContext(AuthContext);

  const userPrefix = user?.id ? `u${user.id}:` : "u?:";
  const threadsKey = `${userPrefix}${THREADS_KEY}`;
  const msgsKey = (otherId) => `${userPrefix}${MSGS_KEY_PREFIX}${asId(otherId)}`;

  const [mode, setMode] = useState("threads");
  const [threads, _setThreads] = useState({});
  const threadsRef = useRef(threads);
  const setThreads = (val) => setStateIfChanged(_setThreads, threadsRef, val);

  const [messages, _setMessages] = useState([]);
  const messagesRef = useRef(messages);
  const setMessages = (val) => setStateIfChanged(_setMessages, messagesRef, val);

  const [selectedUser, _setSelectedUser] = useState(null);
  const selectedUserRef = useRef(selectedUser);
  const setSelectedUser = (val) => setStateIfChanged(_setSelectedUser, selectedUserRef, val);
  useEffect(() => { selectedUserRef.current = selectedUser; }, [selectedUser]);

  const [directory, _setDirectory] = useState({});
  const directoryRef = useRef(directory);
  const setDirectory = (val) => setStateIfChanged(_setDirectory, directoryRef, val);

  const [effectiveQuery, setEffectiveQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);

  // composer + sending state
  const [draft, setDraft] = useState("");
  const [sendInFlight, setSendInFlight] = useState(false);
  const listRef = useRef(null);

  // keys
  const [readyLocal, setReadyLocal] = useState(keysReady);
  const effectiveReady = keysReady || readyLocal;

  // WebSocket state (stable, no polling)
  const wsApiRef = useRef(null);
  const [wsStatus, _setWsStatus] = useState("disconnected"); // "connecting" | "connected" | "disconnected"
  const wsStatusRef = useRef(wsStatus);
  const setWsStatus = (v) => setStateIfChanged(_setWsStatus, wsStatusRef, v);

  const [lastConnectAt, _setLastConnectAt] = useState(null);
  const lastConnectAtRef = useRef(lastConnectAt);
  const setLastConnectAt = (v) => setStateIfChanged(_setLastConnectAt, lastConnectAtRef, v);

  const pendingClientIdsRef = useRef(new Set());
  const sendQueueRef = useRef([]);

  // top spinner
  const [syncCounter, setSyncCounter] = useState(0);
  const beginSync = useCallback(() => setSyncCounter((n) => n + 1), []);
  const endSync = useCallback(() => setSyncCounter((n) => Math.max(0, n - 1)), []);
  const withTopSpinner = useCallback(async (fn) => {
    beginSync();
    try { return await fn(); } finally { endSync(); }
  }, [beginSync, endSync]);

  // ---------- cache any public_key we see ----------
  const maybeCachePubKey = useCallback(async (uOrIdWithKey) => {
    try {
      const id = uOrIdWithKey?.id ?? uOrIdWithKey?.user_id ?? uOrIdWithKey?.uid;
      const pub = uOrIdWithKey?.public_key;
      if (!id || !pub || typeof pub !== "string" || !pub.includes("BEGIN PUBLIC KEY")) return;
      await AsyncStorage.setItem(`publicKey_${id}`, pub);
    } catch {}
  }, []);

  const cachePubKeysFromArray = useCallback(async (arr) => {
    if (!Array.isArray(arr)) return;
    for (const u of arr) await maybeCachePubKey(u);
  }, [maybeCachePubKey]);

  // ensure my own public key is in AsyncStorage (some flows only put it in /me/)
  const ensureMyPublicKey = useCallback(async () => {
    try {
      const local = await AsyncStorage.getItem("publicKey");
      if (local && local.includes("BEGIN PUBLIC KEY")) return local;
      const me = await apiFetchMe().catch(() => null);
      const k = me?.public_key;
      if (k && k.includes("BEGIN PUBLIC KEY")) {
        await AsyncStorage.setItem("publicKey", k);
        if (user?.id) await AsyncStorage.setItem(`publicKey_${user.id}`, k);
        return k;
      }
    } catch {}
    return null;
  }, [user?.id]);

  // stable callbacks (identities never change)
  const upsertThread = useRef((prev, neighbor, lastText, when, incrementUnread, opts = {}) => {
    const id = asId(neighbor?.id);
    if (!id) return prev || {};
    const existing = (prev && prev[id]) || {};
    const name = nameOf(neighbor) || existing.name || "Neighbor";
    const meta = {
      ...(existing.meta || {}),
      first_name: neighbor?.first_name ?? existing?.meta?.first_name,
      last_name: neighbor?.last_name ?? existing?.meta?.last_name,
      email: neighbor?.email ?? existing?.meta?.email,
      public_key: neighbor?.public_key ?? existing?.meta?.public_key,
      avatar_url: neighbor?.avatar_url ?? existing?.meta?.avatar_url, // ⭐ NEW
    };
    if (meta.public_key) { maybeCachePubKey({ id, public_key: meta.public_key }); }

    const resetUnread = opts.resetUnread === true;
    const unreadBase = Number(existing.unread || 0);
    const unread = resetUnread ? 0 : (incrementUnread ? unreadBase + 1 : unreadBase);
    const updatedAtISO = (when instanceof Date ? when : new Date()).toISOString();

    return {
      ...(prev || {}),
      [id]: {
        id,
        name,
        meta,
        lastText: lastText || existing.lastText || "",
        updatedAt: updatedAtISO,
        unread,
      },
    };
  });

  const mergeUniqueById = useRef((a, b) => {
    const map = new Map();
    for (const m of a) map.set(String(m._id), m);
    for (const m of b) map.set(String(m._id), m);
    return Array.from(map.values()).sort((x, y) => new Date(x.createdAt) - new Date(y.createdAt));
  });

  /* -------- search (debounced) -------- */
  const doSearch = useCallback(async (q) => {
    try {
      if (!q || q.trim().length < 2) { setSearchResults([]); return; }
      const arr = await searchUsersSmart(q.trim());
      const cleaned = Array.isArray(arr) ? arr.filter(u => u && u.id && String(u.id) !== String(user?.id)) : [];
      setSearchResults(cleaned);

      // cache keys + merge into directory
      await cachePubKeysFromArray(cleaned);
      setDirectory({
        ...directoryRef.current,
        ...Object.fromEntries(cleaned.map((u) => [asId(u.id), u])),
      });
    } catch {
      setSearchResults([]);
    }
  }, [user?.id, cachePubKeysFromArray]);

  const handleDebouncedSearch = useMemo(() => debounce(doSearch, 300), [doSearch]);
  useEffect(() => () => { try { handleDebouncedSearch.cancel(); } catch {} }, [handleDebouncedSearch]);

  /* -------- sound on incoming -------- */
  const soundRef = useRef(null);
  const lastBeepAtRef = useRef(0);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
          interruptionModeAndroid: Audio.INTERRUPTION_MODE_ANDROID_DO_NOT_MIX,
          interruptionModeIOS: Audio.INTERRUPTION_MODE_IOS_DO_NOT_MIX,
        });
        const { sound } = await Audio.Sound.createAsync(
          INCOMING_SOUND,
          { shouldPlay: false, isLooping: false, volume: 1.0 },
          null,
          true
        );
        if (!mounted) {
          try { await sound.unloadAsync(); } catch {}
          return;
        }
        soundRef.current = sound;
      } catch (e) {
        console.log("Audio init error:", e?.message);
      }
    })();
    return () => { (async () => { try { await soundRef.current?.unloadAsync(); } catch {} })(); };
  }, []);

  const playIncoming = useCallback(async () => {
    try {
      const now = Date.now();
      if (now - lastBeepAtRef.current < 250) return; // throttle spammy bursts
      lastBeepAtRef.current = now;
      const s = soundRef.current;
      if (!s) return;
      await s.setPositionAsync(0);
      await s.playAsync();
    } catch (e) {
      console.log("playIncoming error:", e?.message);
    }
  }, []);

  /* -------- cache helpers -------- */
  const loadCachedThreads = useCallback(async () => {
    try { const raw = await AsyncStorage.getItem(threadsKey); return raw ? JSON.parse(raw) : {}; }
    catch { return {}; }
  }, [threadsKey]);

  const saveCachedThreads = useCallback(async (val) => {
    try { await AsyncStorage.setItem(threadsKey, JSON.stringify(val)); } catch {}
  }, [threadsKey]);

  const loadCachedMessages = useCallback(async (otherId) => {
    try { const raw = await AsyncStorage.getItem(msgsKey(otherId)); return raw ? JSON.parse(raw) : []; }
    catch { return []; }
  }, [msgsKey]);

  const saveCachedMessages = useCallback(async (otherId, msgs) => {
    try {
      const pruned = pruneToCacheLimit(msgs);
      await AsyncStorage.setItem(msgsKey(otherId), JSON.stringify(pruned));
    } catch {}
  }, [msgsKey]);

  /* -------- threads index -------- */
  const fetchThreadsIndex = useCallback(async () => {
    try {
      const items = await withTopSpinner(() => api.get("/conversations/index/"));
      const arr = Array.isArray(items) ? items : (Array.isArray(items?.results) ? items.results : []);
      const next = {};
      for (const t of arr) {
        const id = asId(t.id);
        if (t.public_key) { await maybeCachePubKey({ id, public_key: t.public_key }); }
        next[id] = {
          id,
          name: nameOf(t),
          meta: {
            first_name: t.first_name,
            last_name: t.last_name,
            email: t.email,
            public_key: t.public_key,
            avatar_url: t.avatar_url || null, // ⭐ NEW: carry avatar from API
          },
          lastText: t.lastText || "",
          updatedAt: t.updatedAt || new Date().toISOString(),
          unread: t.unread || 0,
        };
      }
      setThreads(next);
      saveCachedThreads(next);
      await cachePubKeysFromArray(arr);

      // Also reflect into directory so UI/Header can read avatar_url quickly
      const dirEntries = {};
      for (const t of arr) {
        const id = asId(t.id);
        dirEntries[id] = { ...(directoryRef.current[id] || {}), ...t };
      }
      setDirectory({ ...directoryRef.current, ...dirEntries });
    } catch {
      const cached = await loadCachedThreads();
      setThreads(cached || {});
    }
  }, [saveCachedThreads, loadCachedThreads, withTopSpinner, cachePubKeysFromArray, maybeCachePubKey]);

  const markThreadRead = useCallback(async (otherId) => {
    if (!otherId) return;
    try { await api.post(`/conversations/mark_read/${otherId}/`); } catch {}
  }, []);

  // bootstrap threads (once)
  useEffect(() => {
    (async () => {
      const cached = await loadCachedThreads();
      if (cached && Object.keys(cached).length) setThreads(cached);
      await fetchThreadsIndex();
      await ensureMyPublicKey(); // ⭐ make sure my own pubkey is stored
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -------- keys mirror -------- */
  useEffect(() => { (async () => {
    if (user?.id) {
      let perUser = await AsyncStorage.getItem(`privateKey_${user.id}`);
      if (!perUser) perUser = await AsyncStorage.getItem("privateKey");
      if (perUser) await AsyncStorage.setItem("privateKey", perUser);
      await ensureMyPublicKey(); // refresh copy under both names
    }
  })(); }, [user?.id, ensureMyPublicKey]);

  // refresh keys once
  useEffect(() => { (async () => {
    if (!user?.id) return;
    const ok = await isKeysReady(user.id);
    setReadyLocal(ok);
    if (ok) await loadPrivateKeyForUser(user.id);
  })(); }, [user?.id]);

  /* ================= WS LISTENER (stable, no polling) ================= */
  const mountedRef = useRef(false);
  const handlerRef = useRef({
    onOpen: () => {},
    onClose: () => {},
    onError: () => {},
    onMessage: () => {},
  });

  // define the stable handlers once (use refs to read latest state)
  useEffect(() => {
    handlerRef.current.onOpen = () => {
      if (!mountedRef.current) return;
      setWsStatus("connected");
      setLastConnectAt(Date.now());
      const api = wsApiRef.current;
      if (!api) return;
      const q = sendQueueRef.current;
      while (q.length) {
        const p = q.shift();
        try { api.send(p); } catch { break; }
      }
    };
    handlerRef.current.onClose = () => { if (mountedRef.current) setWsStatus("disconnected"); };
    handlerRef.current.onError = () => { if (mountedRef.current) setWsStatus("disconnected"); };
    handlerRef.current.onMessage = async (incomingRaw) => {
      if (!mountedRef.current) return;
      try {
        const incoming = normalizeWrapAliases(incomingRaw);
        const senderId   = incoming.sender ?? incoming.sender_id ?? incoming.from_user;
        const receiverId = incoming.receiver ?? incoming.receiver_id ?? incoming.to_user;
        if (senderId == null || receiverId == null) return;

        const myIdStr = String(user.id);
        const otherId = String(senderId) === myIdStr ? String(receiverId) : String(senderId);

        if (!directoryRef.current[asId(otherId)]) {
          setDirectory({ ...directoryRef.current, [asId(otherId)]: { id: otherId } });
        }

        const clientTmpId = incoming.client_tmp_id || incoming.client_id || incoming.tmp_id;
        if (String(senderId) === myIdStr && clientTmpId && pendingClientIdsRef.current.has(clientTmpId)) {
          pendingClientIdsRef.current.delete(clientTmpId);
          return; // echo of optimistic send
        }

        // Update thread preview/unread even if convo not open
        const tNext = upsertThread.current(
          threadsRef.current,
          { id: otherId, avatar_url: directoryRef.current[asId(otherId)]?.avatar_url }, // ⭐ keep avatar
          "New message",
          new Date(),
          !(selectedUserRef.current && String(selectedUserRef.current.id) === otherId)
        );
        setThreads(tNext);
        saveCachedThreads(tNext);

        const activeSelected = selectedUserRef.current;
        if (!activeSelected || String(activeSelected.id) !== otherId) {
          if (wsStatusRef.current === "connected") await playIncoming();
          return;
        }

        let privateKeyPem = await AsyncStorage.getItem("privateKey");
        if (!privateKeyPem && user?.id) {
          privateKeyPem = await AsyncStorage.getItem(`privateKey_${user.id}`);
          if (privateKeyPem) await AsyncStorage.setItem("privateKey", privateKeyPem);
        }
        if (!privateKeyPem) return;

        const { value: wrap } = pickWrapForMe(incoming, user.id);
        if (!wrap) return;

        let keyB64;
        try { keyB64 = decryptRSA(b64FixPadding(wrap), privateKeyPem); } catch { return; }

        const decryptedText = decryptAES({
          ciphertextB64: b64FixPadding(incoming.encrypted_message),
          ivB64: b64FixPadding(incoming.iv),
          macB64: b64FixPadding(incoming.mac),
          keyB64: b64FixPadding(keyB64),
        });

        const mine = String(senderId) === myIdStr;
        const newMsg = {
          _id: String(incoming.id || `${Date.now()}_${Math.random()}`),
          text: decryptedText || "Encrypted Message",
          createdAt: incoming.timestamp ? new Date(incoming.timestamp)
            : (incoming.created_at ? new Date(incoming.created_at) : new Date()),
          user: { _id: mine ? String(user.id) : String(activeSelected.id), name: mine ? "You" : nameOf(activeSelected) },
        };

        const merged = mergeUniqueById.current(messagesRef.current, [newMsg]);
        const pruned = pruneToCacheLimit(merged);
        setMessages(pruned);
        if (activeSelected?.id) saveCachedMessages(activeSelected.id, pruned);

        const tNext2 = upsertThread.current(
          threadsRef.current,
          { id: activeSelected.id, ...activeSelected },
          decryptedText,
          newMsg.createdAt,
          false,
          { resetUnread: true }
        );
        setThreads(tNext2);
        saveCachedThreads(tNext2);

        if (!mine && wsStatusRef.current === "connected") await playIncoming();
      } catch (e) {
        console.error("onMessage error:", e);
      }
    };
  }, [user?.id, playIncoming, saveCachedThreads, saveCachedMessages]);

  // connect once per user.id
  useEffect(() => {
    if (!user?.id) return;
    mountedRef.current = true;

    (async () => {
      const ok = await isKeysReady(user.id);
      if (ok) await loadPrivateKeyForUser(user.id);
    })();

    const apiSock = createOrGetChatSocket({
      token: () => getAccessToken(),
      baseUrl: WS_URL,
      path: "/chat/",
      userId: user.id,
      prefer: "query",
      onOpen: (...args) => handlerRef.current.onOpen(...args),
      onClose: (...args) => handlerRef.current.onClose(...args),
      onError: (...args) => handlerRef.current.onError(...args),
      onMessage: (...args) => handlerRef.current.onMessage(...args),
    });

    wsApiRef.current = apiSock;
    setWsStatus("connecting");
    (async () => { try { await apiSock?.ready?.(); setWsStatus("connected"); setLastConnectAt(Date.now()); } catch { setWsStatus("disconnected"); } })();

    return () => {
      mountedRef.current = false;
      try { wsApiRef.current?.unsubscribe?.(); } catch {}
      wsApiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  /* -------- recipient resolution (HARDENED) -------- */

  // Try to populate directory entry with full profile (including public_key) if backend exposes it.
  const fetchUserProfileSoft = useCallback(async (uid) => {
    try {
      const profile = await api.get(`/users/${uid}/`); // if exists
      if (profile?.id) {
        const merged = { ...(directoryRef.current[asId(uid)] || {}), ...profile };
        setDirectory({ ...directoryRef.current, [asId(uid)]: merged });
        await maybeCachePubKey({ id: uid, public_key: merged.public_key });
        return merged;
      }
    } catch {}
    return null;
  }, [setDirectory, maybeCachePubKey]);

  /**
   * Resolve recipient public key robustly:
   * 1) AsyncStorage("publicKey_<uid>")
   * 2) directoryRef.current[uid].public_key
   * 3) apiFetchUserPublicKey(uid)  ⟶ cache + return (⭐ new)
   * 4) /users/<uid>/ (if available) ⟶ cache + return
   * 5) searchUsersSmart(uid/email)  ⟶ cache + return
   */
  const resolveRecipientPublicKey = useCallback(async (uid) => {
    if (!uid) return null;

    // 1) cache
    const cached = await AsyncStorage.getItem(`publicKey_${uid}`);
    if (cached && cached.includes("BEGIN PUBLIC KEY")) return cached;

    // 2) in-memory directory
    const fromDir = directoryRef.current[asId(uid)];
    if (fromDir?.public_key && fromDir.public_key.includes("BEGIN PUBLIC KEY")) {
      await maybeCachePubKey({ id: uid, public_key: fromDir.public_key });
      return fromDir.public_key;
    }

    // 3) direct api public-key helper (handles me/batch/single)
    try {
      const res = await apiFetchUserPublicKey(uid);
      const k = res?.public_key;
      if (k && k.includes("BEGIN PUBLIC KEY")) {
        await AsyncStorage.setItem(`publicKey_${uid}`, k);
        // merge a minimal directory entry so future reads are instant
        setDirectory({ ...directoryRef.current, [asId(uid)]: { ...(fromDir || { id: uid }), public_key: k } });
        return k;
      }
    } catch {}

    // 4) attempt to fetch profile
    const prof = await fetchUserProfileSoft(uid);
    if (prof?.public_key && prof.public_key.includes("BEGIN PUBLIC KEY")) {
      return prof.public_key;
    }

    // 5) search fallback (id/email/name)
    const probes = [String(uid), fromDir?.email].filter(Boolean);
    for (const q of new Set(probes)) {
      try {
        const results = await searchUsersSmart(q);
        const match = Array.isArray(results) ? results.find(r => String(r.id) === String(uid)) : null;
        if (match?.public_key && match.public_key.includes("BEGIN PUBLIC KEY")) {
          await maybeCachePubKey({ id: uid, public_key: match.public_key });
          setDirectory({ ...directoryRef.current, [asId(uid)]: { ...(fromDir || { id: uid }), ...match } });
          return match.public_key;
        }
        await cachePubKeysFromArray(results);
      } catch {}
    }

    return null;
  }, [maybeCachePubKey, cachePubKeysFromArray, setDirectory, fetchUserProfileSoft]);

  /* -------- send helpers -------- */
  const safeSendOverWs = useCallback(async (payload) => {
    const apiWS = wsApiRef.current;
    if (!apiWS || !apiWS.socket?.ready) {
      sendQueueRef.current.push(payload);
      return false;
    }
    try {
      apiWS.send(payload);
      return true;
    } catch {
      sendQueueRef.current.push(payload);
      return false;
    }
  }, []);

  const sendMessage = useCallback(async (messageVal) => {
    if (sendInFlight) return;
    const messageText = typeof messageVal === "string" ? messageVal : (messageVal?.text ?? "");
    const text = messageText.trim();
    if (!text) return;

    const target = selectedUserRef.current;
    if (!target) { Alert.alert("Not connected", "Select a conversation first."); return; }

    // Ensure my own key is present (some devices miss it on first boot)
    const myPublicKey = (await ensureMyPublicKey()) || (await AsyncStorage.getItem("publicKey"));
    const privateKey = await AsyncStorage.getItem("privateKey") || (user?.id ? await AsyncStorage.getItem(`privateKey_${user.id}`) : null);

    if (!privateKey || !myPublicKey) {
      Alert.alert("Encryption Setup", "Your device keys are still generating. Try again in a moment.");
      return;
    }

    try {
      setSendInFlight(true);

      // ⭐ Critical fix: try robust resolver path for recipient
      let recipientPub = await resolveRecipientPublicKey(target.id);
      if (!recipientPub) {
        // last-ditch: try reloading profile THEN resolver again
        await fetchUserProfileSoft(target.id);
        recipientPub = await resolveRecipientPublicKey(target.id);
      }
      if (!recipientPub) {
        Alert.alert("Encryption Error", "Couldn’t find the recipient’s public key.");
        setSendInFlight(false);
        return;
      }

      const bundle = encryptAES(text);
      const encrypted_key_for_receiver = encryptRSA(bundle.keyB64, recipientPub);
      const encrypted_key_for_sender   = encryptRSA(bundle.keyB64, myPublicKey);

      const now = new Date();
      const optimisticId = `opt_${now.getTime()}_${Math.random()}`;
      pendingClientIdsRef.current.add(optimisticId);
      const optimistic = {
        _id: optimisticId,
        text,
        createdAt: now,
        user: { _id: String(user.id), name: "You" },
      };

      const merged = mergeUniqueById.current(messagesRef.current, [optimistic]);
      const pruned = pruneToCacheLimit(merged);
      setMessages(pruned);
      if (target?.id) saveCachedMessages(target.id, pruned);

      const tNext = upsertThread.current(threadsRef.current, target, text, now, false);
      setThreads(tNext);
      saveCachedThreads(tNext);

      requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: true }));

      const payload = {
        receiver_id: target.id,
        encrypted_message: bundle.ciphertextB64,
        encrypted_key_for_receiver,
        encrypted_key_for_sender,
        iv: bundle.ivB64,
        mac: bundle.macB64,
        client_tmp_id: optimisticId,
      };

      await safeSendOverWs(payload);
      setDraft("");
    } catch (error) {
      console.error("send error:", error);
      Alert.alert("Send Error", "Failed to send message.");
    } finally {
      setTimeout(() => setSendInFlight(false), 120);
    }
  }, [saveCachedMessages, saveCachedThreads, safeSendOverWs, user?.id, resolveRecipientPublicKey, ensureMyPublicKey, fetchUserProfileSoft]);

  const onRefresh = useCallback(() => { fetchThreadsIndex(); }, [fetchThreadsIndex]);
  const messagesForUI = useMemo(() => messages.slice().reverse(), [messages]);

  /* -------- conversation helpers -------- */
  const getAllConversation = useCallback(async (otherId) => {
    let page = 1;
    const limit = FETCH_LIMIT;
    let allRows = [];
    while (true) {
      const params = { page, limit };
      const payload = await api.get(`/conversations/${otherId}/`, { params });
      const rows = Array.isArray(payload?.results) ? payload.results : (Array.isArray(payload) ? payload : []);
      allRows = allRows.concat(rows || []);
      if (!rows?.length || rows.length < limit) break;
      page += 1;
      if (page > 50) break;
    }
    return allRows;
  }, []);

  const initialLoad = useCallback(async (neighbor) => {
    if (!neighbor?.id) return;
    try {
      let privateKeyPem = await AsyncStorage.getItem("privateKey");
      if (!privateKeyPem && user?.id) {
        privateKeyPem = await AsyncStorage.getItem(`privateKey_${user.id}`);
        if (privateKeyPem) await AsyncStorage.setItem("privateKey", privateKeyPem);
      }
      if (!privateKeyPem) return;

      const rows = await withTopSpinner(() => getAllConversation(neighbor.id));
      const decrypted = rows
        .map((m) => decryptServerMessage(m, privateKeyPem, user.id, neighbor))
        .filter(Boolean)
        .map((m) => ({ ...m, _id: String(m._id), user: { ...m.user, _id: String(m.user._id) } }))
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      const pruned = pruneToCacheLimit(decrypted);
      setMessages(pruned);
      await saveCachedMessages(neighbor.id, pruned);
    } catch (e) {
      console.log("initialLoad error", e?.message);
    }
  }, [getAllConversation, user?.id, saveCachedMessages, withTopSpinner]);

  const openConversation = useCallback((neighbor) => {
    if (!neighbor?.id) return;
    const known = {
      ...(directoryRef.current[asId(neighbor.id)] || {}),
      ...neighbor,
    };

    setSelectedUser(known);
    if (mode !== "conversation") setMode("conversation");

    (async () => {
      // ⭐ Eagerly try to fetch/capture recipient public key to avoid send-time failures
      await resolveRecipientPublicKey(known.id);

      const cached = await loadCachedMessages(known.id);
      const normalized = (cached || []).map((m) => ({
        ...m,
        _id: String(m._id),
        user: { ...m.user, _id: String(m.user?._id) },
        createdAt: new Date(m.createdAt),
      })).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      setMessages(normalized);

      const ok = await isKeysReady(user.id);
      if (ok) {
        if (normalized.length === 0) await initialLoad(known);
      }
    })();

    const tNext = upsertThread.current(
      threadsRef.current,
      known,
      "",
      new Date(),
      false,
      { resetUnread: true }
    );
    setThreads(tNext);
    saveCachedThreads(tNext);

    setEffectiveQuery("");
    setSearchResults([]);
    markThreadRead(known.id);
  }, [mode, loadCachedMessages, initialLoad, markThreadRead, saveCachedThreads, user?.id, resolveRecipientPublicKey]);

  const backToThreads = useCallback(() => {
    setMode("threads");
    const sel = selectedUserRef.current;
    if (sel?.id) {
      const tNext = upsertThread.current(threadsRef.current, sel, "", new Date(), false, { resetUnread: true });
      setThreads(tNext);
      saveCachedThreads(tNext);
      markThreadRead(sel.id);
    }
    setSelectedUser(null);
    setMessages([]);
    fetchThreadsIndex();
  }, [fetchThreadsIndex, markThreadRead, saveCachedThreads]);

  /* ---------------- UI ---------------- */
  const TopSyncBar = () =>
    syncCounter > 0 ? (
      <View style={styles.syncBar}>
        <ActivityIndicator size="small" />
        <Text style={styles.syncText}>Syncing...</Text>
      </View>
    ) : null;

  const StatusPill = React.memo(() => {
    const age = lastConnectAtRef.current ? Math.max(0, Math.floor((Date.now() - lastConnectAtRef.current) / 1000)) : null;
    const text =
      wsStatusRef.current === "connected"
        ? `Connected${age != null ? ` · ${age}s` : ""}`
        : wsStatusRef.current === "connecting"
        ? "Connecting…"
        : "Disconnected";

    return (
      <View style={styles.wsRow}>
        <View style={[
          styles.dot,
          wsStatusRef.current === "connected" ? styles.dotOk :
          wsStatusRef.current === "connecting" ? styles.dotWarn : styles.dotBad
        ]} />
        <Text style={styles.wsText}>{text}</Text>
        {wsStatusRef.current !== "connected" && (
          <TouchableOpacity
            onPress={async () => {
              setWsStatus("connecting");
              try { await wsApiRef.current?.ready?.(); setWsStatus("connected"); setLastConnectAt(Date.now()); }
              catch { setWsStatus("disconnected"); }
            }}
            style={styles.retryBtn}
            activeOpacity={0.85}
          >
            <Text style={styles.retryTxt}>Retry</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  });

  const ThreadsList = React.memo(() => {
    const items = useMemo(
      () => Object.values(threadsRef.current || {}).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)),
      [threads]
    );

    const onTapThread = useCallback((item) => {
      openConversation({
        id: item.id,
        first_name: item.meta?.first_name,
        last_name: item.meta?.last_name,
        email: item.meta?.email,
        public_key: item.meta?.public_key,
        avatar_url: item.meta?.avatar_url || null, // ⭐ pass avatar to conversation
      });
    }, [openConversation]);

    const renderItem = useCallback(({ item }) => {
      const avatarUrl = item.meta?.avatar_url || null;
      return (
        <TouchableOpacity style={styles.threadItem} onPress={() => onTapThread(item)} activeOpacity={0.85}>
          <Avatar uri={avatarUrl} name={item.name} size={44} />
          <View style={styles.threadTextCol}>
            <View style={styles.threadTopRow}>
              <Text numberOfLines={1} style={styles.threadName}>{item.name}</Text>
              <Text style={styles.threadTime}>
                {new Date(item.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </Text>
            </View>
            <View style={styles.threadBottomRow}>
              <Text numberOfLines={1} style={styles.threadPreview}>{item.lastText || "Start the conversation"}</Text>
              {item.unread > 0 && (<View style={styles.unreadBadge}><Text style={styles.unreadTxt}>{item.unread}</Text></View>)}
            </View>
          </View>
        </TouchableOpacity>
      );
    }, [onTapThread]);

    return (
      <View style={{ flex: 1 }}>
        <TopSyncBar />
        <StatusPill />

        <Text style={styles.sectionTitle}>Start new</Text>
        <TextInput
          value={effectiveQuery}
          onChangeText={(t) => { setEffectiveQuery(t); handleDebouncedSearch(t); }}
          placeholder="Search neighbors…"
          placeholderTextColor="#AAA"
          style={styles.searchInput}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
        />
        {effectiveQuery.length >= 2 && (
          <View style={{ maxHeight: 260 }}>
            <FlatList
              data={searchResults}
              keyExtractor={(u) => asId(u.id)}
              keyboardShouldPersistTaps="always"
              removeClippedSubviews={false}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.userItem} onPress={() => openConversation(item)} activeOpacity={0.85}>
                  <View style={styles.userRow}>
                    <Avatar uri={item.avatar_url} name={nameOf(item)} size={36} />
                    <Text style={styles.userText}>{item.first_name} {item.last_name}</Text>
                  </View>
                </TouchableOpacity>
              )}
              ListEmptyComponent={<Text style={{ color: "#888", textAlign: "center", marginTop: 12 }}>No matches.</Text>}
            />
          </View>
        )}

        <Text style={[styles.sectionTitle, { marginTop: 10 }]}>Conversations</Text>
        <FlatList
          data={items}
          keyExtractor={(t) => String(t.id)}
          keyboardShouldPersistTaps="always"
          removeClippedSubviews={false}
          contentContainerStyle={{ paddingBottom: 12 }}
          refreshControl={<RefreshControl refreshing={false} onRefresh={onRefresh} />}
          renderItem={renderItem}
          ListEmptyComponent={<Text style={{ color: "#888", textAlign: "center", marginTop: 20 }}>No conversations yet. Start one above.</Text>}
        />
      </View>
    );
  });

  const Conversation = React.memo(function ConversationInner() {
    const headerAvatar = selectedUser?.avatar_url
      || threadsRef.current[asId(selectedUser?.id)]?.meta?.avatar_url
      || directoryRef.current[asId(selectedUser?.id)]?.avatar_url
      || null;

    return (
      <>
        <TopSyncBar />
        <StatusPill />

        <View style={styles.convHeader}>
          <TouchableOpacity onPress={backToThreads} style={styles.backButton} activeOpacity={0.85}>
            <Text style={styles.backText}>←</Text>
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <Avatar uri={headerAvatar} name={nameOf(selectedUser)} size={28} />
            <Text style={styles.headerName} numberOfLines={1}>{nameOf(selectedUser)}</Text>
          </View>

          <View style={{ width: 36 }} />
        </View>

        <View style={{ flex: 1 }}>
          <FlatList
            ref={listRef}
            style={styles.messagesList}
            contentContainerStyle={styles.messagesListContent}
            inverted
            data={messagesForUI}
            keyExtractor={(m) => String(m._id)}
            keyboardShouldPersistTaps="always"
            removeClippedSubviews={false}
            initialNumToRender={24}
            maxToRenderPerBatch={24}
            windowSize={12}
            decelerationRate="fast"
            scrollEventThrottle={16}
            overScrollMode="never"
            renderItem={({ item }) => {
              const mine = String(item.user?._id) === String(user.id);
              return (
                <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                  <Text style={styles.bubbleText}>{item.text}</Text>
                  <Text style={styles.bubbleTime}>
                    {new Date(item.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </Text>
                </View>
              );
            }}
          />

          {Platform.OS === "ios" ? (
            <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={80}>
              <Composer
                draft={draft}
                setDraft={setDraft}
                sendMessage={sendMessage}
                sendInFlight={sendInFlight}
                canType={!!effectiveReady}
              />
            </KeyboardAvoidingView>
          ) : (
            <Composer
              draft={draft}
              setDraft={setDraft}
              sendMessage={sendMessage}
              sendInFlight={sendInFlight}
              canType={!!effectiveReady}
            />
          )}
        </View>
      </>
    );
  });

  return (
    <SafeAreaView style={styles.safeContainer}>
      {mode === "conversation" ? <Conversation /> : <ThreadsList />}
    </SafeAreaView>
  );
};

/* ---------------- Composer ---------------- */
const Composer = React.memo(({ draft, setDraft, sendMessage, sendInFlight, canType }) => {
  const disabled = !canType;
  const onPressSend = useCallback(() => {
    if (disabled || sendInFlight) return;
    const t = (draft || "").trim();
    if (!t) return;
    setDraft("");
    sendMessage(t);
  }, [disabled, draft, sendInFlight, sendMessage, setDraft]);

  return (
    <View style={styles.composerRow}>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder={disabled ? "Setting up encryption keys..." : "Type a message…"}
        placeholderTextColor="#AAA"
        style={[styles.composerInput, (disabled || sendInFlight) && { opacity: 0.6 }]}
        editable={!disabled && !sendInFlight}
        autoCorrect={false}
        autoCapitalize="none"
        blurOnSubmit={false}
        autoFocus={false}
        returnKeyType="send"
        keyboardAppearance="dark"
        keyboardDismissMode="none"
        keyboardShouldPersistTaps="always"
        onSubmitEditing={onPressSend}
      />
      <TouchableOpacity
        style={[styles.composerSend, (disabled || sendInFlight) && { opacity: 0.6 }]}
        onPress={onPressSend}
        activeOpacity={0.85}
        disabled={sendInFlight || disabled}
      >
        <Text style={styles.composerSendTxt}>{sendInFlight ? "…" : "Send"}</Text>
      </TouchableOpacity>
    </View>
  );
});

/* ---------------- styles ---------------- */
const styles = StyleSheet.create({
  safeContainer: { flex: 1, backgroundColor: "#0F1012" },

  // Top sync bar
  syncBar: {
    height: 32,
    backgroundColor: "#11141a",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  syncText: { color: "#9fb3c8", fontSize: 12 },

  // Compact status pill
  wsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 12,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: "#14161C",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#888", marginRight: 8 },
  dotOk: { backgroundColor: "#4CAF50" },
  dotWarn: { backgroundColor: "#FFC107" },
  dotBad: { backgroundColor: "#E57373" },
  wsText: { color: "#9BA3AE", fontSize: 12, flex: 1 },
  retryBtn: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: "#2A66FF", borderRadius: 8 },
  retryTxt: { color: "#fff", fontWeight: "800", fontSize: 12 },

  // Header
  convHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.06)",
    backgroundColor: "#0F1012",
  },
  headerCenter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
    justifyContent: "center",
  },
  headerName: { color: "#FFF", fontSize: 18, fontWeight: "800", textAlign: "center" },

  backButton: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: "#1C1E24", borderRadius: 10 },
  backText: { color: "#FFD700", fontSize: 16 },

  sectionTitle: { color: "#AEB3BB", fontSize: 13, marginTop: 10, marginBottom: 6, paddingHorizontal: 12 },

  threadItem: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 12, paddingHorizontal: 14, backgroundColor: "#17181D",
    borderRadius: 14, marginBottom: 10, marginHorizontal: 12,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.06)",
  },
  avatar: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: "#242733",
    alignItems: "center", justifyContent: "center", marginRight: 12,
  },
  avatarImg: {
    backgroundColor: "#242733",
    marginRight: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  avatarTxt: { color: "#FFD700", fontWeight: "900", fontSize: 16 },
  threadTextCol: { flex: 1 },
  threadTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  threadName: { color: "#FFF", fontSize: 15, fontWeight: "800", flex: 1, marginRight: 8 },
  threadTime: { color: "#8A8F98", fontSize: 12 },
  threadBottomRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 3 },
  threadPreview: { color: "#C0C5CF", fontSize: 13, flex: 1, marginRight: 8 },
  unreadBadge: { minWidth: 22, paddingHorizontal: 7, height: 20, borderRadius: 10, backgroundColor: "#E63946", alignItems: "center", justifyContent: "center" },
  unreadTxt: { color: "#FFF", fontWeight: "800", fontSize: 12 },

  searchInput: {
    backgroundColor: "#17181D",
    padding: 12,
    color: "#FFF",
    borderRadius: 12,
    marginHorizontal: 12,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.06)",
  },
  userItem: { padding: 12, backgroundColor: "#17181D", borderRadius: 12, marginBottom: 8, marginHorizontal: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.06)" },
  userRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  userText: { color: "#FFF", fontSize: 15, fontWeight: "600" },

  messagesList: { flex: 1, backgroundColor: "#0F1012" },
  messagesListContent: { paddingHorizontal: 8, paddingBottom: 6, paddingTop: 8 },

  bubble: {
    maxWidth: "90%",
    marginVertical: 5,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 16,
    marginHorizontal: 6,
  },
  bubbleMine: { alignSelf: "flex-end", backgroundColor: "#3E4A76" },
  bubbleTheirs: { alignSelf: "flex-start", backgroundColor: "#1C1E24", borderWidth: 1, borderColor: "rgba(255,255,255,0.06)" },
  bubbleText: { color: "#fff", fontSize: 16, lineHeight: 22 },
  bubbleTime: { color: "#D6DAE3", opacity: 0.7, fontSize: 11, marginTop: 4, alignSelf: "flex-end" },

  composerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "#0F1012",
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.06)",
  },
  composerInput: {
    flex: 1,
    backgroundColor: "#17181D",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: Platform.select({ ios: 10, android: 9, default: 9 }),
    color: "#FFF",
    fontSize: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  composerSend: { paddingHorizontal: 16, paddingVertical: 11, backgroundColor: "#4B6BFB", borderRadius: 14 },
  composerSendTxt: { color: "#FFF", fontWeight: "800" },
});

export default ChatScreen;
