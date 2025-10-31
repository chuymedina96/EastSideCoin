# backend/settings.py
from pathlib import Path
from datetime import timedelta

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = "django-insecure-1jb=o$!k9_^uu*qg%=q$(mt@!qm-7yki8j&lz+^%5f16%tk(td"
DEBUG = True

# ✅ FIX: missing comma previously between "172.20.10.2" and "0.0.0.0"
ALLOWED_HOSTS = ["192.168.1.131", "172.20.10.2", "0.0.0.0", "localhost"]

# --- CORS / CSRF (dev-friendly) ---
INSTALLED_APPS = [
    "daphne",
    "channels",
    "corsheaders",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "rest_framework_simplejwt",
    "rest_framework_simplejwt.token_blacklist",
    "app",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",  # keep first
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

# If you truly want allow-all, set CORS_ALLOW_ALL_ORIGINS=True and remove the whitelist.
# Here we keep a whitelist for dev Expo + API.
CORS_ALLOW_ALL_ORIGINS = False
CORS_ALLOWED_ORIGINS = [
    "http://192.168.1.131:8000",  # Django API (if you load pages from here)
    "http://172.20.10.2:8000",
    "http://192.168.1.131:8081",  # Expo dev server
    "http://172.20.10.2:8081",
]
CORS_ALLOW_CREDENTIALS = True

# Needed when using cookies / form posts from those origins (safe to include in dev)
CSRF_TRUSTED_ORIGINS = [
    "http://192.168.1.131:8000",
    "http://172.20.10.2:8000",
    "http://192.168.1.131:8081",
    "http://172.20.10.2:8081",
]

ROOT_URLCONF = "backend.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

ASGI_APPLICATION = "backend.asgi.application"

# Dev: in-memory channel layer is fine; switch to Redis in prod.
CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels.layers.InMemoryChannelLayer",
    },
}
# Prod example (commented):
# CHANNEL_LAYERS = {
#     "default": {
#         "BACKEND": "channels_redis.core.RedisChannelLayer",
#         "CONFIG": {"hosts": [("127.0.0.1", 6379)]},
#     },
# }

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }
}

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": (
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ),
    "DEFAULT_RENDERER_CLASSES": (
        "rest_framework.renderers.JSONRenderer",
    ),
}

# ✅ SIMPLE_JWT: keep short access lifetime so the app exercises refresh logic.
SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=10),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    "ROTATE_REFRESH_TOKENS": False,
    "BLACKLIST_AFTER_ROTATION": True,
    "ALGORITHM": "HS256",
    "SIGNING_KEY": SECRET_KEY,
    # Allow reading "Authorization: Bearer <token>"
    "AUTH_HEADER_TYPES": ("Bearer",),
}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {
        "file": {"level": "DEBUG", "class": "logging.FileHandler", "filename": "django_debug.log"},
    },
    "loggers": {
        "django": {"handlers": ["file"], "level": "DEBUG", "propagate": True},
    },
}

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# App-specific
ETHEREUM_NODE_URL = "https://mainnet.infura.io/v3/YOUR_INFURA_PROJECT_ID"
ESC_CONTRACT_ADDRESS = "0xYourESCContractAddress"
ESC_PRICE_API = "https://api.coingecko.com/api/v3/simple/price?ids=eastside-coin&vs_currencies=usd"
AUTH_USER_MODEL = "app.User"
