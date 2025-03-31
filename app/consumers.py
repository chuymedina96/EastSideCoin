from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.contrib.auth.models import AnonymousUser
from rest_framework_simplejwt.tokens import AccessToken
from django.contrib.auth import get_user_model
import json

from app.models import ChatMessage

User = get_user_model()

class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user = await self.get_user_from_token()

        if self.user is None or isinstance(self.user, AnonymousUser):
            await self.close(code=403)  # 🔴 Reject unauthorized users
            return

        self.room_name = f"user_{self.user.id}"
        self.room_group_name = f"chat_{self.room_name}"

        await self.channel_layer.group_add(self.room_group_name, self.channel_name)
        await self.accept()
        print(f"✅ WebSocket Connected: {self.user.email}")

    async def disconnect(self, close_code):
        if self.user:
            await self.channel_layer.group_discard(self.room_group_name, self.channel_name)
        print(f"🔴 WebSocket Disconnected: {self.user.email if self.user else 'Unknown User'}")

    async def receive(self, text_data):
        data = json.loads(text_data)

        
        receiver_id = data["receiver_id"]
        encrypted_message = data["encrypted_message"]
        
        print("📥 Message received via WebSocket")
        print("📥 Message Received:", data)
        print("From:", self.user.email)
        print("To:", receiver_id)
        print("Encrypted message:", encrypted_message)

        receiver = await database_sync_to_async(User.objects.get)(id=receiver_id)
        message = await database_sync_to_async(ChatMessage.objects.create)(
            sender=self.user, receiver=receiver, encrypted_message=encrypted_message
        )

        response = {
            "id": str(message.id),
            "sender": self.user.id,
            "receiver": receiver.id,
            "encrypted_message": encrypted_message,
            "timestamp": str(message.timestamp),
        }

        await self.channel_layer.group_send(
            f"chat_user_{receiver.id}",
            {"type": "chat_message", "message": response},
        )

    async def chat_message(self, event):
        await self.send(text_data=json.dumps(event["message"]))

    async def get_user_from_token(self):
        """
        ✅ Extracts user from JWT token in WebSocket URL
        """
        query_string = self.scope.get("query_string", b"").decode()
        token = query_string.replace("token=", "").strip()

        if not token:
            print("❌ No token found in WebSocket connection.")
            return None

        try:
            decoded_token = AccessToken(token)
            user = await database_sync_to_async(User.objects.get)(id=decoded_token["user_id"])
            return user
        except Exception as e:
            print(f"❌ Invalid Token: {e}")
            return None
