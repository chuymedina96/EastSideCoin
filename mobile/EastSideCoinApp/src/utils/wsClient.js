// utils/wsClient.js
import { WS_URL } from "../config";

export function createChatSocket({
  token,
  baseUrl = WS_URL,            // must be like ws://host:port/ws  (no trailing slash)
  path = "/chat/",             // your routing path
  onOpen,
  onClose,
  onError,
  onMessage,
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

  const fullUrl = `${baseUrl}${path}?token=${encodeURIComponent(token)}`;
  let socket = new WebSocket(fullUrl);
  let closedByClient = false;

  socket.onopen = () => onOpen?.();
  socket.onerror = (e) => onError?.(e);
  socket.onclose = (e) => { if (!closedByClient) onClose?.(e); };
  socket.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      onMessage?.(data);
    } catch (err) {
      onError?.(err);
    }
  };

  const close = () => {
    closedByClient = true;
    try { socket.close(); } catch {}
  };

  return { socket, close };
}
