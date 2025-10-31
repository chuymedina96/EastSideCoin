# backend/middleware.py
from urllib.parse import parse_qs
from channels.db import database_sync_to_async
from django.contrib.auth.models import AnonymousUser, User
from rest_framework_simplejwt.tokens import AccessToken

class JwtAuthMiddleware:
    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        token = None

        # ?token=...
        if scope.get("query_string"):
            try:
                qs = parse_qs(scope["query_string"].decode())
                cand = qs.get("token")
                if cand and cand[0]:
                    token = cand[0]
            except Exception:
                pass

        # Authorization: Bearer ...
        if not token:
            try:
                headers = dict(scope.get("headers") or [])
                auth = headers.get(b"authorization")
                if auth:
                    scheme, val = auth.decode().split(" ", 1)
                    if scheme.lower() == "bearer":
                        token = val.strip()
            except Exception:
                pass

        if not token:
            print("❌ No token found in WebSocket connection.")
            scope["user"] = AnonymousUser()
            return await self.inner(scope, receive, send)

        try:
            access = AccessToken(token)
            user = await self._get_user(access.get("user_id"))
            scope["user"] = user or AnonymousUser()
        except Exception:
            print("❌ Invalid Token: Token is invalid or expired")
            scope["user"] = AnonymousUser()

        return await self.inner(scope, receive, send)

    @database_sync_to_async
    def _get_user(self, user_id):
        try:
            return User.objects.get(id=user_id)
        except User.DoesNotExist:
            return None
