// screens/ChatScreen.js
import React, { useState, useEffect, useContext, useCallback, useRef, useMemo } from "react";
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet,
  Alert, KeyboardAvoidingView, Platform, RefreshControl, ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import debounce from "lodash.debounce";

import { AuthContext } from "../context/AuthProvider";
import { API_URL } from "../config";
import { encryptAES, encryptRSA, decryptAES, decryptRSA } from "../utils/encryption";
import { isKeysReady, loadPrivateKeyForUser } from "../utils/keyManager";
import { createOrGetChatSocket } from "../utils/wsClient";

const THREADS_KEY = "chat_threads_index_v1";
const MSGS_KEY_PREFIX = "chat_msgs_";

// ---------- utils ----------
const asId = (v) => String(v ?? "");
const nameOf = (u) => (`${u?.first_name || ""} ${u?.last_name || ""}`.trim() || u?.email || "Neighbor");
const formatTime = (d) => {
  const date = typeof d === "string" ? new Date(d) : d;
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
};
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
  if (m.encrypted_key_for_me) return { which: "for_me", value: m.encrypted_key_for_me };

  const me = String(meId);
  const sender = String(m.sender ?? m.sender_id);
  const receiver = String(m.receiver ?? m.receiver_id);

  if (receiver === me && (m.encrypted_key_for_receiver || m.encrypted_key)) {
    return { which: "receiver", value: m.encrypted_key_for_receiver || m.encrypted_key };
  }
  if (sender === me && m.encrypted_key_for_sender) {
    return { which: "sender", value: m.encrypted_key_for_sender };
  }
  return { which: "none", value: null };
};

const decryptServerMessage = (raw, privateKeyPem, meId, otherUser) => {
  try {
    const m = normalizeWrapAliases(raw);
    const { value } = pickWrapForMe(m, meId);
    if (!value) return null;

    let keyB64;
    try {
      keyB64 = decryptRSA(b64FixPadding(value), privateKeyPem);
    } catch {
      return null;
    }

    const text = decryptAES({
      ciphertextB64: b64FixPadding(m.encrypted_message),
      ivB64: b64FixPadding(m.iv),
      macB64: b64FixPadding(m.mac),
      keyB64: b64FixPadding(keyB64),
    });
    if (!text || text === "[Auth Failed]" || text === "[Decryption Failed]") return null;

    const isMine = String(m.sender ?? m.sender_id) === String(meId);
    const createdAt =
      (m.timestamp ? new Date(m.timestamp) :
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

// Sticky-focus search
const UncontrolledLockedSearch = React.memo(function UncontrolledLockedSearch({
  placeholder = "🔍 Search neighbors…",
  initialValue = "",
  onDebouncedChange,
  debounceMs = 220,
  autoFocus = false,
}) {
  const inputRef = useRef(null);
  const lockFocus = useRef(true);
  const debouncedEmit = useMemo(
    () => debounce((q) => onDebouncedChange?.(q), debounceMs),
    [onDebouncedChange, debounceMs]
  );
  const onChangeText = useCallback((text) => { debouncedEmit(text); }, [debouncedEmit]);
  const onBlur = useCallback(() => {
    if (lockFocus.current && inputRef.current) setTimeout(() => inputRef.current?.focus(), 0);
  }, []);
  useEffect(() => {
    if (autoFocus) setTimeout(() => inputRef.current?.focus(), 0);
    return () => debouncedEmit.cancel();
  }, [autoFocus, debouncedEmit]);
  return (
    <View pointerEvents="box-none">
      <TextInput
        ref={inputRef}
        defaultValue={initialValue}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#AAA"
        style={styles.searchInput}
        autoCorrect={false}
        autoCapitalize="none"
        autoComplete="off"
        returnKeyType="search"
        blurOnSubmit={false}
        keyboardAppearance="dark"
        onBlur={onBlur}
      />
    </View>
  );
});

// =============== Component ===============
const ChatScreen = ({ navigation }) => {
  const { authToken, user, keysReady } = useContext(AuthContext);

  const userPrefix = user?.id ? `u${user.id}:` : "u?:";
  const threadsKey = `${userPrefix}${THREADS_KEY}`;
  const msgsKey = (otherId) => `${userPrefix}${MSGS_KEY_PREFIX}${asId(otherId)}`;

  const [mode, setMode] = useState("threads");
  const [threads, setThreads] = useState({});
  const [messages, setMessages] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);

  const [directory, setDirectory] = useState({});
  const [effectiveQuery, setEffectiveQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);

  const [refreshing, setRefreshing] = useState(false);
  const [readyLocal, setReadyLocal] = useState(keysReady);
  const effectiveReady = keysReady || readyLocal;

  const [loadingHydrateId, setLoadingHydrateId] = useState(null);
  const hydrateTimeoutRef = useRef(null);

  const pageRef = useRef({ next: null });
  const wsSubRef = useRef(null);
  const pendingClientIdsRef = useRef(new Set()); // de-dupe optimistic echoes

  const [draft, setDraft] = useState("");
  const [sendInFlight, setSendInFlight] = useState(false);
  const listRef = useRef(null);

  // prevent programmatic scroll from blurring composer while typing
  const isComposingRef = useRef(false);

  // ---- Cache helpers (still used as *cache*, server is source of truth)
  const loadCachedThreads = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(threadsKey);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }, [threadsKey]);

  const saveCachedThreads = useCallback(async (val) => {
    try { await AsyncStorage.setItem(threadsKey, JSON.stringify(val)); } catch {}
  }, [threadsKey]);

  const loadCachedMessages = useCallback(async (otherId) => {
    try {
      const raw = await AsyncStorage.getItem(msgsKey(otherId));
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }, [msgsKey]);

  const saveCachedMessages = useCallback(async (otherId, msgs) => {
    try { await AsyncStorage.setItem(msgsKey(otherId), JSON.stringify(msgs)); } catch {}
  }, [msgsKey]);

  // ---- Server-backed threads index
  const fetchThreadsIndex = useCallback(async () => {
    if (!authToken) return;
    try {
      const res = await fetch(`${API_URL}/conversations/index/`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) throw new Error(`index ${res.status}`);
      const items = await res.json(); // [{id, first_name, last_name, email, updatedAt, unread, lastText}]
      // Build state object
      const next = {};
      for (const t of items) {
        const id = asId(t.id);
        next[id] = {
          id,
          name: nameOf(t),
          meta: { first_name: t.first_name, last_name: t.last_name, email: t.email },
          lastText: t.lastText || "",
          updatedAt: t.updatedAt || new Date().toISOString(),
          unread: t.unread || 0,
        };
      }
      setThreads(next);
      saveCachedThreads(next); // cache the server index
      // also seed directory for names
      setDirectory((d) => ({ ...d, ...Object.fromEntries(items.map(u => [asId(u.id), u])) }));
    } catch (e) {
      console.warn("⚠️ fetchThreadsIndex failed:", e?.message || e);
      // fallback to cached
      const cached = await loadCachedThreads();
      setThreads(cached);
    }
  }, [authToken, saveCachedThreads, loadCachedThreads]);

  const markThreadRead = useCallback(async (otherId) => {
    if (!authToken || !otherId) return;
    try {
      await fetch(`${API_URL}/conversations/mark_read/${otherId}/`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
      });
    } catch {}
  }, [authToken]);

  // ---- Bootstrap
  useEffect(() => {
    let mounted = true;
    (async () => {
      setThreads({});
      setMessages([]);
      setSelectedUser(null);
      await fetchThreadsIndex(); // server-first
    })();
    return () => { mounted = false; };
  }, [user?.id, fetchThreadsIndex]);

  useEffect(() => { saveCachedThreads(threads); }, [threads, saveCachedThreads]);

  useEffect(() => {
    if (!Array.isArray(searchResults)) return;
    setDirectory((d) => {
      const next = { ...d };
      for (const u of searchResults) if (u?.id) next[asId(u.id)] = u;
      return next;
    });
  }, [searchResults]);

  // Ensure process-wide privateKey is present (fallback from per-user slot)
  useEffect(() => { (async () => {
    if (user?.id) {
      let perUser = await AsyncStorage.getItem(`privateKey_${user.id}`);
      if (!perUser) perUser = await AsyncStorage.getItem("privateKey");
      if (perUser) await AsyncStorage.setItem("privateKey", perUser);
    }
  })(); }, [user?.id]);

  // Reload server index when screen gains focus (catch up after background)
  useFocusEffect(useCallback(() => {
    let mounted = true;
    (async () => {
      if (user?.id) {
        const ok = await isKeysReady(user.id);
        if (mounted) {
          setReadyLocal(ok);
          await fetchThreadsIndex();
        }
        if (ok) await loadPrivateKeyForUser(user.id);
      }
    })();
    return () => { mounted = false; };
  }, [user?.id, fetchThreadsIndex]));

  // ---- Search
  const abortRef = useRef(null);
  const doRemoteSearch = useCallback(async (query) => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (!query || query.length < 2) { setSearchResults([]); setEffectiveQuery(query); return; }
    try {
      setEffectiveQuery(query);
      const url = `${API_URL}/users/search/?query=${encodeURIComponent(query)}`;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` }, signal: ctrl.signal });
      const data = await response.json();
      setSearchResults(Array.isArray(data) ? data : []);
    } catch (err) {
      if (err.name !== "AbortError") console.error("❌ Error searching users:", err);
    }
  }, [authToken]);
  const debouncedSearchGateway = useRef(debounce((q) => { doRemoteSearch(q); }, 300)).current;
  const handleDebouncedSearch = useCallback((q) => { debouncedSearchGateway(q); }, [debouncedSearchGateway]);

  // ---- Conversation fetch
  const fetchConversationPage = useCallback(async (otherId, { page = 1, limit = 50 } = {}) => {
    const url = `${API_URL}/conversations/${otherId}/?limit=${limit}&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
    if (!res.ok) throw new Error(`Conversation fetch failed: ${res.status}`);
    const data = await res.json();
    return data;
  }, [authToken]);

  const clearHydrateBanner = useCallback((oid) => {
    setLoadingHydrateId((curr) => (curr === oid ? null : curr));
    if (hydrateTimeoutRef.current) {
      clearTimeout(hydrateTimeoutRef.current);
      hydrateTimeoutRef.current = null;
    }
  }, []);

  const mergeUniqueById = (a, b) => {
    const map = new Map();
    for (const m of a) map.set(String(m._id), m);
    for (const m of b) map.set(String(m._id), m);
    return Array.from(map.values()).sort((x, y) => new Date(x.createdAt) - new Date(y.createdAt));
  };

  const hydrateConversation = useCallback(async (neighbor) => {
    if (!neighbor?.id) return;
    const oid = String(neighbor.id);

    setLoadingHydrateId(oid);
    if (hydrateTimeoutRef.current) clearTimeout(hydrateTimeoutRef.current);
    hydrateTimeoutRef.current = setTimeout(() => { clearHydrateBanner(oid); }, 12000);

    try {
      const cached = await loadCachedMessages(neighbor.id);
      const normalizedCached = (cached || []).map(m => ({
        ...m, _id: String(m._id),
        user: { ...m.user, _id: String(m.user?._id) },
        createdAt: new Date(m.createdAt),
      })).sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
      setMessages(normalizedCached);

      let privateKeyPem = await AsyncStorage.getItem("privateKey");
      const myPublicKey = await AsyncStorage.getItem("publicKey");
      if (!privateKeyPem && user?.id) {
        privateKeyPem = await AsyncStorage.getItem(`privateKey_${user.id}`);
        if (privateKeyPem) await AsyncStorage.setItem("privateKey", privateKeyPem);
      }
      if (!privateKeyPem) return;

      // sanity check keypair
      try {
        const probe = encryptAES("probe");
        const wrapped = encryptRSA(probe.keyB64, myPublicKey);
        const unwrapped = decryptRSA(wrapped, privateKeyPem);
        if (b64FixPadding(unwrapped) !== b64FixPadding(probe.keyB64)) {
          console.warn("⚠️ Local keypair mismatch — decrypt may fail.");
        }
      } catch {}

      const first = await fetchConversationPage(neighbor.id, { page: 1, limit: 50 });
      const decrypted = (first.results || [])
        .map(m => decryptServerMessage(m, privateKeyPem, user.id, neighbor))
        .filter(Boolean)
        .map(m => ({ ...m, _id: String(m._id), user: { ...m.user, _id: String(m.user._id) } }))
        .sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));

      setMessages(prev => {
        const merged = mergeUniqueById(prev, decrypted);
        saveCachedMessages(neighbor.id, merged);
        return merged;
      });

      pageRef.current = { next: first.next_page || null };
    } catch (e) {
      console.log("❌ hydrate error", e?.message);
    } finally {
      clearHydrateBanner(oid);
    }
  }, [fetchConversationPage, user?.id, loadCachedMessages, saveCachedMessages, clearHydrateBanner]);

  // ---- WebSocket subscribe (singleton + de-dupe)
  useEffect(() => {
    if (!authToken || !user?.id) return;

    let unsub = null;
    (async () => {
      await loadPrivateKeyForUser(user.id);

      if (wsSubRef.current?.socket && wsSubRef.current?.unsubscribe) {
        try { wsSubRef.current.unsubscribe(); } catch {}
        wsSubRef.current = null;
      }

      const sub = createOrGetChatSocket({
        token: authToken,
        userId: user.id,
        prefer: "query",
        onMessage: async (incomingRaw) => {
          try {
            const incoming = normalizeWrapAliases(incomingRaw);
            const senderId   = incoming.sender ?? incoming.sender_id ?? incoming.from_user;
            const receiverId = incoming.receiver ?? incoming.receiver_id ?? incoming.to_user;
            if (senderId == null || receiverId == null) return;

            const myIdStr = String(user.id);
            const otherId = String(senderId) === myIdStr ? String(receiverId) : String(senderId);

            // maintain minimal directory entry
            setDirectory((d) => d[asId(otherId)] ? d : { ...d, [asId(otherId)]: { id: otherId } });

            // echo filter for our optimistic sends
            const clientTmpId = incoming.client_tmp_id || incoming.client_id || incoming.tmp_id;
            if (String(senderId) === myIdStr && clientTmpId && pendingClientIdsRef.current.has(clientTmpId)) {
              pendingClientIdsRef.current.delete(clientTmpId);
              return;
            }

            // ---- bump threads on *any* message, but don't tick unread while typing
            const isTyping = isComposingRef.current === true;
            setThreads((t) => {
              const prev = t[asId(otherId)];
              const isIncoming = String(senderId) !== myIdStr;
              const shouldCountUnread =
                isIncoming && (!selectedUser || String(selectedUser.id) !== otherId) && !isTyping;
              const next = upsertThread(
                t,
                { id: otherId, ...(prev?.meta || {}) },
                "New message",
                new Date(),
                shouldCountUnread
              );
              saveCachedThreads(next);
              return next;
            });

            // only decrypt + append if this convo is open and keys exist
            if (!selectedUser || String(selectedUser.id) !== otherId) return;

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

            const isMine = String(senderId) === myIdStr;
            const newMsg = {
              _id: String(incoming.id || `${Date.now()}_${Math.random()}`),
              text: decryptedText || "🔒 Encrypted Message",
              createdAt: incoming.timestamp ? new Date(incoming.timestamp)
                : (incoming.created_at ? new Date(incoming.created_at) : new Date()),
              user: { _id: isMine ? String(user.id) : String(selectedUser.id), name: isMine ? "You" : nameOf(selectedUser) },
            };

            setMessages((prev) => {
              const merged = mergeUniqueById(prev, [newMsg]);
              if (selectedUser?.id) saveCachedMessages(selectedUser.id, merged);
              return merged;
            });

            // reset unread for open convo
            setThreads((t) => {
              const next = upsertThread(
                t,
                { id: selectedUser.id, ...selectedUser },
                decryptedText,
                newMsg.createdAt,
                false,
                { resetUnread: true }
              );
              saveCachedThreads(next);
              return next;
            });
          } catch (e) {
            console.error("❌ onMessage handler error:", e);
          }
        },
      });

      wsSubRef.current = sub;
      unsub = () => { try { sub.unsubscribe?.(); } catch {} wsSubRef.current = null; };
    })();

    return () => { if (unsub) unsub(); };
  }, [authToken, user?.id, selectedUser, saveCachedThreads, saveCachedMessages]);

  // ---- Thread helpers
  const upsertThread = (threads, otherUser, lastText, at, countUnread, opts = {}) => {
    const key = asId(otherUser.id);
    const prev = threads[key] || {
      id: key,
      name: nameOf(otherUser),
      meta: {
        first_name: otherUser.first_name,
        last_name: otherUser.last_name,
        email: otherUser.email,
      },
      lastText: "",
      updatedAt: new Date().toISOString(),
      unread: 0,
    };
    const nextName = nameOf({ ...prev.meta, ...otherUser }) || prev.name;
    return {
      ...threads,
      [key]: {
        ...prev,
        name: nextName,
        meta: {
          first_name: (otherUser.first_name ?? prev.meta?.first_name),
          last_name: (otherUser.last_name ?? prev.meta?.last_name),
          email: (otherUser.email ?? prev.meta?.email),
        },
        lastText: typeof lastText === "string" ? lastText : prev.lastText,
        updatedAt: (at || new Date()).toISOString(),
        unread: opts.resetUnread ? 0 : Math.max(0, (prev.unread || 0) + (countUnread ? 1 : 0)),
      },
    };
  };

  // ---- actions
  const openConversation = (neighbor) => {
    if (!neighbor?.id) return;
    const known = directory[asId(neighbor.id)] || neighbor;

    setSelectedUser(known);
    setMode("conversation");

    (async () => {
      const cached = await loadCachedMessages(known.id);
      const normalized = (cached || []).map(m => ({
        ...m,
        _id: String(m._id),
        user: { ...m.user, _id: String(m.user?._id) },
        createdAt: new Date(m.createdAt),
      })).sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
      setMessages(normalized);
    })();

    setThreads((t) => {
      const next = upsertThread(t, known, "", new Date(), false, { resetUnread: true });
      saveCachedThreads(next);
      return next;
    });
    setEffectiveQuery("");
    setSearchResults([]);

    // tell server unread=0
    markThreadRead(known.id);
    hydrateConversation(known);
  };

  const backToThreads = () => {
    setMode("threads");
    if (selectedUser?.id) {
      setThreads((t) => {
        const next = upsertThread(t, selectedUser, "", new Date(), false, { resetUnread: true });
        saveCachedThreads(next);
        return next;
      });
      markThreadRead(selectedUser.id);
    }
    setSelectedUser(null);
    setMessages([]);
    // also refresh from server (ensures unread is reflected)
    fetchThreadsIndex();
  };

  const sendMessage = async (messageVal) => {
    if (sendInFlight) return;
    const messageText = typeof messageVal === "string" ? messageVal : (messageVal?.text ?? "");
    const text = messageText.trim();
    if (!text) return;

    const sub = wsSubRef.current;
    const activeSocket = sub?.socket;
    if (!selectedUser || !activeSocket) { Alert.alert("Not connected", "Chat connection not ready yet."); return; }

    const privateKey = await AsyncStorage.getItem("privateKey");
    const myPublicKey = await AsyncStorage.getItem("publicKey");
    if (!privateKey || !myPublicKey) {
      Alert.alert("Encryption Setup", "Your device keys are still generating. Try again in a moment.");
      return;
    }
    if (activeSocket.readyState !== WebSocket.OPEN) {
      Alert.alert("WebSocket not connected. Try again.");
      return;
    }

    try {
      setSendInFlight(true);

      let recipientPub = await AsyncStorage.getItem(`publicKey_${selectedUser.id}`);
      if (!recipientPub) {
        const response = await fetch(`${API_URL}/users/${selectedUser.id}/public_key/`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        const data = await response.json();
        if (!data?.public_key) {
          Alert.alert("Encryption Error", "Public key not found for this user.");
          setSendInFlight(false);
          return;
        }
        recipientPub = data.public_key;
        await AsyncStorage.setItem(`publicKey_${selectedUser.id}`, recipientPub);
      }

      const bundle = encryptAES(text);
      const encrypted_key_for_receiver = encryptRSA(bundle.keyB64, recipientPub);
      const encrypted_key_for_sender   = encryptRSA(bundle.keyB64, myPublicKey);

      // optimistic add
      const now = new Date();
      const optimisticId = `opt_${now.getTime()}_${Math.random()}`;
      pendingClientIdsRef.current.add(optimisticId);
      const optimistic = {
        _id: optimisticId,
        text,
        createdAt: now,
        user: { _id: String(user.id), name: "You" },
      };
      setMessages((prev) => {
        const merged = mergeUniqueById(prev, [optimistic]);
        if (selectedUser?.id) saveCachedMessages(selectedUser.id, merged);
        return merged;
      });
      setThreads((t) => {
        const next = upsertThread(t, selectedUser, text, now, false);
        saveCachedThreads(next);
        return next;
      });
      setDraft("");

      if (!isComposingRef.current) {
        requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: true }));
      }

      // send over WS
      sub.send({
        receiver_id: selectedUser.id,
        encrypted_message: bundle.ciphertextB64,
        encrypted_key_for_receiver,
        encrypted_key_for_sender,
        iv: bundle.ivB64,
        mac: bundle.macB64,
        client_tmp_id: optimisticId,
      });
    } catch (error) {
      console.error("❌ Error sending message:", error);
      Alert.alert("Send Error", "Failed to send message.");
    } finally {
      setTimeout(() => setSendInFlight(false), 200);
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchThreadsIndex().finally(() => setRefreshing(false));
  }, [fetchThreadsIndex]);

  // newest-first for FlatList inverted
  const messagesForUI = useMemo(() => messages.slice().reverse(), [messages]);

  // ---------- UI ----------
  const ThreadsList = () => {
    const items = Object.values(threads).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return (
      <View style={{ flex: 1 }}>
        <Text style={styles.sectionTitle}>Start new</Text>
        <UncontrolledLockedSearch initialValue={effectiveQuery} onDebouncedChange={handleDebouncedSearch} />
        {effectiveQuery.length >= 2 && (
          <View style={{ maxHeight: 260 }}>
            <FlatList
              data={searchResults}
              keyExtractor={(u) => asId(u.id)}
              keyboardShouldPersistTaps="always"
              keyboardDismissMode="none"
              removeClippedSubviews={false}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.userItem} onPress={() => openConversation(item)}>
                  <Text style={styles.userText}>{item.first_name} {item.last_name}</Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={<Text style={{ color: "#888", textAlign: "center", marginTop: 12 }}>No matches.</Text>}
            />
          </View>
        )}

        <Text style={[styles.sectionTitle, { marginTop: 10 }]}>Conversations</Text>
        <FlatList
          data={items}
          keyExtractor={(t) => t.id}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="none"
          removeClippedSubviews={false}
          contentContainerStyle={{ paddingBottom: 12 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.threadItem}
              onPress={() => openConversation({
                id: item.id,
                first_name: item.meta?.first_name,
                last_name: item.meta?.last_name,
                email: item.meta?.email,
              })}
            >
              <View style={styles.avatar}><Text style={styles.avatarTxt}>{item.name?.[0]?.toUpperCase() || "N"}</Text></View>
              <View style={styles.threadTextCol}>
                <View style={styles.threadTopRow}>
                  <Text numberOfLines={1} style={styles.threadName}>{item.name}</Text>
                  <Text style={styles.threadTime}>{formatTime(item.updatedAt)}</Text>
                </View>
                <View style={styles.threadBottomRow}>
                  <Text numberOfLines={1} style={styles.threadPreview}>{item.lastText || "Start the conversation"}</Text>
                  {item.unread > 0 && (<View style={styles.unreadBadge}><Text style={styles.unreadTxt}>{item.unread}</Text></View>)}
                </View>
              </View>
            </TouchableOpacity>
          )}
          ListEmptyComponent={<Text style={{ color: "#888", textAlign: "center", marginTop: 20 }}>No conversations yet. Start one above.</Text>}
        />
      </View>
    );
  };

  const Conversation = React.memo(function ConversationInner() {
    if (!effectiveReady) {
      return (
        <View style={{ padding: 20, alignItems: "center" }}>
          <ActivityIndicator size="large" />
          <Text style={{ color: "#FFF", marginTop: 10, textAlign: "center" }}>
            Setting up your encryption keys… You can browse services while we finish.
          </Text>
          <TouchableOpacity style={[styles.backButton, { marginTop: 16 }]} onPress={() => navigation.navigate("Services")}>
            <Text style={styles.backText}>Go to Services</Text>
          </TouchableOpacity>
        </View>
      );
    }
    const loadingBanner = loadingHydrateId && String(selectedUser?.id) === String(loadingHydrateId);

    return (
      <>
        <View style={styles.convHeader}>
          <TouchableOpacity onPress={backToThreads} style={styles.backButton}><Text style={styles.backText}>← Back</Text></TouchableOpacity>
          <Text style={styles.headerName}>{nameOf(selectedUser)}</Text>
        </View>

        {loadingBanner && (
          <View style={styles.loadingBanner}>
            <ActivityIndicator size="small" />
            <Text style={styles.loadingBannerText}> Loading messages…</Text>
          </View>
        )}

        {pageRef.current?.next && (
          <TouchableOpacity onPress={() => { /* optional: implement loadOlder */ }} style={{ paddingVertical: 8, alignSelf: "center" }}>
            <Text style={{ color: "#9cc1ff" }}>Load earlier</Text>
          </TouchableOpacity>
        )}

        <View style={{ flex: 1 }}>
          <FlatList
            ref={listRef}
            style={{ flex: 1 }}
            inverted
            data={messagesForUI}
            keyExtractor={(m) => String(m._id)}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="interactive"
            removeClippedSubviews={false}
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
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
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          />

          {Platform.OS === "ios" ? (
            <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={80}>
              <View style={styles.composerRow}>
                <TextInput
                  value={draft}
                  onChangeText={(t) => { isComposingRef.current = true; setDraft(t); }}
                  placeholder="Type a message…"
                  placeholderTextColor="#AAA"
                  style={styles.composerInput}
                  autoCorrect={false}
                  autoCapitalize="none"
                  blurOnSubmit={false}
                  autoFocus={false}
                  importantForAutofill="no"
                  textContentType="none"
                  enablesReturnKeyAutomatically
                  returnKeyType="send"
                  scrollEnabled={false}
                  onFocus={() => { isComposingRef.current = true; }}
                  onBlur={() => { setTimeout(() => { isComposingRef.current = false; }, 50); }}
                  onSubmitEditing={() => {
                    const t = (draft || "").trim();
                    if (!t) return;
                    setDraft("");
                    isComposingRef.current = false;
                    sendMessage(t);
                  }}
                />
                <TouchableOpacity
                  style={styles.composerSend}
                  onPress={() => {
                    const t = (draft||"").trim();
                    if (!t) return;
                    setDraft("");
                    isComposingRef.current = false;
                    sendMessage(t);
                  }}
                  disabled={sendInFlight}
                >
                  <Text style={styles.composerSendTxt}>{sendInFlight ? "…" : "Send"}</Text>
                </TouchableOpacity>
              </View>
            </KeyboardAvoidingView>
          ) : (
            <View style={styles.composerRow}>
              <TextInput
                value={draft}
                onChangeText={(t) => { isComposingRef.current = true; setDraft(t); }}
                placeholder="Type a message…"
                placeholderTextColor="#AAA"
                style={styles.composerInput}
                autoCorrect={false}
                autoCapitalize="none"
                blurOnSubmit={false}
                autoFocus={false}
                importantForAutofill="no"
                textContentType="none"
                enablesReturnKeyAutomatically
                returnKeyType="send"
                scrollEnabled={false}
                onFocus={() => { isComposingRef.current = true; }}
                onBlur={() => { setTimeout(() => { isComposingRef.current = false; }, 50); }}
                onSubmitEditing={() => {
                  const t = (draft || "").trim();
                  if (!t) return;
                  setDraft("");
                  isComposingRef.current = false;
                  sendMessage(t);
                }}
              />
              <TouchableOpacity
                style={styles.composerSend}
                onPress={() => {
                  const t = (draft||"").trim();
                  if (!t) return;
                  setDraft("");
                  isComposingRef.current = false;
                  sendMessage(t);
                }}
                disabled={sendInFlight}
              >
                <Text style={styles.composerSendTxt}>{sendInFlight ? "…" : "Send"}</Text>
              </TouchableOpacity>
            </View>
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

// ---------- styles ----------
const styles = StyleSheet.create({
  safeContainer: { flex: 1, backgroundColor: "#1E1E1E" },
  container: { flex: 1, padding: 12 },

  convHeader: { flexDirection: "row", alignItems: "center", marginBottom: 8, paddingHorizontal: 12, paddingTop: 12 },
  headerName: { color: "#FFF", fontSize: 18, fontWeight: "700", marginLeft: 8 },

  backButton: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: "#333", borderRadius: 6, alignSelf: "flex-start" },
  backText: { color: "#FFD700", fontSize: 16 },

  loadingBanner: { flexDirection: "row", alignItems: "center", alignSelf: "center", marginBottom: 6 },
  loadingBannerText: { color: "#BDBDBD", marginLeft: 8 },

  sectionTitle: { color: "#BDBDBD", fontSize: 13, marginTop: 8, marginBottom: 6, paddingHorizontal: 12 },

  threadItem: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 10, paddingHorizontal: 12, backgroundColor: "#272727",
    borderRadius: 10, marginBottom: 8, marginHorizontal: 12,
  },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: "#3A3A3A", alignItems: "center", justifyContent: "center", marginRight: 10 },
  avatarTxt: { color: "#FFD700", fontWeight: "800", fontSize: 16 },
  threadTextCol: { flex: 1 },
  threadTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  threadName: { color: "#FFF", fontSize: 15, fontWeight: "700", flex: 1, marginRight: 8 },
  threadTime: { color: "#888", fontSize: 12 },
  threadBottomRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 2 },
  threadPreview: { color: "#BEBEBE", fontSize: 13, flex: 1, marginRight: 8 },
  unreadBadge: { minWidth: 20, paddingHorizontal: 6, height: 20, borderRadius: 10, backgroundColor: "#E63946", alignItems: "center", justifyContent: "center" },
  unreadTxt: { color: "#FFF", fontWeight: "700", fontSize: 12 },

  searchInput: { backgroundColor: "#222", padding: 12, color: "#FFF", borderRadius: 10, marginHorizontal: 12 },
  userItem: { padding: 12, backgroundColor: "#2C2C2C", borderRadius: 8, marginBottom: 8, marginHorizontal: 12 },
  userText: { color: "#FFF", fontSize: 15 },

  // Chat bubbles
  bubble: { maxWidth: "78%", marginVertical: 4, padding: 10, borderRadius: 10, marginHorizontal: 12 },
  bubbleMine: { alignSelf: "flex-end", backgroundColor: "#3a3f5a" },
  bubbleTheirs: { alignSelf: "flex-start", backgroundColor: "#2f2f2f" },
  bubbleText: { color: "#fff", fontSize: 15 },
  bubbleTime: { color: "#ccc", fontSize: 11, marginTop: 4, alignSelf: "flex-end" },

  // Composer
  composerRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 8, paddingHorizontal: 12, paddingBottom: 10, backgroundColor: "#1E1E1E" },
  composerInput: { flex: 1, backgroundColor: "#333", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: "#FFF" },
  composerSend: { paddingHorizontal: 14, paddingVertical: 10, backgroundColor: "#4B6BFB", borderRadius: 10, marginLeft: 6 },
  composerSendTxt: { color: "#FFF", fontWeight: "700" },
});

export default ChatScreen;
