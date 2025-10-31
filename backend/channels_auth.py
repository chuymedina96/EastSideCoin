# project/channels_auth.py
from urllib.parse import parse_qs
from channels.db import database_sync_to_async
from channels.middleware import BaseMiddleware
from rest_framework_simplejwt.tokens import AccessToken
from django.contrib.auth import get_user_model

User = get_user_model()

@database_sync_to_async
def get_user_from_token(token):
    try:
        at = AccessToken(token)
        return User.objects.get(id=at["user_id"])
    except Exception:
        return None

class JwtAuthMiddleware(BaseMiddleware):
    async def __call__(self, scope, receive, send):
        qs = parse_qs(scope.get("query_string", b"").decode())
        token = (qs.get("token") or [None])[0]
        if not token:
            # 4001 = no token
            await send({"type": "websocket.close", "code": 4001})
            return
        user = await get_user_from_token(token)
        if not user:
            # 4401 = unauthorized/invalid token
            await send({"type": "websocket.close", "code": 4401})
            return
        scope["user"] = user
        return await super().__call__(scope, receive, send)
