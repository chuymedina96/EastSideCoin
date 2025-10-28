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

const asId = (v) => String(v ?? "");
const formatTime = (d) => {
  const date = typeof d === "string" ? new Date(d) : d;
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
};
const nameOf = (u) => (`${u?.first_name || ""} ${u?.last_name || ""}`.trim() || u?.email || "Neighbor");

const b64FixPadding = (b64) => {
  if (!b64) return b64;
  const s = String(b64).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  return pad === 0 ? s : s + "=".repeat(4 - pad);
};

const pickWrapForMe = (m, meId) => {
  if (m.encrypted_key_for_me) return m.encrypted_key_for_me;
  const me = String(meId);
  const sender = String(m.sender ?? m.sender_id);
  const receiver = String(m.receiver ?? m.receiver_id);
  if (receiver === me && (m.encrypted_key_for_receiver || m.encrypted_key)) {
    return m.encrypted_key_for_receiver || m.encrypted_key;
  }
  if (sender === me && m.encrypted_key_for_sender) return m.encrypted_key_for_sender;
  return null;
};

const decryptServerMessage = (m, privateKeyPem, meId, otherUser) => {
  const wrap = pickWrapForMe(m, meId);
  if (!wrap) return null;

  let keyB64;
  try { keyB64 = decryptRSA(b64FixPadding(wrap), privateKeyPem); } catch { return null; }

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
    _id: String(m.id || Math.random()),
    text,
    createdAt,
    user: { _id: isMine ? String(meId) : String(otherUser.id), name: isMine ? "You" : nameOf(otherUser) },
    __server: true,
  };
};

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

  // hydrate UI state
  const [loadingHydrateId, setLoadingHydrateId] = useState(null);
  const hydrateTimeoutRef = useRef(null);

  const pageRef = useRef({ next: null });
  const wsSubRef = useRef(null);

  // Composer + list ref
  const [draft, setDraft] = useState("");
  const listRef = useRef(null);

  // ---- Cache helpers
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

  // ---- Bootstrap
  useEffect(() => {
    let mounted = true;
    (async () => {
      setThreads({});
      setMessages([]);
      setSelectedUser(null);
      const t = await loadCachedThreads();
      if (mounted) setThreads(t);
    })();
    return () => { mounted = false; };
  }, [user?.id, loadCachedThreads]);

  useEffect(() => { saveCachedThreads(threads); }, [threads, saveCachedThreads]);

  useEffect(() => {
    if (!Array.isArray(searchResults)) return;
    setDirectory((d) => {
      const next = { ...d };
      for (const u of searchResults) if (u?.id) next[asId(u.id)] = u;
      return next;
    });
  }, [searchResults]);

  useEffect(() => { (async () => {
    if (user?.id) {
      const perUser = await AsyncStorage.getItem(`privateKey_${user.id}`);
      if (perUser) await AsyncStorage.setItem("privateKey", perUser);
    }
  })(); }, [user?.id]);

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
    console.log(`📡 fetchConversationPage other=${otherId} page=${page} limit=${limit}`);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
    if (!res.ok) throw new Error(`Conversation fetch failed: ${res.status}`);
    const data = await res.json();
    console.log(`📥 server returned count=${data?.count ?? "?"} results=${data?.results?.length ?? 0} next=${data?.next_page ?? null}`);
    return data;
  }, [authToken]);

  const clearHydrateBanner = useCallback((oid) => {
    setLoadingHydrateId((curr) => (curr === oid ? null : curr));
    if (hydrateTimeoutRef.current) {
      clearTimeout(hydrateTimeoutRef.current);
      hydrateTimeoutRef.current = null;
    }
  }, []);

  const hydrateConversation = useCallback(async (neighbor) => {
    if (!neighbor?.id) return;
    const oid = String(neighbor.id);

    setLoadingHydrateId(oid);
    if (hydrateTimeoutRef.current) clearTimeout(hydrateTimeoutRef.current);
    hydrateTimeoutRef.current = setTimeout(() => {
      console.warn("⏱️ hydrate timeout fallback — clearing banner");
      clearHydrateBanner(oid);
    }, 12000);

    try {
      console.log(`💧 hydrateConversation start other=${oid}`);

      const cached = await loadCachedMessages(neighbor.id);
      console.log(`💾 cached messages: ${cached.length}`);
      if (cached.length) {
        const normalized = cached.map(m => ({
          ...m,
          _id: String(m._id),
          user: { ...m.user, _id: String(m.user?._id) },
          createdAt: new Date(m.createdAt),
        })).sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
        setMessages(normalized);
      } else {
        setMessages([]);
      }

      const privateKeyPem = await AsyncStorage.getItem("privateKey");
      if (!privateKeyPem) {
        console.log("🔐 no privateKey yet; rendering empty UI until keys are ready");
        return;
      }

      const first = await fetchConversationPage(neighbor.id, { page: 1, limit: 50 });
      const decrypted = (first.results || [])
        .map(m => decryptServerMessage(m, privateKeyPem, user.id, neighbor))
        .filter(Boolean)
        .map(m => ({ ...m, _id: String(m._id), user: { ...m.user, _id: String(m.user._id) } }))
        .sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));

      console.log(`[hydrate] cache=${cached.length} server=${first.results?.length ?? 0} dec=${decrypted.length} next=${first.next_page ?? null}`);
      setMessages(decrypted);
      await saveCachedMessages(neighbor.id, decrypted);
      pageRef.current = { next: first.next_page || null };
      console.log(`🟢 UI messages count=${decrypted.length}`);
    } catch (e) {
      console.log("❌ hydrate error", e?.message);
    } finally {
      clearHydrateBanner(oid);
    }
  }, [fetchConversationPage, user?.id, loadCachedMessages, saveCachedMessages, clearHydrateBanner]);

  // ---- WebSocket subscribe
  useEffect(() => {
    if (!authToken || !effectiveReady || !user?.id) return;

    let unsub = null;
    (async () => {
      const ok = await loadPrivateKeyForUser(user.id);
      if (!ok) return;

      const sub = createOrGetChatSocket({
        token: authToken,
        onMessage: async (incoming) => {
          try {
            const senderId = incoming.sender ?? incoming.sender_id;
            const receiverId = incoming.receiver ?? incoming.receiver_id;
            if (senderId == null || receiverId == null) return;

            const myIdStr = String(user.id);
            const otherId = String(senderId) === myIdStr ? String(receiverId) : String(senderId);

            setThreads((t) => {
              const knownMeta = t[asId(otherId)]?.meta || {};
              return upsertThread(
                t,
                { id: otherId, ...knownMeta },
                "New message",
                new Date(),
                String(senderId) !== myIdStr
              );
            });

            if (!selectedUser || String(selectedUser.id) !== otherId) return;

            const privateKeyPem = await AsyncStorage.getItem("privateKey");
            if (!privateKeyPem) return;

            const wrap = pickWrapForMe(incoming, user.id);
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
              _id: String(incoming.id || Math.random()),
              text: decryptedText || "🔒 Encrypted Message",
              createdAt: incoming.timestamp ? new Date(incoming.timestamp)
                : (incoming.created_at ? new Date(incoming.created_at) : new Date()),
              user: { _id: isMine ? String(user.id) : String(selectedUser.id), name: isMine ? "You" : nameOf(selectedUser) },
            };

            setMessages((prev) => {
              const next = [...prev, newMsg].sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
              if (selectedUser?.id) saveCachedMessages(selectedUser.id, next);
              console.log(`🟢 UI messages count=${next.length}`);
              return next;
            });

            setThreads((t) => upsertThread(
              t,
              { id: selectedUser.id, ...selectedUser },
              decryptedText,
              newMsg.createdAt,
              !isMine,
              { resetUnread: true }
            ));
          } catch (e) {
            console.error("❌ onMessage handler error:", e);
          }
        },
      });

      wsSubRef.current = sub;
      unsub = () => { try { sub.unsubscribe?.(); } catch {} wsSubRef.current = null; };
    })();

    return () => { if (unsub) unsub(); };
  }, [authToken, effectiveReady, user?.id, selectedUser, saveCachedMessages]);

  // ---- Thread utils
  const upsertThread = (threads, otherUser, lastText, at, isIncoming, opts = {}) => {
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
        unread: opts.resetUnread ? 0 : Math.max(0, (prev.unread || 0) + (isIncoming ? 1 : 0)),
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
      const normalized = cached.map(m => ({
        ...m,
        _id: String(m._id),
        user: { ...m.user, _id: String(m.user?._id) },
        createdAt: new Date(m.createdAt),
      })).sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
      setMessages(normalized);
      console.log(`🟡 initial UI messages count=${normalized.length}`);
    })();

    setThreads((t) => upsertThread(t, known, "", new Date(), false, { resetUnread: true }));
    setEffectiveQuery("");
    setSearchResults([]);

    hydrateConversation(known);
  };

  const backToThreads = () => {
    setMode("threads");
    if (selectedUser?.id) {
      setThreads((t) => upsertThread(t, selectedUser, "", new Date(), false, { resetUnread: true }));
    }
    setSelectedUser(null);
    setMessages([]);
  };

  const sendMessage = async (messageVal) => {
    const messageText = typeof messageVal === "string" ? messageVal : (messageVal?.text ?? "");
    const text = messageText.trim();
    if (!text) return;

    const sub = wsSubRef.current;
    const activeSocket = sub?.socket;
    if (!selectedUser || !activeSocket) return;

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

      const bundle = encryptAES(text);
      const encrypted_key_for_receiver = encryptRSA(bundle.keyB64, recipientPub);
      const encrypted_key_for_sender   = encryptRSA(bundle.keyB64, myPublicKey);

      sub.send({
        receiver_id: selectedUser.id,
        encrypted_message: bundle.ciphertextB64,
        encrypted_key_for_receiver,
        encrypted_key_for_sender,
        iv: bundle.ivB64,
        mac: bundle.macB64,
      });

      const now = new Date();
      const optimistic = {
        _id: String(Math.random()),
        text,
        createdAt: now,
        user: { _id: String(user.id), name: "You" },
      };

      setMessages((prev) => {
        const next = [...prev, optimistic].sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
        if (selectedUser?.id) saveCachedMessages(selectedUser.id, next);
        console.log(`🟢 UI messages count=${next.length}`);
        return next;
      });

      setThreads((t) => upsertThread(t, selectedUser, text, now, false));
      setDraft("");
      // scroll to bottom (top of inverted list)
      requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: true }));
    } catch (error) {
      console.error("❌ Error sending message:", error);
      Alert.alert("Send Error", "Failed to send message.");
    }
  };

  const onRefresh = useCallback(() => { setRefreshing(true); setTimeout(() => setRefreshing(false), 600); }, []);

  // SimpleChat used newest-first; FlatList inverted expects the same
  const messagesForUI = useMemo(() => {
    const arr = messages.slice().reverse();
    console.log(`📊 rendering messagesForUI=${arr.length}`);
    return arr;
  }, [messages]);

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
          <TouchableOpacity onPress={() => { /* optional: implement loadOlder hook here if needed */ }} style={{ paddingVertical: 8, alignSelf: "center" }}>
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
            keyboardDismissMode="none"
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
            onContentSizeChange={() => listRef.current?.scrollToOffset({ offset: 0, animated: true })}
            onLayout={() => listRef.current?.scrollToOffset({ offset: 0, animated: false })}
          />

          <View style={styles.composerRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Type a message…"
              placeholderTextColor="#AAA"
              style={styles.composerInput}
              autoCorrect={false}
              autoCapitalize="none"
              onSubmitEditing={() => { const t = (draft||"").trim(); if (!t) return; setDraft(""); sendMessage(t); }}
              returnKeyType="send"
            />
            <TouchableOpacity
              style={styles.composerSend}
              onPress={() => { const t = (draft||"").trim(); if (!t) return; setDraft(""); sendMessage(t); }}
            >
              <Text style={styles.composerSendTxt}>Send</Text>
            </TouchableOpacity>
          </View>
        </View>
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

  loadingBanner: { flexDirection: "row", alignItems: "center", alignSelf: "center", marginBottom: 6 },
  loadingBannerText: { color: "#BDBDBD", marginLeft: 8 },

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

  searchInput: { backgroundColor: "#222", padding: 12, color: "#FFF", borderRadius: 10 },
  userItem: { padding: 12, backgroundColor: "#2C2C2C", borderRadius: 8, marginBottom: 8 },
  userText: { color: "#FFF", fontSize: 15 },

  // Chat bubbles
  bubble: { maxWidth: "78%", marginVertical: 4, padding: 10, borderRadius: 10 },
  bubbleMine: { alignSelf: "flex-end", backgroundColor: "#3a3f5a" },
  bubbleTheirs: { alignSelf: "flex-start", backgroundColor: "#2f2f2f" },
  bubbleText: { color: "#fff", fontSize: 15 },
  bubbleTime: { color: "#ccc", fontSize: 11, marginTop: 4, alignSelf: "flex-end" },

  // Composer
  composerRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 8 },
  composerInput: { flex: 1, backgroundColor: "#333", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: "#FFF" },
  composerSend: { paddingHorizontal: 14, paddingVertical: 10, backgroundColor: "#4B6BFB", borderRadius: 10 },
  composerSendTxt: { color: "#FFF", fontWeight: "700" },
});

export default ChatScreen;
