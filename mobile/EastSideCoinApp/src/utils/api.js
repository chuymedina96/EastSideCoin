// src/utils/api.js
import { API_URL } from "../config";

/**
 * Minimal fetch wrapper with:
 * - token as string OR async provider () => Promise<string|null>
 * - optional refresh handler on 401 (setTokenRefreshHandler)
 * - query param support
 * - JSON parsing + normalized errors
 * - optional timeout + retries
 * - supports external AbortSignal for cancellation
 *
 * All helpers return the parsed JSON payload directly (NOT { data }).
 */

let _tokenOrProvider = null;          // string token or async () => token
let _refreshHandler = null;           // async () => string|null (new token) or throws

/** Pass a string token or an async provider (() => Promise<string|null>) */
export function setAuthToken(tokenOrProvider) {
  _tokenOrProvider = tokenOrProvider;
}

/** Register a refresh handler used on 401 to obtain a new access token. */
export function setTokenRefreshHandler(handler /* async () => string|null */) {
  _refreshHandler = handler;
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

async function doFetch(url, init, { timeout, signal }) {
  // If external signal provided, use it; otherwise make our own for timeout.
  const internalCtrl = signal ? null : new AbortController();
  const activeSignal = signal || internalCtrl?.signal;
  let timeoutId = null;

  if (internalCtrl) timeoutId = setTimeout(() => internalCtrl.abort(), timeout);

  try {
    const res = await fetch(url, { ...init, signal: activeSignal });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text || null; }
    return { res, data };
  } catch (e) {
    if (e.name === "AbortError") {
      throw toError("TimeoutError", `Request aborted or timed out after ${timeout}ms`, { url });
    }
    throw e;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
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
  const url = buildUrl(path, params);

  const makeInit = async () => {
    const token = await resolveToken();
    return {
      method: method.toUpperCase(),
      headers: {
        Accept: "application/json",
        ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(headers || {}),
      },
      ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
    };
  };

  let init = await makeInit();
  let attempt = 0;
  let triedRefresh = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { res, data } = await doFetch(url, init, { timeout, signal });
    if (res.ok) return data;

    // 401 → try refresh handler once
    if (res.status === 401 && _refreshHandler && !triedRefresh) {
      triedRefresh = true;
      try {
        const newToken = await _refreshHandler();
        if (typeof newToken === "string" && newToken.length > 0 && typeof _tokenOrProvider !== "function") {
          setAuthToken(newToken);
        }
        init = await makeInit();
        attempt++;
        continue;
      } catch {
        // fall-through
      }
    }

    // Backoff retry for 5xx/429
    if ((res.status >= 500 || res.status === 429) && retries > 0) {
      await new Promise((r) => setTimeout(r, 400 * Math.pow(1.6, attempt)));
      attempt++;
      retries--;
      continue;
    }

    throw toError("ApiError", `HTTP ${res.status}`, { status: res.status, data, url, method });
  }
}

// Shorthand verbs
export const api = {
  get: (path, opts) => request("GET", path, opts),
  post: (path, { body, ...opts } = {}) => request("POST", path, { body, ...opts }),
  put: (path, { body, ...opts } = {}) => request("PUT", path, { body, ...opts }),
  patch: (path, { body, ...opts } = {}) => request("PATCH", path, { body, ...opts }),
  del: (path, opts) => request("DELETE", path, opts),
  delete: (path, opts) => request("DELETE", path, opts), // alias
};

// Multipart helper
export async function upload(path, formData, { params, headers, timeout = 30000, signal } = {}) {
  return request("POST", path, {
    params,
    body: formData, // must be FormData
    headers: { ...(headers || {}) /* Content-Type auto-set by fetch for FormData */ },
    timeout,
    signal,
  });
}

/* =======================================================
   🔐 AUTH / KEYS
   ======================================================= */

export async function registerUser(payload /* { first_name, last_name, email, password, wallet_address } */) {
  return api.post("/register/", { body: payload });
}

export async function loginUser(payload /* { email, password } */) {
  return api.post("/login/", { body: payload });
}

export async function generateKeys(payload /* { public_key } */) {
  return api.post("/generate_keys/", { body: payload });
}

export async function logoutUser(payload /* { token: <refresh_token> } */) {
  return api.post("/logout/", { body: payload });
}

export async function deleteAccount(payload /* optional: { refresh: <token> } */) {
  return api.del("/delete_account/", { body: payload });
}

export async function refreshAccessToken(refresh /* string */) {
  return api.post("/refresh/", { body: { refresh } });
}

/* =======================================================
   👤 ME / PROFILE
   ======================================================= */

export async function fetchMe() {
  return api.get("/me/");
}

export async function updateMe(fields /* { neighborhood, skills, languages, bio, age, onboarding_completed } */) {
  return api.patch("/me/update/", { body: fields });
}

export async function uploadAvatar(file /* File or Blob */) {
  const fd = new FormData();
  fd.append("avatar", file);
  return upload("/profile/avatar/", fd);
}

export async function deleteAvatar() {
  return api.del("/profile/avatar/");
}

/* =======================================================
   👥 USERS
   - Primary search:  /users/search/?query=...
   - Back-compat:     /search_users/?q=...
   - NOTE: public key endpoint was removed server-side.
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

/**
 * Safer replacement now that /users/<id>/public_key/ is gone.
 * - If userId matches /me/, derive public_key from /me/.
 * - Else return { public_key: null } without throwing.
 */
export async function fetchUserPublicKey(userId) {
  try {
    const me = await fetchMe();
    if (me?.id === userId) {
      return { public_key: me?.public_key ?? null };
    }
  } catch {
    /* ignore */
  }
  // No server route anymore; avoid 404 noise.
  return { public_key: null };
}

/* =======================================================
   💬 CONVERSATIONS / MESSAGES
   ======================================================= */

export async function fetchThreadsIndex() {
  const payload = await api.get("/conversations/index/");
  return Array.isArray(payload) ? payload : (payload?.results || []);
}

export async function markThreadRead(otherUserId) {
  return api.post(`/conversations/mark_read/${otherUserId}/`);
}

export async function fetchConversation(
  otherUserId,
  { page = 1, limit = 50, before = null, after = null, since = null } = {}
) {
  const params = { page, limit };
  if (before) params.before = before;
  if (after || since) params.after = after || since;
  return api.get(`/conversations/${otherUserId}/`, { params });
}

export async function sendEncryptedMessage(payload /* see /messages/send/ contract */) {
  return api.post("/messages/send/", { body: payload });
}

export async function markMessageRead(messageId) {
  return api.post("/messages/read/", { body: { message_id: messageId } });
}

export async function markMessagesReadBatch(ids /* string[] */) {
  return api.post("/messages/read_batch/", { body: { ids } });
}

/* =======================================================
   💰 WALLET
   ======================================================= */

export async function walletBalance() {
  return api.get("/wallet/balance/");
}

export async function checkBalance(address) {
  return api.get(`/check_balance/${encodeURIComponent(address)}/`);
}

/* =======================================================
   🛠️ SERVICES (marketplace)
   ======================================================= */

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
  return api.patch(`/services/${id}/`, { body: payload }); // backend uses PATCH
}

export async function deleteService(id) {
  return api.del(`/services/${id}/`);
}

export async function listServiceCategories() {
  return api.get("/services/categories/");
}

export async function listMyServices(opts = {}) {
  return api.get("/services/mine/", opts);
}

/* =======================================================
   📅 BOOKINGS
   ======================================================= */

// Liberal creator that tries service subroutes then generic POST /bookings/
export async function bookService(idOrObj, payload /* { start, end, note } */) {
  const serviceId =
    (idOrObj && typeof idOrObj === "object" ? (idOrObj.id || idOrObj.pk || idOrObj.service_id) : idOrObj);

  if (!serviceId) {
    throw toError("ArgumentError", "Missing service id for booking", { payload, idOrObj });
  }

  const sid = encodeURIComponent(String(serviceId));
  const body = {
    note: payload?.note ?? "",
    start_at: payload?.start,
    end_at: payload?.end,
    start: payload?.start, // alt names tolerated by some backends
    end: payload?.end,
    service_id: serviceId,
  };

  const path1 = `/services/${sid}/bookings/`; // if you later add it
  const path2 = `/services/${sid}/book/`;     // alt
  const path3 = `/bookings/`;                 // current generic endpoint

  try {
    return await api.post(path1, { body });
  } catch (e1) {
    if (e1.status === 404) {
      try {
        return await api.post(path2, { body });
      } catch (e2) {
        if (e2.status === 404) {
          return await api.post(path3, { body });
        }
        throw e2;
      }
    }
    throw e1;
  }
}

export async function listBookings({ role, status, page, limit, from, to } = {}) {
  const params = {};
  if (role) params.role = role;             // provider|client|all
  if (status) params.status = status;       // pending|confirmed|completed|cancelled|rejected
  if (page) params.page = page;
  if (limit) params.limit = limit;
  if (from) params.from = from;             // ISO
  if (to) params.to = to;                   // ISO
  return api.get("/bookings/", { params });
}

export async function getBooking(bookingId) {
  return api.get(`/bookings/${bookingId}/`);
}

/** Generic patch for any state transition or notes update */
export async function updateBooking(bookingId, payload /* { action?, note?, notes? } */) {
  return api.patch(`/bookings/${bookingId}/`, { body: payload });
}

// ---- Booking action shorthands (POST endpoints) ----
export async function confirmBooking(bookingId, note = "") {
  return api.post(`/bookings/${bookingId}/confirm/`, { body: note ? { note } : {} });
}
export async function rejectBooking(bookingId, note = "") {
  return api.post(`/bookings/${bookingId}/reject/`, { body: note ? { note } : {} });
}
export async function cancelBookingAction(bookingId, note = "") {
  return api.post(`/bookings/${bookingId}/cancel/`, { body: note ? { note } : {} });
}
export async function completeBooking(bookingId, note = "") {
  return api.post(`/bookings/${bookingId}/complete/`, { body: note ? { note } : {} });
}

/* =======================================================
   🔧 MISC / DIAGNOSTICS (optional)
   ======================================================= */

export async function ping() {
  return api.get("/ping/");
}
