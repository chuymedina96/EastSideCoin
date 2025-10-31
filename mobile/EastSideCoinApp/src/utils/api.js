// src/utils/api.js
import { API_URL } from "../config";

/**
 * Minimal fetch wrapper with:
 * - token as string OR async provider () => Promise<string|null>
 * - query param support
 * - JSON parsing + normalized errors
 * - optional timeout + retries
 * - supports external AbortSignal for cancellation
 *
 * NOTE: All helpers return the parsed JSON payload directly (NOT { data }).
 */

let _tokenOrProvider = null;

/** Pass a string token or an async provider (() => Promise<string|null>) */
export function setAuthToken(tokenOrProvider) {
  _tokenOrProvider = tokenOrProvider;
}

async function resolveToken() {
  if (!_tokenOrProvider) return null;
  try {
    return typeof _tokenOrProvider === "function" ? await _tokenOrProvider() : _tokenOrProvider;
  } catch {
    return null;
  }
}

function buildUrl(path, params) {
  const base = (API_URL || "").replace(/\/+$/, "");
  const p = (path || "").replace(/^\/?/, "/");
  const url = new URL(base + p);
  if (params && typeof params === "object") {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.append(k, String(v));
    });
  }
  return url.toString();
}

function toError(name, message, extra = {}) {
  const err = new Error(message || name);
  err.name = name;
  Object.assign(err, extra);
  return err;
}

/**
 * request(method, path, { params, body, headers, timeout, retries, signal })
 * Returns the parsed JSON payload directly.
 */
export async function request(
  method,
  path,
  { params, body, headers, timeout = 15000, retries = 0, signal } = {}
) {
  const token = await resolveToken();
  const url = buildUrl(path, params);

  // If external signal provided, use it; otherwise make our own for timeout.
  const internalCtrl = signal ? null : new AbortController();
  const activeSignal = signal || internalCtrl.signal;
  let timeoutId = null;

  if (internalCtrl) {
    timeoutId = setTimeout(() => internalCtrl.abort(), timeout);
  }

  const init = {
    method: method.toUpperCase(),
    headers: {
      Accept: "application/json",
      ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
    ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
    signal: activeSignal,
  };

  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text || null;
    }

    if (!res.ok) {
      const err = toError("ApiError", `HTTP ${res.status}`, { status: res.status, data, url, method });
      if (retries > 0 && (res.status >= 500 || res.status === 429)) {
        await new Promise((r) => setTimeout(r, 400 * Math.pow(1.6, retries)));
        return request(method, path, { params, body, headers, timeout, retries: retries - 1, signal });
      }
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") {
      throw toError("TimeoutError", `Request aborted or timed out after ${timeout}ms`, { path, method });
    }
    throw e;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// Shorthand verbs
export const api = {
  get: (path, opts) => request("GET", path, opts),
  post: (path, opts) => request("POST", path, opts),
  put: (path, opts) => request("PUT", path, opts),
  del: (path, opts) => request("DELETE", path, opts),
};

/* =======================================================
   👥 USERS
   - Primary search:  /users/search/?query=...
   - Back-compat:     /search_users/?q=... (same view in urls.py)
   - Public key:      /users/<id>/public_key/
   ======================================================= */

export async function searchUsers(query, { signal } = {}) {
  return api.get("/users/search/", { params: { query }, signal });
}

export async function searchUsersFallback(query, { signal } = {}) {
  return api.get("/search_users/", { params: { q: query, query }, signal });
}

/** Try users/search first, then fallback to search_users; normalizes to array */
export async function searchUsersSmart(query, { signal } = {}) {
  try {
    const payload = await searchUsers(query, { signal });
    return Array.isArray(payload) ? payload : (Array.isArray(payload?.results) ? payload.results : payload || []);
  } catch {
    const payload = await searchUsersFallback(query, { signal });
    return Array.isArray(payload) ? payload : (Array.isArray(payload?.results) ? payload.results : payload || []);
  }
}

export async function fetchUserPublicKey(userId) {
  return api.get(`/users/${userId}/public_key/`);
}

/* =======================================================
   💬 CONVERSATIONS / MESSAGES
   - /conversations/index/
   - /conversations/mark_read/<id>/
   - /conversations/<id>/?page&limit&since
   ======================================================= */

export async function fetchThreadsIndex() {
  const payload = await api.get("/conversations/index/");
  return Array.isArray(payload) ? payload : (payload?.results || []);
}

export async function markThreadRead(otherUserId) {
  return api.post(`/conversations/mark_read/${otherUserId}/`);
}

export async function fetchConversation(otherUserId, { page = 1, limit = 50, since = null } = {}) {
  const params = { page, limit, ...(since ? { since } : {}) };
  return api.get(`/conversations/${otherUserId}/`, { params });
}

/* =======================================================
   💰 WALLET
   - /wallet/balance/
   - /check_balance/<address>/
   - /wallet/<address>/balance/ (legacy alias)
   ======================================================= */

export async function walletBalance() {
  return api.get("/wallet/balance/");
}

export async function checkBalance(address) {
  return api.get(`/check_balance/${encodeURIComponent(address)}/`);
}

/* =======================================================
   🛠️ SERVICES (marketplace)
   Suggested routes; wire in urls.py/views.py as needed:

   LIST        GET  /services/?q=&category=&limit=&page=
   CREATE      POST /services/
   DETAIL      GET  /services/<id>/
   UPDATE      PUT  /services/<id>/
   DELETE      DEL  /services/<id>/

   CATEGORIES  GET  /services/categories/
   MINE        GET  /services/mine/

   AVAIL       GET  /services/<id>/availability/?from=&to=
               POST /services/<id>/availability/   (create/update windows)

   BOOK        POST /services/<id>/bookings/
   BOOKINGS    GET  /bookings/?role=buyer|seller|all
   BOOKING     GET  /bookings/<id>/
               PUT  /bookings/<id>/
               DEL  /bookings/<id>/  (cancel)
   ======================================================= */

// ---- Services core ----
export async function listServices({ q, category, page, limit } = {}) {
  const params = {};
  if (q) params.q = q;
  if (category && category !== "All") params.category = category;
  if (page) params.page = page;
  if (limit) params.limit = limit;
  return api.get("/services/", { params });
}

export async function createService(payload /* { title, description, price, category, ... } */) {
  return api.post("/services/", { body: payload });
}

export async function getService(id) {
  return api.get(`/services/${id}/`);
}

export async function updateService(id, payload) {
  return api.put(`/services/${id}/`, { body: payload });
}

export async function deleteService(id) {
  return api.del(`/services/${id}/`);
}

export async function listServiceCategories() {
  return api.get("/services/categories/");
}

export async function listMyServices() {
  return api.get("/services/mine/");
}

// ---- Availability (lightweight calendar) ----
export async function getServiceAvailability(id, { from, to } = {}) {
  const params = {};
  if (from) params.from = from; // ISO strings
  if (to) params.to = to;
  return api.get(`/services/${id}/availability/`, { params });
}

export async function setServiceAvailability(id, slots /* e.g., [{ start, end, capacity }] */) {
  return api.post(`/services/${id}/availability/`, { body: { slots } });
}

// ---- Bookings ----
export async function bookService(id, payload /* { start, end, note } */) {
  return api.post(`/services/${id}/bookings/`, { body: payload });
}

export async function listBookings({ role, page, limit } = {}) {
  const params = {};
  if (role) params.role = role; // buyer|seller|all
  if (page) params.page = page;
  if (limit) params.limit = limit;
  return api.get("/bookings/", { params });
}

export async function getBooking(bookingId) {
  return api.get(`/bookings/${bookingId}/`);
}

export async function updateBooking(bookingId, payload) {
  return api.put(`/bookings/${bookingId}/`, { body: payload });
}

export async function cancelBooking(bookingId) {
  return api.del(`/bookings/${bookingId}/`);
}

/* =======================================================
   🔧 MISC / DIAGNOSTICS (optional)
   ======================================================= */

export async function ping() {
  return api.get("/ping/"); // add simple view if you want health checks
}
