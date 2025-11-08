// utils/wsClient.js
import { WS_URL } from "../config";

/**
 * Robust singleton WS client per (baseUrl+path+userId).
 * - Accepts token string OR async token provider () => Promise<string|null>
 * - Ready promise + queued sends until OPEN
 * - Multiple listeners (screens/modules) can attach/detach freely
 * - Reconnect with backoff; flip auth mode on policy/unauthorized closes
 * - Heartbeats
 * - Gentle destroy after last listener detaches (grace window)
 */

const HEARTBEAT_MS = 25000;
const WS_OPEN = 1;
const AUTH_CLOSE_CODES = new Set([4001, 4401, 4403, 1008]);
const instances = new Map();

// When the last listener detaches, wait briefly before destroying to avoid flicker during nav transitions.
const DESTROY_GRACE_MS = 1200;

function trimSlash(s) { return (s || "").replace(/\/+$/, ""); }
function makeKey({ baseUrl, path, userId }) {
  return [trimSlash(baseUrl || WS_URL || ""), path || "/chat/", userId ? String(userId) : "no-user"].join("|");
}
function buildUrl({ baseUrl, path, token, authMode }) {
  const b = trimSlash(baseUrl || WS_URL || "");
  const p = (path || "/chat/").replace(/^\/?/, "/");
  return authMode === "query" ? `${b}${p}?token=${encodeURIComponent(token || "")}` : `${b}${p}`;
}
function isHeartbeatPayload(obj) {
  if (!obj || typeof obj !== "object") return false;
  const hasTsType = ("type" in obj) && ("ts" in obj);
  if (!hasTsType) return false;
  const hasEncrypted = ("encrypted_key_for_receiver" in obj) || ("encrypted_key_for_sender" in obj) ||
    ("encrypted_message" in obj) || ("iv" in obj) || ("mac" in obj) || ("receiver_id" in obj);
  return hasTsType && !hasEncrypted;
}
function backoffJitter(attempt) {
  const base = Math.min(15000, 800 * Math.pow(1.6, attempt));
  return Math.floor(base * (0.7 + Math.random() * 0.6));
}
async function resolveToken(tokenOrProvider) {
  try { return typeof tokenOrProvider === "function" ? await tokenOrProvider() : (tokenOrProvider || null); }
  catch { return null; }
}

class WsInstance {
  constructor({ tokenOrProvider, baseUrl, path, prefer, userId }) {
    this.tokenOrProvider = tokenOrProvider;
    this.token = null;
    this.baseUrl = baseUrl || WS_URL;
    this.path = path || "/chat/";
    this.prefer = prefer || "query";
    this.userId = userId ? String(userId) : null;

    this.socket = null;
    this.lastMode = null;
    this.lastUrl = null;
    this.manualClose = false;

    this.listeners = new Set();
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;

    this.heartbeatTimer = null;
    this.sendQueue = [];
    this.openResolvers = [];
    this.subscribed = false;
    this.connecting = false;

    this.destroyTimer = null;
  }

  key() { return makeKey({ baseUrl: this.baseUrl, path: this.path, userId: this.userId }); }

  addListener(h) {
    if (h && (h.onOpen || h.onClose || h.onError || h.onMessage || h.onHeartbeat)) {
      this.listeners.add(h);
      // if we were waiting to destroy, cancel it
      if (this.destroyTimer) { clearTimeout(this.destroyTimer); this.destroyTimer = null; }
      // If already open, immediately “open” to new listener for smooth UI
      if (this.socket && this.socket.readyState === WS_OPEN) {
        try { h.onOpen?.(); } catch {}
      }
    }
  }
  removeListener(h) {
    if (h) this.listeners.delete(h);
    this.destroyIfUnused();
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
      if (this.destroyTimer) return;
      this.destroyTimer = setTimeout(() => {
        if (this.listeners.size === 0) {
          this.close();
          instances.delete(this.key());
        }
        this.destroyTimer = null;
      }, DESTROY_GRACE_MS);
    }
  }

  async connect() {
    if (this.connecting) return;
    this.connecting = true;

    this.token = await resolveToken(this.tokenOrProvider);
    // Require a token for both modes; avoids hitting server with blank token param
    if (!this.token) { this.connecting = false; return; }

    const authMode = this.lastMode || this.prefer;
    const url = buildUrl({ baseUrl: this.baseUrl, path: this.path, token: this.token, authMode });
    const headers = authMode === "header" ? { Authorization: `Bearer ${this.token}` } : undefined;
    this._openOnce({ url, headers, mode: authMode });
  }

  _openOnce({ url, headers, mode }) {
    if (this.socket && this.lastUrl !== url) { try { this.socket.close(); } catch {} this.socket = null; }

    this.manualClose = false;
    this.lastUrl = url;
    this.lastMode = mode;

    this.socket = headers ? new WebSocket(url, null, { headers }) : new WebSocket(url);

    this.socket.onopen = () => {
      this.connecting = false;
      this.clearReconnect();
      this.startHeartbeat();
      this.resolveOpens();
      this.flushQueue();
      this.subscribeIfNeeded();
      this.notify("open");
    };

    this.socket.onclose = async (e) => {
      this.stopHeartbeat();
      this.notify("close", e);
      this.subscribed = false;
      if (this.manualClose) return;
      if (e?.code === 1000) return;

      if (AUTH_CLOSE_CODES.has(e?.code)) {
        this.token = await resolveToken(this.tokenOrProvider);
        if (!this.token) return;
        const nextMode = (this.lastMode === "query") ? "header" : "query";
        const url = buildUrl({ baseUrl: this.baseUrl, path: this.path, token: this.token, authMode: nextMode });
        const headers = nextMode === "header" ? { Authorization: `Bearer ${this.token}` } : undefined;
        setTimeout(() => this._openOnce({ url, headers, mode: nextMode }), 200);
        return;
      }
      this.scheduleReconnect();
    };

    this.socket.onerror = (e) => this.notify("error", e);
    this.socket.onmessage = (e) => {
      let data = null; try { data = JSON.parse(e.data); } catch { data = e.data; }
      if (isHeartbeatPayload(data)) { this.notify("heartbeat", data); return; }
      this.notify("message", data);
    };
  }

  resolveOpens() { const rs = this.openResolvers; this.openResolvers = []; rs.forEach((r) => r()); }

  flushQueue() {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;
    const q = this.sendQueue; this.sendQueue = [];
    for (const p of q) {
      try { this.socket.send(typeof p === "string" ? p : JSON.stringify(p)); }
      catch { this.sendQueue.unshift(p); break; }
    }
  }

  subscribeIfNeeded() {
    if (this.subscribed || !this.userId) return;
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;
    try {
      this.socket.send(JSON.stringify({ type: "subscribe", user_id: this.userId }));
      this.subscribed = true;
    } catch { this.subscribed = false; }
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
  stopHeartbeat() { if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; } }

  scheduleReconnect() {
    if (this.manualClose || this.reconnectTimer) return;
    const wait = backoffJitter(this.reconnectAttempts++);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.manualClose) return;
      const authMode = this.lastMode || this.prefer;
      const url = buildUrl({ baseUrl: this.baseUrl, path: this.path, token: this.token, authMode });
      const headers = authMode === "header" ? { Authorization: `Bearer ${this.token}` } : undefined;
      this._openOnce({ url, headers, mode: authMode });
    }, wait);
  }
  clearReconnect() { if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; } this.reconnectAttempts = 0; }

  notify(kind, payload) {
    for (const h of Array.from(this.listeners)) {
      try {
        if (kind === "open") h.onOpen?.();
        else if (kind === "close") h.onClose?.(payload);
        else if (kind === "error") h.onError?.(payload);
        else if (kind === "message") h.onMessage?.(payload);
        else if (kind === "heartbeat") h.onHeartbeat?.(payload);
      } catch {}
    }
  }
}

/* ---------- Public helpers ---------- */

function _firstInstance() {
  const it = instances.values();
  const n = it.next();
  return n && !n.done ? n.value : null;
}
function _apiFromInst(inst, handler) {
  if (handler) inst.addListener(handler);
  return {
    get socket() { return { ready: !!(inst.socket && inst.socket.readyState === WS_OPEN) }; },
    send: (payload) => inst.send(payload),
    ready: () => inst.ready(),
    unsubscribe: () => { if (handler) { inst.removeListener(handler); } },
    close: () => { if (handler) { inst.removeListener(handler); } inst.destroyIfUnused(); },
  };
}

/**
 * Fetch an existing socket without creating a new one.
 * If userId/baseUrl/path are omitted, returns the first existing instance (or null).
 */
export function getExistingChatSocket({ baseUrl = WS_URL, path = "/chat/", userId } = {}) {
  const key = makeKey({ baseUrl, path, userId });
  let inst = userId ? instances.get(key) : _firstInstance();
  return inst ? _apiFromInst(inst, null) : null;
}

/**
 * createOrGetChatSocket({...})
 * - If args omitted and an instance exists, returns it (no new listener).
 * - If token missing but an instance for the given key exists, returns it.
 * - Otherwise, requires a token (string or provider) to create a new instance.
 * - If neither a token nor an instance is available, returns null (no throw).
 */
export function createOrGetChatSocket(args = {}) {
  const {
    token,
    baseUrl = WS_URL,
    path = "/chat/",
    onOpen,
    onClose,
    onError,
    onMessage,
    onHeartbeat,
    userId,
    prefer = "query",
  } = args;

  if (!baseUrl) return null;

  const key = makeKey({ baseUrl, path, userId });
  let inst = instances.get(key);

  const hasAnyListener = onOpen || onClose || onError || onMessage || onHeartbeat;

  if (!inst) {
    // If we don't have an instance yet, we need a token to create one.
    if (!token) {
      const peek = _firstInstance();
      return peek ? _apiFromInst(peek, hasAnyListener ? { onOpen, onClose, onError, onMessage, onHeartbeat } : null) : null;
    }
    inst = new WsInstance({ tokenOrProvider: token, baseUrl, path, prefer, userId });
    instances.set(key, inst);
    inst.connect();
  } else {
    // If token provider changed by reference, update and reconnect
    if (token && inst.tokenOrProvider !== token) {
      inst.tokenOrProvider = token;
      inst.close();
      inst.connect();
    }
  }

  const handler = hasAnyListener ? { onOpen, onClose, onError, onMessage, onHeartbeat } : null;
  return _apiFromInst(inst, handler);
}

/**
 * Prime socket once after login to keep it alive app-wide.
 */
export function primeChatSocket({ token, baseUrl = WS_URL, path = "/chat/", userId, prefer = "query" }) {
  return createOrGetChatSocket({ token, baseUrl, path, userId, prefer });
}

export function destroyAllChatSockets() {
  for (const inst of Array.from(instances.values())) { try { inst.close(); } catch {} }
  instances.clear();
}
