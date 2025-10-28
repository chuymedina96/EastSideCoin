// utils/wsClient.js
import { WS_URL } from "../config";

/**
 * Sticky singleton WS client (one socket per session/token).
 * - Keeps the same socket across thread switches.
 * - Reconnects with exponential backoff when the connection drops.
 * - Supports multiple listeners (returns an unsubscribe to remove your callbacks).
 * - Exposes destroyChatSocket() to fully close on logout.
 * - Filters heartbeat frames (shape: { type, ts }) away from onMessage; routes to onHeartbeat instead.
 */

let socket = null;
let lastToken = null;
let lastUrl = null;
let manualClose = false;

let listeners = new Set(); // each: { onOpen, onClose, onError, onMessage, onHeartbeat }
let reconnectTimer = null;
let reconnectAttempts = 0;

// Heartbeat (app-level ping over text frames)
let heartbeatTimer = null;
const HEARTBEAT_MS = 25000;

// ---- utils ------------------------------------------------------------------
function buildUrl({ baseUrl, path, token }) {
  const b = (baseUrl || WS_URL || "").replace(/\/+$/, ""); // no trailing slash
  const p = (path || "/chat/").replace(/^\/?/, "/");       // ensure single leading slash
  return `${b}${p}?token=${encodeURIComponent(token)}`;
}

function isHeartbeatPayload(obj) {
  if (!obj || typeof obj !== "object") return false;
  // Django logs showed heartbeat-like payloads with keys ['ts', 'type'] and NO encrypted fields.
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
        // Application-level ping; server may reply with { type: 'heartbeat', ts: ... }
        socket.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      }
    } catch {
      // ignore
    }
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
      if (kind === "open")       h.onOpen?.();
      else if (kind === "close") h.onClose?.(payload);
      else if (kind === "error") h.onError?.(payload);
      else if (kind === "message") h.onMessage?.(payload);
      else if (kind === "heartbeat") h.onHeartbeat?.(payload);
    } catch (e) {
      // don’t let a bad listener break others
      console.warn("[wsClient] listener error:", e?.message || e);
    }
  }
}

function scheduleReconnect() {
  if (manualClose) return;
  if (reconnectTimer) return;

  // Exponential backoff up to ~10s
  const delay = Math.min(10000, 500 * Math.pow(2, reconnectAttempts));
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!manualClose && lastToken && lastUrl) {
      tryOpen(lastUrl);
    }
  }, delay);
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
}

function tryOpen(url) {
  // If an existing socket is already open to same URL, keep it
  if (socket && socket.readyState === WebSocket.OPEN && lastUrl === url) {
    return socket;
  }

  // If there is a socket but URL/token changed, close and replace
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

      // Filter heartbeats out of onMessage noise
      if (isHeartbeatPayload(data)) {
        // If you want to see pulses, consumers can pass onHeartbeat to the subscription.
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
/**
 * Create (or get) the singleton socket. Registers your callbacks and
 * returns an object with { socket, send, unsubscribe, close }.
 *
 * close(): only removes *your* listener; it does not destroy the singleton unless
 *          there are no listeners left. Use destroyChatSocket() to fully close.
 */
export function createOrGetChatSocket({
  token,
  baseUrl = WS_URL,
  path = "/chat/",
  onOpen,
  onClose,
  onError,
  onMessage,
  onHeartbeat, // optional: receive heartbeat frames
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

  // If token changed since last time, nuke current socket so we don't leak auth
  if (lastToken && lastToken !== token) {
    destroyChatSocket();
  }
  lastToken = token;

  const handler = { onOpen, onClose, onError, onMessage, onHeartbeat };
  listeners.add(handler);

  // Open (or reuse) the socket
  tryOpen(url);

  const api = {
    get socket() { return socket; },
    send: (payload) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket not connected");
      }
      const data = typeof payload === "string" ? payload : JSON.stringify(payload);
      socket.send(data);
    },
    unsubscribe: () => {
      listeners.delete(handler);
      // Optionally auto-destroy when no listeners remain (kept off by default)
      // if (listeners.size === 0) destroyChatSocket();
    },
    close: () => {
      // backwards-compat: close only your subscription
      api.unsubscribe();
    },
  };
  return api;
}

export function getActiveChatSocket() {
  return socket || null;
}

/** Hard-destroy the singleton (use on logout). */
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
}
