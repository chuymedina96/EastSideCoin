// utils/wsClient.js
import { WS_URL } from "../config";

/**
 * Robust singleton WS client per (baseUrl+path+userId).
 * - Accepts token string OR async token provider () => Promise<string|null>
 * - Awaits fresh token before each connect/reconnect
 * - Query or Authorization header auth with fallback (only on auth close codes)
 * - Ready promise + queued sends until OPEN
 * - Idempotent: multiple createOrGetChatSocket() calls reuse one connection
 * - Listener set (onOpen/onClose/onError/onMessage/onHeartbeat)
 * - Auto subscribe AFTER OPEN
 * - Reconnect with backoff + jitter; NO reconnect on normal close (1000)
 * - Heartbeats (ping/pong)
 */

const HEARTBEAT_MS = 25000;
const WS_OPEN = 1;

// Auth-related close codes: no token / unauthorized / policy violation
const AUTH_CLOSE_CODES = new Set([4001, 4401, 4403, 1008]);

const instances = new Map(); // key -> WsInstance

function trimSlash(s) { return (s || "").replace(/\/+$/, ""); }
function buildUrl({ baseUrl, path, token, authMode }) {
  const b = trimSlash(baseUrl || WS_URL || "");
  const p = (path || "/chat/").replace(/^\/?/, "/");
  return authMode === "query"
    ? `${b}${p}?token=${encodeURIComponent(token)}`
    : `${b}${p}`;
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
function backoffJitter(attempt) {
  const base = Math.min(15000, 800 * Math.pow(1.6, attempt));
  return Math.floor(base * (0.7 + Math.random() * 0.6)); // jitter +/-30%
}
async function resolveToken(tokenOrProvider) {
  try {
    if (typeof tokenOrProvider === "function") {
      return await tokenOrProvider();
    }
    return tokenOrProvider || null;
  } catch {
    return null;
  }
}

// -------------------- Instance --------------------
class WsInstance {
  constructor({ tokenOrProvider, baseUrl, path, prefer, userId }) {
    this.tokenOrProvider = tokenOrProvider; // string OR async () => token
    this.token = null; // last resolved token
    this.baseUrl = baseUrl || WS_URL;
    this.path = path || "/chat/";
    this.prefer = prefer || "query"; // "query" | "header"
    this.userId = userId ? String(userId) : null;

    this.socket = null;
    this.lastMode = null; // "query" | "header"
    this.lastUrl = null;
    this.manualClose = false;

    this.listeners = new Set(); // { onOpen, onClose, onError, onMessage, onHeartbeat }
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;

    this.heartbeatTimer = null;
    this.sendQueue = [];
    this.openResolvers = [];
    this.subscribed = false;
    this.connecting = false; // guard multiple connect() calls
  }

  key() {
    return [
      trimSlash(this.baseUrl || ""),
      this.path,
      this.userId || "no-user",
    ].join("|");
  }

  // ---- Public API ----
  addListener(handler) { this.listeners.add(handler); }
  removeListener(handler) { this.listeners.delete(handler); }

  get api() {
    return {
      get socket() { return { ready: !!(this.socket && this.socket.readyState === WS_OPEN) }; },
      send: (payload) => this.send(payload),
      ready: () => this.ready(),
      unsubscribe: () => this._unsubscribeCaller?.(), // overwritten below
      close: () => this.close(),
    };
  }

  ready() {
    if (this.socket && this.socket.readyState === WS_OPEN) return Promise.resolve();
    return new Promise((res) => this.openResolvers.push(res));
  }

  send(payload) {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    if (this.socket && this.socket.readyState === WS_OPEN) {
      try { this.socket.send(data); return true; } catch {}
    }
    this.sendQueue.push(payload);
    return false;
  }

  close() {
    this.manualClose = true;
    this.clearReconnect();
    this.stopHeartbeat();
    try { this.socket?.close?.(); } catch {}
    this.socket = null;
  }

  destroyIfUnused() {
    if (this.listeners.size === 0) {
      this.close();
      instances.delete(this.key());
    }
  }

  // ---- Connection lifecycle ----
  async connect() {
    if (this.connecting) return;
    this.connecting = true;

    // Always resolve a fresh token before (re)connect
    this.token = await resolveToken(this.tokenOrProvider);
    if (!this.token) {
      console.log("❌ No token found in WebSocket connection.");
      this.connecting = false;
      // Don't schedule reconnect until a caller tries again with a token
      return;
    }

    const authMode = this.lastMode || this.prefer;
    const url = buildUrl({ baseUrl: this.baseUrl, path: this.path, token: this.token, authMode });
    const headers = authMode === "header" ? { Authorization: `Bearer ${this.token}` } : undefined;
    this._openOnce({ url, headers, mode: authMode });
  }

  _openOnce({ url, headers, mode }) {
    // If URL changes, close old
    if (this.socket && this.lastUrl !== url) {
      try { this.socket.close(); } catch {}
      this.socket = null;
    }

    this.manualClose = false;
    this.lastUrl = url;
    this.lastMode = mode;

    console.log("[wsClient] opening", url, headers ? "(Authorization header)" : "(query token)");
    // React Native supports headers via 3rd arg: WebSocket(url, protocols, options)
    this.socket = headers ? new WebSocket(url, null, { headers }) : new WebSocket(url);

    this.socket.onopen = () => {
      console.log("[wsClient] OPEN");
      this.connecting = false;
      this.clearReconnect();
      this.startHeartbeat();
      this.resolveOpens();
      this.flushQueue();
      this.subscribeIfNeeded();
      this.notify("open");
    };

    this.socket.onclose = async (e) => {
      console.log("[wsClient] CLOSE", e?.code, e?.reason || "");
      this.stopHeartbeat();
      this.notify("close", e);
      this.subscribed = false;

      if (this.manualClose) return;

      // 🚫 Do NOT reconnect on normal close
      if (e?.code === 1000) {
        return;
      }

      // Auth-related? Try alternate auth mode immediately (one hop).
      if (AUTH_CLOSE_CODES.has(e?.code)) {
        // Resolve a fresh token (e.g., refresh)
        this.token = await resolveToken(this.tokenOrProvider);
        if (!this.token) {
          console.log("[wsClient] auth close but no token available; not reconnecting.");
          return;
        }
        // Flip mode: if we were query, try header; else try query.
        const nextMode = (this.lastMode === "query") ? "header" : "query";
        const url = buildUrl({ baseUrl: this.baseUrl, path: this.path, token: this.token, authMode: nextMode });
        const headers = nextMode === "header" ? { Authorization: `Bearer ${this.token}` } : undefined;

        // Small delay to avoid tight-loop on policy disconnects
        setTimeout(() => this._openOnce({ url, headers, mode: nextMode }), 200);
        return;
      }

      // Abnormal closes → backoff reconnect using lastMode
      this.scheduleReconnect(false);
    };

    this.socket.onerror = (e) => {
      console.warn("[wsClient] ERROR", e?.message || e);
      this.notify("error", e);
    };

    this.socket.onmessage = (e) => {
      let data = null;
      try { data = JSON.parse(e.data); } catch { data = e.data; }
      if (isHeartbeatPayload(data)) { this.notify("heartbeat", data); return; }
      this.notify("message", data);
    };
  }

  resolveOpens() {
    const rs = this.openResolvers;
    this.openResolvers = [];
    rs.forEach((r) => r());
  }

  flushQueue() {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;
    const q = this.sendQueue;
    this.sendQueue = [];
    for (const payload of q) {
      try { this.socket.send(typeof payload === "string" ? payload : JSON.stringify(payload)); }
      catch { this.sendQueue.unshift(payload); break; }
    }
  }

  subscribeIfNeeded() {
    if (this.subscribed || !this.userId) return;
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;

    try {
      // If your server needs explicit subscribe; harmless if path-based already scopes
      this.socket.send(JSON.stringify({ type: "subscribe", user_id: this.userId }));
      this.subscribed = true;
      console.log("[wsClient] subscribed to user channel", this.userId);
    } catch (e) {
      this.subscribed = false;
      console.warn("[wsClient] subscribe failed:", e?.message || e);
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      try {
        if (this.socket && this.socket.readyState === WS_OPEN) {
          this.socket.send(JSON.stringify({ type: "ping", ts: Date.now() }));
        }
      } catch {}
    }, HEARTBEAT_MS);
  }
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  scheduleReconnect(forceResolveToken) {
    if (this.manualClose || this.reconnectTimer) return;
    const wait = backoffJitter(this.reconnectAttempts++);
    console.log(`[wsClient] reconnect in ${wait}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.manualClose) return;

      if (forceResolveToken) {
        this.token = await resolveToken(this.tokenOrProvider);
        if (!this.token) {
          console.log("[wsClient] reconnect aborted; no token.");
          return;
        }
      }

      // Rebuild URL from lastMode preference
      const authMode = this.lastMode || this.prefer;
      const url = buildUrl({
        baseUrl: this.baseUrl,
        path: this.path,
        token: this.token,
        authMode,
      });
      const headers = authMode === "header" ? { Authorization: `Bearer ${this.token}` } : undefined;
      this._openOnce({ url, headers, mode: authMode });
    }, wait);
  }
  clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
  }

  notify(kind, payload) {
    for (const h of Array.from(this.listeners)) {
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
}

// -------------------- Public factory --------------------
/**
 * createOrGetChatSocket({
 *   token: string | () => Promise<string|null>,  // can pass auth.getAccessToken
 *   baseUrl?: string,
 *   path?: string,                // default "/chat/"
 *   onOpen?, onClose?, onError?, onMessage?, onHeartbeat?,
 *   userId?: string|number,      // for auto-subscribe
 *   prefer?: "query" | "header", // default "query"
 * })
 */
export function createOrGetChatSocket({
  token,                 // string OR async provider
  baseUrl = WS_URL,
  path = "/chat/",
  onOpen,
  onClose,
  onError,
  onMessage,
  onHeartbeat,
  userId,
  prefer = "query",
}) {
  if (!baseUrl) throw new Error("WS baseUrl is missing (WS_URL undefined).");
  if (!token) throw new Error("WS token missing; pass string or async provider.");

  const key = [trimSlash(baseUrl || ""), path, userId ? String(userId) : "no-user"].join("|");
  let inst = instances.get(key);

  if (!inst) {
    inst = new WsInstance({ tokenOrProvider: token, baseUrl, path, prefer, userId });
    instances.set(key, inst);
    // start connecting once (async)
    inst.connect();
  } else {
    // If caller replaced token with a different provider or string, update and reconnect as needed
    const prev = String(inst.tokenOrProvider);
    const next = String(token);
    if (prev !== next) {
      inst.tokenOrProvider = token;
      inst.close();
      inst.connect();
    }
  }

  const handler = { onOpen, onClose, onError, onMessage, onHeartbeat };
  inst.addListener(handler);

  const api = {
    get socket() { return { ready: !!(inst.socket && inst.socket.readyState === WS_OPEN) }; },
    send: (payload) => inst.send(payload),
    ready: () => inst.ready(),
    unsubscribe: () => {
      inst.removeListener(handler);
      inst.destroyIfUnused();
    },
    close: () => {
      inst.removeListener(handler);
      inst.destroyIfUnused();
    },
  };

  // Bind methods for safety
  api.unsubscribe = api.unsubscribe.bind(api);
  api.close = api.close.bind(api);

  return api;
}

export function destroyAllChatSockets() {
  for (const inst of Array.from(instances.values())) {
    try { inst.close(); } catch {}
  }
  instances.clear();
}
