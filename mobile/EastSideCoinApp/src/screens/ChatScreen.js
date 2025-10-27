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
import SimpleChat from "react-native-simple-chat";

import { AuthContext } from "../context/AuthProvider";
import { API_URL, WS_URL } from "../config";
import { encryptAES, encryptRSA, decryptAES, decryptRSA } from "../utils/encryption";
import { isKeysReady, loadPrivateKeyForUser } from "../utils/keyManager";

const THREADS_KEY = "chat_threads_index_v1";
const MSGS_KEY_PREFIX = "chat_msgs_"; // per-thread cache

// ---------- helpers ----------
const asId = (v) => String(v ?? "");
const formatTime = (d) => {
  const date = typeof d === "string" ? new Date(d) : d;
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
};
const nameOf = (u) => (`${u?.first_name || ""} ${u?.last_name || ""}`.trim() || u?.email || "Neighbor");

/** threads shape:
 * { [otherUserId: string]: { id, name, lastText, updatedAt, unread } }
 */
const upsertThread = (threads, otherUser, lastText, at, isIncoming) => {
  const key = asId(otherUser.id);
  const prev = threads[key] || {
    id: key,
    name: nameOf(otherUser),
    lastText: "",
    updatedAt: new Date().toISOString(),
    unread: 0,
  };
  return {
    ...threads,
    [key]: {
      ...prev,
      name: nameOf(otherUser),
      lastText: typeof lastText === "string" ? lastText : prev.lastText,
      updatedAt: (at || new Date()).toISOString(),
      unread: Math.max(0, (prev.unread || 0) + (isIncoming ? 1 : 0)),
    },
  };
};

const loadCachedMessages = async (otherId) => {
  try {
    const raw = await AsyncStorage.getItem(`${MSGS_KEY_PREFIX}${otherId}`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
};
const saveCachedMessages = async (otherId, msgs) => {
  try { await AsyncStorage.setItem(`${MSGS_KEY_PREFIX}${otherId}`, JSON.stringify(msgs)); } catch {}
};

// ---------- tolerant server->UI decryption ----------
const pickWrapForMe = (m, meId) => {
  // Preferred (new API): server gives the one we can open
  if (m.encrypted_key_for_me) return m.encrypted_key_for_me;

  // Legacy compatibility:
  const me = String(meId);
  const sender = String(m.sender ?? m.sender_id);
  const receiver = String(m.receiver ?? m.receiver_id);

  if (receiver === me && (m.encrypted_key_for_receiver || m.encrypted_key)) {
    return m.encrypted_key_for_receiver || m.encrypted_key;
  }
  if (sender === me && m.encrypted_key_for_sender) {
    return m.encrypted_key_for_sender;
  }
  return null;
};

const decryptServerMessage = (m, privateKeyPem, meId, otherUser) => {
  const wrap = pickWrapForMe(m, meId);
  if (!wrap) return null;
  let keyB64;
  try { keyB64 = decryptRSA(wrap, privateKeyPem); } catch { return null; }

  const text = decryptAES({
    ciphertextB64: m.encrypted_message,
    ivB64: m.iv,
    macB64: m.mac,
    keyB64,
  });
  if (!text || text === "[Auth Failed]" || text === "[Decryption Failed]") return null;

  const isMine = String(m.sender ?? m.sender_id) === String(meId);
  const createdAt =
    (m.timestamp ? new Date(m.timestamp) :
     m.created_at ? new Date(m.created_at) : new Date());

  return {
    _id: m.id || Math.random().toString(),
    text,
    createdAt,
    user: { _id: isMine ? meId : otherUser.id, name: isMine ? "You" : nameOf(otherUser) },
    __server: true,
  };
};

// ---- Uncontrolled, focus-locked search input (no React state per keystroke) ----
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
  const onBlur = useCallback(() => { if (lockFocus.current && inputRef.current) setTimeout(() => inputRef.current?.focus(), 0); }, []);
  useEffect(() => { if (autoFocus) setTimeout(() => inputRef.current?.focus(), 0); return () => debouncedEmit.cancel(); }, [autoFocus, debouncedEmit]);
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

const ChatScreen = ({ navigation }) => {
  const { authToken, user, keysReady } = useContext(AuthContext);

  const [mode, setMode] = useState("threads"); // 'threads' | 'conversation'
  const [threads, setThreads] = useState({});
  const [messages, setMessages] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);

  // Search (debounced)
  const [effectiveQuery, setEffectiveQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);

  const [refreshing, setRefreshing] = useState(false);
  const [readyLocal, setReadyLocal] = useState(keysReady);
  const effectiveReady = keysReady || readyLocal;

  // Pagination for conversation history
  const pageRef = useRef({ next: null });

  // WebSocket management
  const wsRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const shouldReconnectRef = useRef(false);
  const modeRef = useRef(mode);
  const maxReconnects = 3;
  useEffect(() => { modeRef.current = mode; }, [mode]);

  // Load persisted threads on mount
  useEffect(() => { (async () => {
    try { const raw = await AsyncStorage.getItem(THREADS_KEY); if (raw) setThreads(JSON.parse(raw)); } catch {}
  })(); }, []);
  useEffect(() => { AsyncStorage.setItem(THREADS_KEY, JSON.stringify(threads)).catch(() => {}); }, [threads]);

  // Hydrate default privateKey slot when user changes
  useEffect(() => { (async () => {
    if (user?.id) {
      const perUser = await AsyncStorage.getItem(`privateKey_${user.id}`);
      if (perUser) await AsyncStorage.setItem("privateKey", perUser);
    }
  })(); }, [user?.id]);

  // Re-check key readiness on focus
  useFocusEffect(useCallback(() => {
    let mounted = true;
    (async () => {
      if (user?.id) {
        const ok = await isKeysReady(user.id);
        if (mounted) setReadyLocal(ok);
        if (ok) await loadPrivateKeyForUser(user.id);
      }
    })();
    return () => { mounted = false; };
  }, [user?.id]));

  // ---------- Search (debounced + abortable) ----------
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

  // ---------- Conversation fetch (DB) ----------
  const fetchConversationPage = useCallback(async (otherId, { page = 1, limit = 50 } = {}) => {
    const url = `${API_URL}/conversations/${otherId}/?limit=${limit}&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
    if (!res.ok) throw new Error(`Conversation fetch failed: ${res.status}`);
    const data = await res.json();
    return data; // { results, next_page, prev_page, count }
  }, [authToken]);

  const hydrateConversation = useCallback(async (neighbor) => {
    try {
      // 1) Show cached immediately
      const cached = await loadCachedMessages(neighbor.id);
      if (cached.length) {
        const normalized = cached.map(m => ({ ...m, createdAt: new Date(m.createdAt) }))
                                 .sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
        setMessages(normalized);
      } else {
        setMessages([]);
      }

      // 2) Fetch from DB and replace
      const privateKeyPem = await AsyncStorage.getItem("privateKey");
      if (!privateKeyPem) return;

      const first = await fetchConversationPage(neighbor.id, { page: 1, limit: 50 });

      const decrypted = (first.results || [])
        .map(m => decryptServerMessage(m, privateKeyPem, user.id, neighbor))
        .filter(Boolean)
        .sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));

      setMessages(decrypted);
      saveCachedMessages(neighbor.id, decrypted);
      pageRef.current = { next: first.next_page || null };
      console.log("[hydrate] decrypted msgs (after filter):", decrypted.length);
    } catch (e) {
      console.log("conversation hydrate error", e?.message);
    }
  }, [fetchConversationPage, user?.id]);

  const loadOlder = useCallback(async () => {
    const pg = pageRef.current?.next;
    if (!pg || !selectedUser) return;
    try {
      const privateKeyPem = await AsyncStorage.getItem("privateKey");
      if (!privateKeyPem) return;
      const data = await fetchConversationPage(selectedUser.id, { page: pg, limit: 50 });
      const older = (data.results || [])
        .map(m => decryptServerMessage(m, privateKeyPem, user.id, selectedUser))
        .filter(Boolean)
        .sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
      setMessages(prev => {
        const map = new Map(prev.map(m => [String(m._id), m]));
        older.forEach(m => map.set(String(m._id), m));
        const merged = Array.from(map.values()).sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
        saveCachedMessages(selectedUser.id, merged);
        return merged;
      });
      pageRef.current = { next: data.next_page || null };
    } catch (e) {
      console.log("loadOlder error", e?.message);
    }
  }, [selectedUser, fetchConversationPage, user?.id]);

  // ---------- WebSocket lifecycle (conversation only) ----------
  useEffect(() => {
    if (mode !== "conversation" || !selectedUser || !authToken || !effectiveReady) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    shouldReconnectRef.current = true;

    const openSocket = () => {
      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        try { wsRef.current.close(); } catch {}
      }
      const ws = new WebSocket(`${WS_URL}/chat/?token=${authToken}`);
      wsRef.current = ws;

      ws.onopen = () => { reconnectAttemptsRef.current = 0; };

      ws.onmessage = async (event) => {
        try {
          const incoming = JSON.parse(event.data);
          const privateKeyPem = await AsyncStorage.getItem("privateKey");
          if (!privateKeyPem) return;

          // Prefer per-caller wrap if provided by WS; else fall back
          let wrap = incoming.encrypted_key_for_me
            || incoming.encrypted_key_sender
            || incoming.encrypted_key; // receiver wrap

          if (!wrap) return;

          let keyB64;
          try { keyB64 = decryptRSA(wrap, privateKeyPem); } catch { return; }

          const decryptedText = decryptAES({
            ciphertextB64: incoming.encrypted_message,
            ivB64: incoming.iv,
            macB64: incoming.mac,
            keyB64,
          });

          const isMine = String(incoming.sender ?? incoming.sender_id) === String(user.id);
          const otherId = isMine
            ? (incoming.receiver ?? incoming.receiver_id)
            : (incoming.sender ?? incoming.sender_id);

          const newMsg = {
            _id: incoming.id || Math.random().toString(),
            text: decryptedText || "🔒 Encrypted Message",
            createdAt: incoming.timestamp ? new Date(incoming.timestamp)
              : (incoming.created_at ? new Date(incoming.created_at) : new Date()),
            user: { _id: isMine ? user.id : otherId, name: isMine ? "You" : nameOf(selectedUser) },
          };

          setMessages((prev) => {
            const next = [...prev, newMsg].sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
            if (selectedUser?.id) saveCachedMessages(selectedUser.id, next);
            return next;
          });

          setThreads((t) => upsertThread(t, { id: otherId }, decryptedText, newMsg.createdAt, !isMine));
        } catch (e) {
          console.error("❌ onmessage error:", e);
        }
      };

      ws.onerror = (e) => console.warn("[ws] error", e?.message || e);
      ws.onclose = () => {
        const should = shouldReconnectRef.current && modeRef.current === "conversation";
        if (should && selectedUser && authToken && effectiveReady && reconnectAttemptsRef.current < maxReconnects) {
          reconnectAttemptsRef.current += 1;
          setTimeout(openSocket, 500 * reconnectAttemptsRef.current);
        }
      };
    };

    openSocket();
    return () => {
      shouldReconnectRef.current = false;
      if (wsRef.current) { try { wsRef.current.close(); } catch {} wsRef.current = null; }
    };
  }, [mode, selectedUser, authToken, effectiveReady, user?.id]);

  // ---- actions ----
  const openConversation = (neighbor) => {
    if (!neighbor?.id) return;
    setThreads((t) => upsertThread(t, neighbor, "", new Date(), false));
    setSelectedUser(neighbor);
    setMessages([]);
    setMode("conversation");
    setEffectiveQuery("");
    setSearchResults([]);
    hydrateConversation(neighbor);
  };

  const backToThreads = () => {
    setMode("threads");
    setSelectedUser(null);
    setMessages([]);
    shouldReconnectRef.current = false;
    if (wsRef.current) { try { wsRef.current.close(); } catch {} wsRef.current = null; }
  };

  const sendMessage = async (messageText) => {
    const ws = wsRef.current;
    if (!selectedUser || !ws) return;

    const privateKey = await AsyncStorage.getItem("privateKey");
    const myPublicKey = await AsyncStorage.getItem("publicKey");
    if (!privateKey || !myPublicKey) {
      Alert.alert("Encryption Setup", "Your device keys are still generating. Try again in a moment.");
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      Alert.alert("WebSocket not connected. Try again.");
      return;
    }

    try {
      // get/cache recipient public key
      let recipientPub = await AsyncStorage.getItem(`publicKey_${selectedUser.id}`);
      if (!recipientPub) {
        const response = await fetch(`${API_URL}/users/${selectedUser.id}/public_key/`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        const data = await response.json();
        if (!data?.public_key) {
          Alert.alert("Encryption Error", "Public key not found for this user.");
          return;
        }
        recipientPub = data.public_key;
        await AsyncStorage.setItem(`publicKey_${selectedUser.id}`, recipientPub);
      }

      // Encrypt message with fresh AES; wrap for both parties
      const bundle = encryptAES(messageText);
      const encrypted_key_for_receiver = encryptRSA(bundle.keyB64, recipientPub);
      const encrypted_key_for_sender   = encryptRSA(bundle.keyB64, myPublicKey);

      ws.send(JSON.stringify({
        receiver_id: selectedUser.id,
        encrypted_message: bundle.ciphertextB64,
        encrypted_key_for_receiver,
        encrypted_key_for_sender,
        iv: bundle.ivB64,
        mac: bundle.macB64,
      }));

      const now = new Date();
      const optimistic = {
        _id: Math.random().toString(),
        text: messageText,
        createdAt: now,
        user: { _id: user.id, name: "You" },
      };

      setMessages((prev) => {
        const next = [...prev, optimistic].sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
        if (selectedUser?.id) saveCachedMessages(selectedUser.id, next);
        return next;
      });

      setThreads((t) => upsertThread(t, selectedUser, messageText, now, false));
    } catch (error) {
      console.error("❌ Error sending message:", error);
      Alert.alert("Send Error", "Failed to send message.");
    }
  };

  const onRefresh = useCallback(() => { setRefreshing(true); setTimeout(() => setRefreshing(false), 600); }, []);
  const messagesForUI = useMemo(() => messages.slice().reverse(), [messages]); // SimpleChat wants newest-first

  // ---- UI blocks ----
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
                first_name: item.name.split(" ")[0],
                last_name: item.name.split(" ").slice(1).join(" ")
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
          ListEmptyComponent={<Text style={{ color: "#888", textAlign: "center", marginTop: 20 }}>No conversations yet. Search a neighbor to start one.</Text>}
        />
      </View>
    );
  };

  const Conversation = () => {
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
    return (
      <>
        <View style={styles.convHeader}>
          <TouchableOpacity onPress={backToThreads} style={styles.backButton}><Text style={styles.backText}>← Back</Text></TouchableOpacity>
          <Text style={styles.headerName}>{nameOf(selectedUser)}</Text>
        </View>

        {pageRef.current?.next && (
          <TouchableOpacity onPress={loadOlder} style={{ paddingVertical: 8, alignSelf: "center" }}>
            <Text style={{ color: "#9cc1ff" }}>Load earlier</Text>
          </TouchableOpacity>
        )}

        <SimpleChat
          messages={messagesForUI}
          onPressSendButton={(text) => sendMessage(text)}
          user={{ _id: user.id, name: "You" }}
          placeholder="Type a message…"
          inputStyle={styles.input}
          listProps={{ keyboardShouldPersistTaps: "always", keyboardDismissMode: "none" }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        />
      </>
    );
  };

  return (
    <SafeAreaView style={styles.safeContainer}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.container}>
        {mode === "conversation" ? <Conversation /> : <ThreadsList />}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeContainer: { flex: 1, backgroundColor: "#1E1E1E" },
  container: { flex: 1, padding: 12 },

  convHeader: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
  headerName: { color: "#FFF", fontSize: 18, fontWeight: "700", marginLeft: 8 },

  backButton: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: "#333", borderRadius: 6, alignSelf: "flex-start" },
  backText: { color: "#FFD700", fontSize: 16 },

  sectionTitle: { color: "#BDBDBD", fontSize: 13, marginTop: 8, marginBottom: 6, paddingHorizontal: 2 },

  threadItem: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 10, paddingHorizontal: 8, backgroundColor: "#272727",
    borderRadius: 10, marginBottom: 8,
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

  searchInput: { backgroundColor: "#222", padding: 12, color: "#FFF", borderRadius: 10, marginBottom: 10 },
  userItem: { padding: 12, backgroundColor: "#2C2C2C", borderRadius: 8, marginBottom: 8 },
  userText: { color: "#FFF", fontSize: 15 },

  input: { backgroundColor: "#333", padding: 10, color: "#FFF", borderRadius: 8 },
});

export default ChatScreen;
