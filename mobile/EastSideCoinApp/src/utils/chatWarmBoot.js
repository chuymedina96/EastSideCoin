// utils/chatWarmBoot.js
import AsyncStorage from "@react-native-async-storage/async-storage";
import { fetchThreadsIndex, fetchConversation, api as apiClient } from "./api";
import { decryptAES, decryptRSA } from "../utils/encryption";

/** Keep in sync with ChatScreen.js */
const THREADS_KEY = "chat_threads_index_v1";
const MSGS_KEY_PREFIX = "chat_msgs_";
const CACHE_LIMIT = 20;

const asId = (v) => String(v ?? "");
const nameOf = (u) => (`${u?.first_name || ""} ${u?.last_name || ""}`.trim() || u?.email || "Neighbor");

const b64FixPadding = (b64) => {
  if (!b64) return b64;
  const s = String(b64).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  return pad === 0 ? s : s + "=".repeat(4 - pad);
};

const normalizeWrapAliases = (m) => {
  const x = { ...m };
  if (!x.encrypted_key_for_receiver && x.encrypted_key) x.encrypted_key_for_receiver = x.encrypted_key;
  if (!x.encrypted_key_for_sender && x.encrypted_key_sender) x.encrypted_key_for_sender = x.encrypted_key_sender;
  return x;
};

const pickWrapForMe = (raw, meId) => {
  const m = normalizeWrapAliases(raw);
  if (m.encrypted_key_for_me) return { value: m.encrypted_key_for_me };
  const me = String(meId);
  const sender = String(m.sender ?? m.sender_id);
  const receiver = String(m.receiver ?? m.receiver_id);
  if (receiver === me && (m.encrypted_key_for_receiver || m.encrypted_key)) {
    return { value: m.encrypted_key_for_receiver || m.encrypted_key };
  }
  if (sender === me && m.encrypted_key_for_sender) {
    return { value: m.encrypted_key_for_sender };
  }
  return { value: null };
};

function pruneToCacheLimit(arr, limit = CACHE_LIMIT) {
  if (!Array.isArray(arr) || arr.length <= limit) return arr || [];
  const sorted = arr.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return sorted.slice(-limit);
}

function mergeUniqueById(a, b) {
  const map = new Map();
  for (const m of a || []) map.set(String(m._id), m);
  for (const m of b || []) map.set(String(m._id), m);
  return Array.from(map.values()).sort((x, y) => new Date(x.createdAt) - new Date(y.createdAt));
}

async function decryptServerRows(rows, privateKeyPem, meId, otherUser) {
  const out = [];
  for (const raw of rows || []) {
    try {
      const m = normalizeWrapAliases(raw);
      const { value: wrap } = pickWrapForMe(m, meId);
      if (!wrap) continue;

      let keyB64;
      try { keyB64 = decryptRSA(b64FixPadding(wrap), privateKeyPem); } catch { continue; }

      const text = decryptAES({
        ciphertextB64: b64FixPadding(m.encrypted_message),
        ivB64: b64FixPadding(m.iv),
        macB64: b64FixPadding(m.mac),
        keyB64: b64FixPadding(keyB64),
      });
      if (!text || text === "[Auth Failed]" || text === "[Decryption Failed]") continue;

      const mine = String(m.sender ?? m.sender_id) === String(meId);
      const createdAt = (m.timestamp ? new Date(m.timestamp) :
                        m.created_at ? new Date(m.created_at) : new Date());

      out.push({
        _id: String(m.id || `${Date.now()}_${Math.random()}`),
        text,
        createdAt,
        user: { _id: mine ? String(meId) : String(otherUser.id), name: mine ? "You" : nameOf(otherUser) },
      });
    } catch {}
  }
  return out.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

/**
 * Warm boot the chat by fetching and caching the latest messages for top threads.
 * @param {object} opts
 * @param {number} opts.maxThreads - how many threads to pre-hydrate (default 8)
 * @param {number} opts.pageSize - messages per conversation fetch (default 50)
 * @param {number} opts.staleMs - do nothing if a recent warmboot ran (default 60s)
 * @param {() => Promise<string|null>} [opts.getAccessToken] - optional; ensures token freshness
 * @param {string|number} opts.userId - current user id
 */
export async function warmBootChat({
  userId,
  maxThreads = 8,
  pageSize = 50,
  staleMs = 60_000,
  getAccessToken,
} = {}) {
  try {
    if (!userId) return;

    const lastKey = `u${userId}:chat_warmboot_last`;
    const last = Number(await AsyncStorage.getItem(lastKey) || 0);
    if (Date.now() - last < staleMs) return; // recently warmed

    // Ensure API client has a token
    if (typeof getAccessToken === "function") {
      const tok = await getAccessToken();
      if (!tok) return;
    }

    // Mirror per-user private key to "privateKey" (matches ChatScreen behavior)
    let privateKeyPem = await AsyncStorage.getItem(`privateKey_${userId}`);
    if (!privateKeyPem) privateKeyPem = await AsyncStorage.getItem("privateKey");
    if (!privateKeyPem) return;
    await AsyncStorage.setItem("privateKey", privateKeyPem);

    // 1) Fetch threads index
    const threadsPayload = await fetchThreadsIndex();
    const threadsArr = Array.isArray(threadsPayload) ? threadsPayload : (threadsPayload?.results || []);
    if (!threadsArr.length) {
      await AsyncStorage.setItem(`u${userId}:${THREADS_KEY}`, JSON.stringify({}));
      await AsyncStorage.setItem(lastKey, String(Date.now()));
      return;
    }

    // Normalize + persist the index right away (fast UI)
    const normalizedThreads = {};
    for (const t of threadsArr) {
      const id = asId(t.id);
      normalizedThreads[id] = {
        id,
        name: nameOf(t),
        meta: { first_name: t.first_name, last_name: t.last_name, email: t.email },
        lastText: t.lastText || "",
        updatedAt: t.updatedAt || new Date().toISOString(),
        unread: t.unread || 0,
      };
    }
    await AsyncStorage.setItem(`u${userId}:${THREADS_KEY}`, JSON.stringify(normalizedThreads));

    // 2) Pick top N most recently updated threads to hydrate
    const top = Object.values(normalizedThreads)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .slice(0, Math.max(1, maxThreads));

    // 3) For each thread, fetch last page and decrypt → cache
    for (const th of top) {
      const other = { id: th.id, ...th.meta };
      try {
        const conv = await fetchConversation(th.id, { page: 1, limit: pageSize });
        const rows = Array.isArray(conv?.results) ? conv.results : (Array.isArray(conv) ? conv : []);
        const decrypted = await decryptServerRows(rows, privateKeyPem, userId, other);
        const pruned = pruneToCacheLimit(decrypted);

        // Save to the same cache key ChatScreen uses
        const msgsKey = `u${userId}:${MSGS_KEY_PREFIX}${asId(th.id)}`;
        await AsyncStorage.setItem(msgsKey, JSON.stringify(pruned));
      } catch (e) {
        // non-fatal for individual threads
        // console.log("warmBoot thread err:", e?.message || e);
      }
    }

    await AsyncStorage.setItem(lastKey, String(Date.now()));
  } catch (e) {
    // console.log("warmBootChat error:", e?.message || e);
  }
}
