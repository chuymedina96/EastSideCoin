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
import { WS_URL } from "../config";
import { encryptAES, encryptRSA, decryptAES, decryptRSA } from "../utils/encryption";
import { isKeysReady, loadPrivateKeyForUser } from "../utils/keyManager";
import { createOrGetChatSocket } from "../utils/wsClient";
import { api, fetchConversation, fetchThreadsIndex as _unused, searchUsersSmart } from "../utils/api"; // use direct returns

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
  const { user, keysReady, getAccessToken } = useContext(AuthContext);

  const userPrefix = user?.id ? `u${user.id}:` : "u?:";
  const threadsKey = `${userPrefix}${THREADS_KEY}`;
  const msgsKey = (otherId) => `${userPrefix}${MSGS_KEY_PREFIX}${asId(otherId)}`;

  const [mode, setMode] = useState("threads");
  const [threads, setThreads] = useState({});
  const [messages, setMessages] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const selectedUserRef = useRef(null);
  useEffect(() => { selectedUserRef.current = selectedUser; }, [selectedUser]);

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
  const pendingClientIdsRef = useRef(new Set());

  const [draft, setDraft] = useState("");
  const [sendInFlight, setSendInFlight] = useState(false);
  const listRef = useRef(null);
  const isComposingRef = useRef(false);

  // ---- Cache helpers
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
    try { await AsyncStorage.setItem(msgsKey(otherId), JSON.stringify(msgs)); } catch {}
  }, [msgsKey]);

  // ---- Server-backed threads index
  const fetchThreadsIndex = useCallback(async () => {
    try {
      const items = await api.get("/conversations/index/"); // <-- returns array
      const arr = Array.isArray(items) ? items : (Array.isArray(items?.results) ? items.results : []);
      const next = {};
      for (const t of arr) {
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
      saveCachedThreads(next);
      setDirectory((d) => ({ ...d, ...Object.fromEntries(arr.map((u) => [asId(u.id), u])) }));
    } catch (e) {
      console.warn("⚠️ fetchThreadsIndex failed:", e?.message || e);
      const cached = await loadCachedThreads();
      setThreads(cached || {});
    }
  }, [saveCachedThreads, loadCachedThreads]);

  const markThreadRead = useCallback(async (otherId) => {
    if (!otherId) return;
    try { await api.post(`/conversations/mark_read/${otherId}/`); } catch {}
  }, []);

  // ---- Bootstrap
  useEffect(() => {
    (async () => {
      setThreads({});
      setMessages([]);
      setSelectedUser(null);
      await fetchThreadsIndex();
    })();
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

  // Ensure process-wide privateKey is present
  useEffect(() => { (async () => {
    if (user?.id) {
      let perUser = await AsyncStorage.getItem(`privateKey_${user.id}`);
      if (!perUser) perUser = await AsyncStorage.getItem("privateKey");
      if (perUser) await AsyncStorage.setItem("privateKey", perUser);
    }
  })(); }, [user?.id]);

  // Reload index on focus
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

  // ---- Search (HTTP-only)
  const abortRef = useRef(null);
  const doRemoteSearch = useCallback(async (query) => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (!query || query.length < 2) { setSearchResults([]); setEffectiveQuery(query); return; }
    try {
      setEffectiveQuery(query);
      const data = await searchUsersSmart(query);
      if (ctrl.signal.aborted) return;
      setSearchResults(Array.isArray(data) ? data : []);
    } catch (err) {
      if (err.name !== "CanceledError" && err.name !== "AbortError") {
        console.error("❌ Error searching users:", err?.message || err);
      }
    }
  }, []);
  const debouncedSearchGateway = useRef(debounce((q) => { doRemoteSearch(q); }, 300)).current;
  const handleDebouncedSearch = useCallback((q) => { debouncedSearchGateway(q); }, [debouncedSearchGateway]);

  // ---- Conversation fetch
  const fetchConversationPage = useCallback(async (otherId, { page = 1, limit = 50, since = null } = {}) => {
    const params = { limit, page };
    if (since) params.since = since;
    // our api.get returns JSON directly
    return api.get(`/conversations/${otherId}/`, { params });
  }, []);

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

  const hydrateConversation = useCallback(async (neighbor, { onlyIfNewerThan } = {}) => {
    if (!neighbor?.id) return;
    const oid = String(neighbor.id);

    setLoadingHydrateId(oid);
    if (hydrateTimeoutRef.current) clearTimeout(hydrateTimeoutRef.current);
    hydrateTimeoutRef.current = setTimeout(() => { clearHydrateBanner(oid); }, 12000);

    try {
      let privateKeyPem = await AsyncStorage.getItem("privateKey");
      const myPublicKey = await AsyncStorage.getItem("publicKey");
      if (!privateKeyPem && user?.id) {
        privateKeyPem = await AsyncStorage.getItem(`privateKey_${user.id}`);
        if (privateKeyPem) await AsyncStorage.setItem("privateKey", privateKeyPem);
      }
      if (!privateKeyPem) return;

      // sanity check (non-fatal)
      try {
        const probe = encryptAES("probe");
        const wrapped = encryptRSA(probe.keyB64, myPublicKey);
        const unwrapped = decryptRSA(wrapped, privateKeyPem);
        if (b64FixPadding(unwrapped) !== b64FixPadding(probe.keyB64)) {
          console.warn("⚠️ Local keypair mismatch — decrypt may fail.");
        }
      } catch {}

      const apiResp = await fetchConversationPage(neighbor.id, {
        page: 1,
        limit: 50,
        since: onlyIfNewerThan || undefined,
      });

      const rows = Array.isArray(apiResp?.results) ? apiResp.results : (Array.isArray(apiResp) ? apiResp : []);
      const decrypted = rows
        .map(m => decryptServerMessage(m, privateKeyPem, user.id, neighbor))
        .filter(Boolean)
        .map(m => ({ ...m, _id: String(m._id), user: { ...m.user, _id: String(m.user._id) } }))
        .sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));

      if (decrypted.length > 0) {
        setMessages(prev => {
          const merged = mergeUniqueById(prev, decrypted);
          saveCachedMessages(neighbor.id, merged);
          return merged;
        });
      }

      pageRef.current = { next: apiResp?.next_page || null };
    } catch (e) {
      console.log("❌ hydrate error", e?.message);
    } finally {
      clearHydrateBanner(oid);
    }
  }, [fetchConversationPage, user?.id, saveCachedMessages, clearHydrateBanner]);

  // ---- WebSocket subscribe (mount once per user)
  useEffect(() => {
    if (!user?.id) return;
    let unsub = null;

    (async () => {
      await loadPrivateKeyForUser(user.id);

      if (wsSubRef.current?.unsubscribe) {
        try { wsSubRef.current.unsubscribe(); } catch {}
        wsSubRef.current = null;
      }

      const sub = createOrGetChatSocket({
        token: () => getAccessToken(), // always fresh
        baseUrl: WS_URL,   // e.g., "ws://192.168.1.131:8000"
        path: "/ws/chat/",
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

            setDirectory((d) => d[asId(otherId)] ? d : { ...d, [asId(otherId)]: { id: otherId } });

            const clientTmpId = incoming.client_tmp_id || incoming.client_id || incoming.tmp_id;
            if (String(senderId) === myIdStr && clientTmpId && pendingClientIdsRef.current.has(clientTmpId)) {
              pendingClientIdsRef.current.delete(clientTmpId);
              return;
            }

            const isTyping = isComposingRef.current === true;
            setThreads((t) => {
              const prev = t[asId(otherId)];
              const isIncoming = String(senderId) !== myIdStr;
              const shouldCountUnread =
                isIncoming && (!selectedUserRef.current || String(selectedUserRef.current.id) !== otherId) && !isTyping;
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

            // Only append to open conversation
            const activeSelected = selectedUserRef.current;
            if (!activeSelected || String(activeSelected.id) !== otherId) return;

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
              user: { _id: isMine ? String(user.id) : String(activeSelected.id), name: isMine ? "You" : nameOf(activeSelected) },
            };

            setMessages((prev) => {
              const merged = mergeUniqueById(prev, [newMsg]);
              if (activeSelected?.id) saveCachedMessages(activeSelected.id, merged);
              return merged;
            });

            setThreads((t) => {
              const next = upsertThread(
                t,
                { id: activeSelected.id, ...activeSelected },
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
    // ⚠️ keep deps minimal so typing/searching doesn't close WS
  }, [user?.id, getAccessToken]);

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

      const lastCachedAt = normalized.length
        ? new Date(normalized[normalized.length - 1].createdAt).toISOString()
        : null;
      const threadMeta = threads[asId(known.id)];
      const threadUpdatedAt = threadMeta?.updatedAt ? new Date(threadMeta.updatedAt).toISOString() : null;

      const shouldHydrate =
        !lastCachedAt ||
        (threadUpdatedAt && threadUpdatedAt > lastCachedAt) ||
        (threadMeta?.unread > 0);

      if (shouldHydrate) {
        hydrateConversation(known, { onlyIfNewerThan: lastCachedAt || undefined });
      }
    })();

    setThreads((t) => {
      const next = upsertThread(t, known, "", new Date(), false, { resetUnread: true });
      saveCachedThreads(next);
      return next;
    });
    setEffectiveQuery("");
    setSearchResults([]);
    markThreadRead(known.id);
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
    fetchThreadsIndex();
  };

  const sendMessage = async (messageVal) => {
    if (sendInFlight) return;
    const messageText = typeof messageVal === "string" ? messageVal : (messageVal?.text ?? "");
    const text = messageText.trim();
    if (!text) return;

    const sub = wsSubRef.current;
    if (!selectedUser || !sub) { Alert.alert("Not connected", "Chat connection not ready yet."); return; }

    const privateKey = await AsyncStorage.getItem("privateKey");
    const myPublicKey = await AsyncStorage.getItem("publicKey");
    if (!privateKey || !myPublicKey) {
      Alert.alert("Encryption Setup", "Your device keys are still generating. Try again in a moment.");
      return;
    }

    // Ensure socket is ready
    if (!sub.socket?.ready) {
      try { await sub.ready(); } catch { Alert.alert("WebSocket not connected. Try again."); return; }
    }

    try {
      setSendInFlight(true);

      let recipientPub = await AsyncStorage.getItem(`publicKey_${selectedUser.id}`);
      if (!recipientPub) {
        const resp = await api.get(`/users/${selectedUser.id}/public_key/`);
        if (!resp?.public_key) {
          Alert.alert("Encryption Error", "Public key not found for this user.");
          setSendInFlight(false);
          return;
        }
        recipientPub = resp.public_key;
        await AsyncStorage.setItem(`publicKey_${selectedUser.id}`, recipientPub);
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

  const messagesForUI = useMemo(() => messages.slice().reverse(), [messages]);

  // ---------- UI ----------
  const ThreadsList = () => {
    const items = Object.values(threads || {}).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
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
          keyExtractor={(t) => String(t.id)}
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
          <TouchableOpacity onPress={backToThreads} style={styles.backButton}><Text style={styles.backText}>←</Text></TouchableOpacity>
          <Text style={styles.headerName} numberOfLines={1}>{nameOf(selectedUser)}</Text>
          <View style={{ width: 36 }} />
        </View>

        {loadingBanner && (
          <View style={styles.loadingBanner}>
            <ActivityIndicator size="small" />
            <Text style={styles.loadingBannerText}> Loading messages…</Text>
          </View>
        )}

        <View style={{ flex: 1 }}>
          <FlatList
            ref={listRef}
            style={styles.messagesList}
            contentContainerStyle={styles.messagesListContent}
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
              <Composer
                draft={draft}
                setDraft={setDraft}
                sendMessage={sendMessage}
                sendInFlight={sendInFlight}
                isComposingRef={isComposingRef}
              />
            </KeyboardAvoidingView>
          ) : (
            <Composer
              draft={draft}
              setDraft={setDraft}
              sendMessage={sendMessage}
              sendInFlight={sendInFlight}
              isComposingRef={isComposingRef}
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

// ----- Composer -----
const Composer = ({ draft, setDraft, sendMessage, sendInFlight, isComposingRef }) => {
  return (
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
  );
};

// ---------- styles ----------
const styles = StyleSheet.create({
  safeContainer: { flex: 1, backgroundColor: "#0F1012" },

  // Header
  convHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  headerName: { color: "#FFF", fontSize: 18, fontWeight: "800", flex: 1, textAlign: "center" },

  backButton: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: "#1C1E24", borderRadius: 8 },
  backText: { color: "#FFD700", fontSize: 16 },

  loadingBanner: { flexDirection: "row", alignItems: "center", alignSelf: "center", marginVertical: 6 },
  loadingBannerText: { color: "#BDBDBD", marginLeft: 8 },

  sectionTitle: { color: "#AEB3BB", fontSize: 13, marginTop: 10, marginBottom: 6, paddingHorizontal: 12 },

  threadItem: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 10, paddingHorizontal: 12, backgroundColor: "#17181D",
    borderRadius: 12, marginBottom: 8, marginHorizontal: 12,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.06)",
  },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: "#242733", alignItems: "center", justifyContent: "center", marginRight: 10 },
  avatarTxt: { color: "#FFD700", fontWeight: "900", fontSize: 16 },
  threadTextCol: { flex: 1 },
  threadTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  threadName: { color: "#FFF", fontSize: 15, fontWeight: "800", flex: 1, marginRight: 8 },
  threadTime: { color: "#8A8F98", fontSize: 12 },
  threadBottomRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 2 },
  threadPreview: { color: "#C0C5CF", fontSize: 13, flex: 1, marginRight: 8 },
  unreadBadge: { minWidth: 20, paddingHorizontal: 6, height: 20, borderRadius: 10, backgroundColor: "#E63946", alignItems: "center", justifyContent: "center" },
  unreadTxt: { color: "#FFF", fontWeight: "800", fontSize: 12 },

  searchInput: {
    backgroundColor: "#17181D",
    padding: 12,
    color: "#FFF",
    borderRadius: 12,
    marginHorizontal: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  userItem: { padding: 12, backgroundColor: "#17181D", borderRadius: 12, marginBottom: 8, marginHorizontal: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.06)" },
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
  bubbleMine: {
    alignSelf: "flex-end",
    backgroundColor: "#3E4A76",
  },
  bubbleTheirs: {
    alignSelf: "flex-start",
    backgroundColor: "#1C1E24",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
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
  composerSend: { paddingHorizontal: 14, paddingVertical: 10, backgroundColor: "#4B6BFB", borderRadius: 14 },
  composerSendTxt: { color: "#FFF", fontWeight: "800" },
});

export default ChatScreen;
