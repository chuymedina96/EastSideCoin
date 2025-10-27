# app/consumers.py
import json
from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.contrib.auth.models import AnonymousUser
from django.utils import timezone
from django.contrib.auth import get_user_model
from rest_framework_simplejwt.tokens import AccessToken

from .models import ChatMessage

User = get_user_model()


class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user = await self._get_user_from_token()
        if self.user is None or isinstance(self.user, AnonymousUser):
            await self.close(code=403)
            return

        # Personal room for this user only
        self.room_group_name = f"chat_user_{self.user.id}"

        await self.channel_layer.group_add(self.room_group_name, self.channel_name)
        await self.accept()
        print(f"✅ WebSocket Connected: {self.user.email} -> {self.room_group_name}")

    async def disconnect(self, close_code):
        try:
            if getattr(self, "room_group_name", None):
                await self.channel_layer.group_discard(self.room_group_name, self.channel_name)
        finally:
            print(f"🔴 WebSocket Disconnected: {getattr(self.user, 'email', 'Unknown')} (code={close_code})")

    async def receive(self, text_data: str):
        """
        Expected payload (E2EE):
        {
          "receiver_id": <int>,
          "encrypted_message": "<b64>",
          "iv": "<b64>",
          "mac": "<b64>",
          "encrypted_key": "<b64>",               # for receiver (RSA-OAEP wrap)   [alias: encrypted_key_for_receiver]
          "encrypted_key_sender": "<b64>"         # for sender  (RSA-OAEP wrap)    [alias: encrypted_key_for_sender]
        }
        """
        if not self.user or isinstance(self.user, AnonymousUser):
            await self._send_error("unauthorized", "Not authenticated.")
            return

        try:
            data = json.loads(text_data or "{}")
        except Exception:
            await self._send_error("bad_json", "Invalid JSON payload.")
            return

        # ---- Alias handling to be resilient to client field names ----
        receiver_id = data.get("receiver_id")
        enc_msg = data.get("encrypted_message")
        iv = data.get("iv")
        mac = data.get("mac")
        enc_key_recv = data.get("encrypted_key") or data.get("encrypted_key_for_receiver")
        enc_key_sender = data.get("encrypted_key_sender") or data.get("encrypted_key_for_sender")

        # Noisy but compact log (keys only, not values)
        try:
            print("📩 WS RX keys:", sorted(list(data.keys())))
        except Exception:
            pass

        # Validate required fields
        missing = [k for k, v in {
            "receiver_id": receiver_id,
            "encrypted_message": enc_msg,
            "iv": iv,
            "mac": mac,
            "encrypted_key": enc_key_recv,
        }.items() if not v]
        if missing:
            await self._send_error("missing_fields", f"Missing: {', '.join(missing)}")
            return

        # Basic type guard
        try:
            receiver_id = int(receiver_id)
        except Exception:
            await self._send_error("bad_field", "receiver_id must be an integer.")
            return

        # Optional: prevent self-send
        # if receiver_id == int(self.user.id):
        #     await self._send_error("invalid_receiver", "Cannot send messages to yourself.")
        #     return

        # Lookup receiver
        try:
            receiver = await database_sync_to_async(User.objects.get)(id=receiver_id)
        except User.DoesNotExist:
            await self._send_error("not_found", "Receiver not found.")
            return

        # Persist message with full bundle
        try:
            msg = await database_sync_to_async(ChatMessage.objects.create)(
                sender=self.user,
                receiver=receiver,
                encrypted_message=enc_msg,
                iv=iv,
                mac=mac,
                encrypted_key_for_receiver=enc_key_recv,
                encrypted_key_for_sender=enc_key_sender,
                timestamp=timezone.now(),
            )
        except Exception as e:
            print("❌ DB create error:", e)
            await self._send_error("server_error", "Failed to store message.")
            return

        payload = {
            "id": str(msg.id),
            "sender": self.user.id,
            "receiver": receiver.id,
            "encrypted_message": msg.encrypted_message,
            "iv": msg.iv,
            "mac": msg.mac,
            "encrypted_key": msg.encrypted_key_for_receiver,
            "encrypted_key_sender": msg.encrypted_key_for_sender,
            "timestamp": msg.timestamp.isoformat(),
            "is_read": msg.is_read,
        }

        sender_room = f"chat_user_{self.user.id}"
        receiver_room = f"chat_user_{receiver.id}"

        # Fan out to both rooms
        await self.channel_layer.group_send(sender_room,   {"type": "chat.message", "message": payload})
        await self.channel_layer.group_send(receiver_room, {"type": "chat.message", "message": payload})

        # Lightweight ACK so client can confirm persistence if desired
        await self.send(text_data=json.dumps({"type": "ack", "ok": True, "message_id": str(msg.id)}))
        print(f"📤 WS Stored + Broadcast: msg={msg.id} sender={self.user.id} -> receiver={receiver.id}")

    async def chat_message(self, event):
        """Handler for 'type': 'chat.message'."""
        await self.send(text_data=json.dumps(event["message"]))

    # -------------------
    # Helpers
    # -------------------
    async def _get_user_from_token(self):
        """
        Extracts user from JWT in the WebSocket URL: ws[s]://.../ws/chat/?token=ACCESS_TOKEN
        """
        query_string = (self.scope.get("query_string") or b"").decode()
        token = None
        # Simple parse; expand with urllib.parse if you add more params
        if query_string.startswith("token="):
            token = query_string[len("token="):].strip()
        elif "token=" in query_string:
            token = query_string.split("token=", 1)[1].split("&", 1)[0].strip()

        if not token:
            print("❌ No token found in WebSocket connection.")
            return None

        try:
            decoded = AccessToken(token)
            user_id = decoded.get("user_id")
            if not user_id:
                return None
            user = await database_sync_to_async(User.objects.get)(id=user_id)
            return user
        except Exception as e:
            print(f"❌ Invalid Token: {e}")
            return None

    async def _send_error(self, code: str, message: str):
        await self.send(text_data=json.dumps({"type": "error", "code": code, "message": message}))
