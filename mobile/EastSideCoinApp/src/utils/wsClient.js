// utils/wsClient.js
import { WS_URL } from "../config";

/**
 * Sticky singleton WS client (one socket per session/token).
 * - Tries BOTH auth styles: ?token=... and Authorization header.
 * - Auto-reconnect with backoff, heartbeats.
 * - Multiple listeners; each createOrGetChatSocket() returns an unsubscribe.
 * - Heartbeats filtered from onMessage.
 * - Small send queue survives reconnects.
 * - Auto-subscribe to the user's channel on open if you pass userId.
 * - Loud console logging so you can see exactly why it’s closed.
 */

let socket = null;
let lastToken = null;
let lastUrl = null;
let manualClose = false;

let listeners = new Set(); // { onOpen, onClose, onError, onMessage, onHeartbeat }
let reconnectTimer = null;
let reconnectAttempts = 0;

// Heartbeat
let heartbeatTimer = null;
const HEARTBEAT_MS = 25000;

// Light debug / internals we surface for HUDs
const _state = {
  sendQueue: [],          // queued payloads while not OPEN
  processedIds: new Set() // optional use by consumers
};

// ---- utils ------------------------------------------------------------------
function trimSlash(s) { return (s || "").replace(/\/+$/, ""); }
function buildUrl({ baseUrl, path, token, authMode }) {
  const b = trimSlash(baseUrl || WS_URL || "");
  const p = (path || "/chat/").replace(/^\/?/, "/");
  if (authMode === "query") {
    return `${b}${p}?token=${encodeURIComponent(token)}`;
  }
  return `${b}${p}`;
}

function isHeartbeatPayload(obj) {
  if (!obj || typeof obj !== "object") return false;
  const hasTsType = ("type" in obj) && ("ts" in obj);
  if (!hasTsType) return false;
  const hasEncrypted =
    ("encrypted_key_for_receiver" in obj) ||
    ("encrypted_key_for_sender" in obj)   ||
    ("encrypted_message" in obj)          ||
    ("iv" in obj)                         ||
    ("mac" in obj)                        ||
    ("receiver_id" in obj);
  return hasTsType && !hasEncrypted;
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    try {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      }
    } catch { /* noop */ }
  }, HEARTBEAT_MS);
}
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function notify(kind, payload) {
  for (const h of Array.from(listeners)) {
    try {
      if (kind === "open")           h.onOpen?.();
      else if (kind === "close")     h.onClose?.(payload);
      else if (kind === "error")     h.onError?.(payload);
      else if (kind === "message")   h.onMessage?.(payload);
      else if (kind === "heartbeat") h.onHeartbeat?.(payload);
    } catch (e) {
      console.warn("[wsClient] listener error:", e?.message || e);
    }
  }
}

function scheduleReconnect() {
  if (manualClose) return;
  if (reconnectTimer) return;
  const delay = Math.min(10000, 500 * Math.pow(2, reconnectAttempts));
  reconnectAttempts += 1;
  console.log(`[wsClient] reconnect in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!manualClose && lastToken && lastUrl) tryOpen({ url: lastUrl.url, authMode: lastUrl.authMode, headers: lastUrl.headers, subscribeUserId: lastUrl.subscribeUserId });
  }, delay);
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
}

function flushQueue() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  while (_state.sendQueue.length) {
    const payload = _state.sendQueue.shift();
    try {
      const data = typeof payload === "string" ? payload : JSON.stringify(payload);
      socket.send(data);
    } catch (e) {
      // push back and bail; we'll try again next open
      _state.sendQueue.unshift(payload);
      break;
    }
  }
}

// Actually open a socket (single attempt for a specific authMode)
function _openOnce({ url, headers, subscribeUserId }) {
  // different URL → close the old one
  if (socket && lastUrl?.url !== url) {
    try { socket.close(); } catch {}
    socket = null;
  }
  manualClose = false;
  lastUrl = { url, headers, authMode: headers ? "header" : "query", subscribeUserId };

  // React Native signature: new WebSocket(url, protocols?, options?)
  // options.headers is supported
  console.log("[wsClient] opening", url, headers ? "(Authorization header)" : "(query token)");
  socket = headers ? new WebSocket(url, null, { headers }) : new WebSocket(url);

  socket.onopen = () => {
    console.log("[wsClient] OPEN");
    clearReconnect();
    startHeartbeat();
    // Subscribe to user channel if provided
    if (subscribeUserId) {
      try {
        socket.send(JSON.stringify({ type: "subscribe", user_id: String(subscribeUserId) }));
        console.log("[wsClient] subscribed to user channel", subscribeUserId);
      } catch (e) {
        console.warn("[wsClient] subscribe failed:", e?.message || e);
      }
    }
    flushQueue();
    notify("open");
  };

  socket.onclose = (e) => {
    console.log("[wsClient] CLOSE", e?.code, e?.reason);
    stopHeartbeat();
    notify("close", e);
    if (!manualClose) scheduleReconnect();
  };

  socket.onerror = (e) => {
    console.warn("[wsClient] ERROR", e?.message || e);
    notify("error", e);
  };

  socket.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (isHeartbeatPayload(data)) {
        notify("heartbeat", data);
        return;
      }
      notify("message", data);
    } catch (err) {
      console.warn("[wsClient] parse error", err?.message || err);
      notify("error", err);
    }
  };
  return socket;
}

/**
 * Open with a preferred auth mode, fallback to the other if the first fails quickly.
 */
function tryOpen({ url, authMode, headers, subscribeUserId }) {
  // If already open and URL matches, reuse
  if (socket && socket.readyState === WebSocket.OPEN && lastUrl?.url === url) return socket;

  // Kick once
  _openOnce({ url, headers, subscribeUserId });

  // If it doesn't open within 1.2s, try the other mode once
  const fallbackTimer = setTimeout(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      try { socket.close(); } catch {}
      socket = null;

      if (authMode === "query") {
        // fallback to header
        const hdrs = { Authorization: `Bearer ${lastToken}` };
        const bareUrl = url.replace(/\?token=.*$/, "");
        console.log("[wsClient] falling back to Authorization header");
        _openOnce({ url: bareUrl, headers: hdrs, subscribeUserId });
      } else {
        // fallback to query
        const qUrl = `${trimSlash(WS_URL)}${new URL(url).pathname}?token=${encodeURIComponent(lastToken)}`;
        console.log("[wsClient] falling back to ?token query");
        _openOnce({ url: qUrl, headers: undefined, subscribeUserId });
      }
    }
    clearTimeout(fallbackTimer);
  }, 1200);

  return socket;
}

// ---- public API -------------------------------------------------------------
export function createOrGetChatSocket({
  token,
  baseUrl = WS_URL,
  path = "/chat/",
  onOpen,
  onClose,
  onError,
  onMessage,
  onHeartbeat,
  userId,           // <-- pass current user id here so we auto-subscribe
  prefer = "query", // "query" | "header"
}) {
  if (!baseUrl) {
    const err = new Error("WS baseUrl is missing (WS_URL undefined).");
    onError?.(err);
    throw err;
  }
  if (!token) {
    const err = new Error("WS token missing; pass authToken.");
    onError?.(err);
    throw err;
  }

  // token changed → hard destroy
  if (lastToken && lastToken !== token) {
    destroyChatSocket();
  }
  lastToken = token;

  const url = buildUrl({ baseUrl, path, token, authMode: prefer });
  const headers = prefer === "header" ? { Authorization: `Bearer ${token}` } : undefined;

  const handler = { onOpen, onClose, onError, onMessage, onHeartbeat };
  listeners.add(handler);

  tryOpen({ url, authMode: prefer, headers, subscribeUserId: userId });

  const api = {
    get socket() {
      if (!socket) return null;
      return {
        ...socket,
        get ready() { return socket.readyState === WebSocket.OPEN; },
        _state
      };
    },
    send: (payload) => {
      const data = typeof payload === "string" ? payload : JSON.stringify(payload);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(data);
      } else {
        _state.sendQueue.push(payload);
      }
    },
    unsubscribe: () => {
      listeners.delete(handler);
      // if (listeners.size === 0) destroyChatSocket(); // optional
    },
    close: () => {
      listeners.delete(handler);
    }
  };

  return api;
}

export function getActiveChatSocket() {
  return socket || null;
}

export function destroyChatSocket() {
  manualClose = true;
  clearReconnect();
  stopHeartbeat();
  if (socket) {
    try { socket.close(); } catch {}
  }
  socket = null;
  lastToken = null;
  lastUrl = null;
  listeners.clear();
  _state.sendQueue.length = 0;
}
