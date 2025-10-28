// utils/wsClient.js
import { WS_URL } from "../config";

/**
 * Sticky singleton WS client (one socket per session/token).
 * - One socket per token; auto-reconnect with backoff.
 * - Multiple listeners; each createOrGetChatSocket() returns an unsubscribe.
 * - Heartbeats filtered from onMessage (use onHeartbeat to observe them).
 * - Small send queue survives reconnects.
 * - Exposes a tiny debug state: {_state: {sendQueue, processedIds}, ready:boolean}
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
  sendQueue: [],         // queued payloads while not OPEN
  processedIds: new Set()// optional use by consumers
};

// ---- utils ------------------------------------------------------------------
function buildUrl({ baseUrl, path, token }) {
  const b = (baseUrl || WS_URL || "").replace(/\/+$/, "");
  const p = (path || "/chat/").replace(/^\/?/, "/");
  return `${b}${p}?token=${encodeURIComponent(token)}`;
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
      if (kind === "open")         h.onOpen?.();
      else if (kind === "close")   h.onClose?.(payload);
      else if (kind === "error")   h.onError?.(payload);
      else if (kind === "message") h.onMessage?.(payload);
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
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!manualClose && lastToken && lastUrl) tryOpen(lastUrl);
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

function tryOpen(url) {
  // reuse if already open and same URL
  if (socket && socket.readyState === WebSocket.OPEN && lastUrl === url) return socket;

  // different URL/token → close the old one
  if (socket && lastUrl !== url) {
    try { socket.close(); } catch {}
    socket = null;
  }

  manualClose = false;
  lastUrl = url;

  socket = new WebSocket(url);

  socket.onopen = () => {
    clearReconnect();
    startHeartbeat();
    flushQueue();
    notify("open");
  };

  socket.onclose = (e) => {
    stopHeartbeat();
    notify("close", e);
    if (!manualClose) scheduleReconnect();
  };

  socket.onerror = (e) => {
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
      notify("error", err);
    }
  };

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
  onHeartbeat
}) {
  if (!baseUrl) {
    const err = new Error("WS baseUrl is missing (WS_URL undefined).");
    onError?.(err);
    throw err;
  }
  if (!token) {
    const err = new Error("WS token missing — did you pass authToken?");
    onError?.(err);
    throw err;
  }

  const url = buildUrl({ baseUrl, path, token });

  // token changed → hard destroy
  if (lastToken && lastToken !== token) {
    destroyChatSocket();
  }
  lastToken = token;

  const handler = { onOpen, onClose, onError, onMessage, onHeartbeat };
  listeners.add(handler);

  tryOpen(url);

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
      // backwards compat: only remove this listener
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
