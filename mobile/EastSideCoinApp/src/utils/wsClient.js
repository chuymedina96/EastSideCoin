// utils/wsClient.js
import { WS_URL } from "../config";

/**
 * Robust singleton WS client per (baseUrl+path+userId).
 * - token: string OR async provider () => Promise<string|null>
 * - Queued sends until OPEN + ready() promise
 * - Multiple listeners can attach/detach (screens/modules)
 * - Reconnect w/ backoff; flip auth mode on policy/unauthorized closes
 * - Heartbeats; graceful destroy when last listener leaves
 */

const HEARTBEAT_MS = 25_000;
const DESTROY_GRACE_MS = 1_200;

const WS_OPEN = 1;
const AUTH_CLOSE_CODES = new Set([4001, 4401, 4403, 1008]); // policy/auth
const instances = new Map();

function trimSlash(s) {
  return (s || "").replace(/\/+$/, "");
}
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
  const hasTsType = "type" in obj && "ts" in obj;
  if (!hasTsType) return false;
  // treat minimal ping/heartbeat frames as non-messages
  const hasEncrypted =
    "encrypted_key_for_receiver" in obj ||
    "encrypted_key_for_sender" in obj ||
    "encrypted_message" in obj ||
    "iv" in obj ||
    "mac" in obj ||
    "receiver_id" in obj;
  return hasTsType && !hasEncrypted;
}
function backoffJitter(attempt) {
  const base = Math.min(15_000, 800 * Math.pow(1.6, attempt));
  return Math.floor(base * (0.7 + Math.random() * 0.6));
}
async function resolveToken(tokenOrProvider) {
  try {
    return typeof tokenOrProvider === "function" ? await tokenOrProvider() : tokenOrProvider || null;
  } catch {
    return null;
  }
}
function rnSupportsHeaderArg() {
  // RN's WebSocket typically only supports (url, protocols?)
  // If constructor length < 3, assume no header support
  try {
    return WebSocket && WebSocket.length >= 3;
  } catch {
    return false;
  }
}

class WsInstance {
  constructor({ tokenOrProvider, baseUrl, path, prefer, userId }) {
    this.tokenOrProvider = tokenOrProvider;
    this.token = null;

    this.baseUrl = baseUrl || WS_URL;
    this.path = path || "/chat/";
    this.prefer = prefer || "query"; // "query" | "header"
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

  key() {
    return makeKey({ baseUrl: this.baseUrl, path: this.path, userId: this.userId });
  }

  addListener(h) {
    if (h && (h.onOpen || h.onClose || h.onError || h.onMessage || h.onHeartbeat)) {
      this.listeners.add(h);
      if (this.destroyTimer) {
        clearTimeout(this.destroyTimer);
        this.destroyTimer = null;
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
      try {
        this.socket.send(data);
        return true;
      } catch {
        // fall through to queue
      }
    }
    this.sendQueue.push(payload);
    return false;
  }

  close() {
    this.manualClose = true;
    this.clearReconnect();
    this.stopHeartbeat();
    try {
      this.socket?.close?.();
    } catch {}
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
    if (!this.token) {
      this.connecting = false;
      return;
    }

    // Avoid header mode when RN WS doesn't support headers
    const preferred = this.prefer === "header" && !rnSupportsHeaderArg() ? "query" : this.prefer;
    const authMode = this.lastMode || preferred;

    const url = buildUrl({ baseUrl: this.baseUrl, path: this.path, token: this.token, authMode });
    const canHeader = rnSupportsHeaderArg();
    const useHeader = authMode === "header" && canHeader;
    const headers = useHeader ? { Authorization: `Bearer ${this.token}` } : undefined;

    this._openOnce({ url, headers, mode: useHeader ? "header" : "query" });
  }

  _openOnce({ url, headers, mode }) {
    if (this.socket && this.lastUrl !== url) {
      try {
        this.socket.close();
      } catch {}
      this.socket = null;
    }

    this.manualClose = false;
    this.lastUrl = url;
    this.lastMode = mode;

    // RN: only (url, protocols?) works typically; only pass headers when supported
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

      // Auth/policy close → flip auth mode and retry
      if (AUTH_CLOSE_CODES.has(e?.code)) {
        this.token = await resolveToken(this.tokenOrProvider);
        if (!this.token) return;

        const nextMode = this.lastMode === "query" ? "header" : "query";
        const canHeader = rnSupportsHeaderArg();
        const effectiveMode = nextMode === "header" && !canHeader ? "query" : nextMode;

        const nextUrl = buildUrl({
          baseUrl: this.baseUrl,
          path: this.path,
          token: this.token,
          authMode: effectiveMode,
        });
        const nextHeaders = effectiveMode === "header" ? { Authorization: `Bearer ${this.token}` } : undefined;

        setTimeout(() => this._openOnce({ url: nextUrl, headers: nextHeaders, mode: effectiveMode }), 200);
        return;
      }

      this.scheduleReconnect();
    };

    this.socket.onerror = (e) => this.notify("error", e);

    this.socket.onmessage = (e) => {
      let data = null;
      try {
        data = JSON.parse(e.data);
      } catch {
        data = e.data;
      }
      if (isHeartbeatPayload(data)) {
        this.notify("heartbeat", data);
        return;
      }
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
    for (const p of q) {
      try {
        this.socket.send(typeof p === "string" ? p : JSON.stringify(p));
      } catch {
        // push back and bail; will retry on next open
        this.sendQueue.unshift(p);
        break;
      }
    }
  }

  subscribeIfNeeded() {
    if (this.subscribed || !this.userId) return;
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;
    try {
      this.socket.send(JSON.stringify({ type: "subscribe", user_id: this.userId }));
      this.subscribed = true;
    } catch {
      this.subscribed = false;
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

  scheduleReconnect() {
    if (this.manualClose || this.reconnectTimer) return;
    const wait = backoffJitter(this.reconnectAttempts++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualClose) return;

      // Reuse last mode, but guard header capability again
      const authMode = this.lastMode === "header" && !rnSupportsHeaderArg() ? "query" : this.lastMode || this.prefer;
      const url = buildUrl({ baseUrl: this.baseUrl, path: this.path, token: this.token, authMode });
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
        if (kind === "open") h.onOpen?.();
        else if (kind === "close") h.onClose?.(payload);
        else if (kind === "error") h.onError?.(payload);
        else if (kind === "message") h.onMessage?.(payload);
        else if (kind === "heartbeat") h.onHeartbeat?.(payload);
      } catch {
        // swallow
      }
    }
  }
}

/* ----------------- Public helpers ----------------- */

// Return first available instance (if any)
function _firstInstance() {
  const it = instances.values();
  const n = it.next();
  return n && !n.done ? n.value : null;
}
function _apiFromInst(inst, handler) {
  if (handler) inst.addListener(handler);
  return {
    get socket() {
      return { ready: !!(inst.socket && inst.socket.readyState === WS_OPEN) };
    },
    send: (payload) => inst.send(payload),
    ready: () => inst.ready(),
    unsubscribe: () => {
      if (handler) {
        inst.removeListener(handler); // destroy handled inside if last
      }
    },
    close: () => {
      if (handler) inst.removeListener(handler);
      inst.destroyIfUnused();
    },
  };
}

/**
 * Fetch an existing socket without creating a new one.
 * If userId/baseUrl/path omitted, returns the first existing instance (or null).
 */
export function getExistingChatSocket({ baseUrl = WS_URL, path = "/chat/", userId } = {}) {
  const key = makeKey({ baseUrl, path, userId });
  const inst = userId ? instances.get(key) : _firstInstance();
  return inst ? _apiFromInst(inst, null) : null;
}

/**
 * createOrGetChatSocket({...})
 * - token: string OR async provider (() => Promise<string|null>)
 * - If instance exists, returns it; updates token provider (by ref) and reconnects if changed.
 * - If missing token AND no existing instance, returns null (no throw).
 */
export function createOrGetChatSocket(args = {}) {
  const {
    token, // string or async provider
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

  const hasListener = onOpen || onClose || onError || onMessage || onHeartbeat;
  const handler = hasListener ? { onOpen, onClose, onError, onMessage, onHeartbeat } : null;

  if (!inst) {
    if (!token) {
      // Peek at first instance (if any) when no token and nothing to create
      const peek = _firstInstance();
      return peek ? _apiFromInst(peek, handler) : null;
    }
    inst = new WsInstance({ tokenOrProvider: token, baseUrl, path, prefer, userId });
    instances.set(key, inst);
    inst.connect();
  } else {
    // If token provider changed (by reference), update and reconnect
    if (token && inst.tokenOrProvider !== token) {
      inst.tokenOrProvider = token;
      inst.close();
      inst.connect();
    }
  }

  return _apiFromInst(inst, handler);
}

/** Keep socket warm app-wide after login */
export function primeChatSocket({ token, baseUrl = WS_URL, path = "/chat/", userId, prefer = "query" }) {
  return createOrGetChatSocket({ token, baseUrl, path, userId, prefer });
}

/** Close & clear every instance (used on logout) */
export function destroyAllChatSockets() {
  for (const inst of Array.from(instances.values())) {
    try {
      inst.close();
    } catch {}
  }
  instances.clear();
}
