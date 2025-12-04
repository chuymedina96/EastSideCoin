# backend/asgi.py
import os
from django.core.asgi import get_asgi_application
from channels.auth import AuthMiddlewareStack
from channels.routing import ProtocolTypeRouter, URLRouter
from django.urls import path
from app.consumers import ChatConsumer
from app.routing import websocket_urlpatterns
from dotenv import load_dotenv

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "backend.settings")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))
django_asgi_app = get_asgi_application()

# Keep the WEBSOCKET PATH EXACTLY "/chat/" to match the app
websocket_urlpatterns = [
    path("chat/", ChatConsumer.as_asgi()),
]

application = ProtocolTypeRouter({
    "http": django_asgi_app,
    "websocket": AuthMiddlewareStack(
        URLRouter(websocket_urlpatterns)
    ),
})
