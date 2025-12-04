# backend/settings.py
from pathlib import Path
from datetime import timedelta
from dotenv import load_dotenv
import os

BASE_DIR = Path(__file__).resolve().parent.parent

# Load env vars from .env before reading anything
load_dotenv(BASE_DIR / ".env")
print("DEBUG FROM ENV:", os.getenv("DEBUG"))
print("SECRET_KEY FROM ENV:", os.getenv("SECRET_KEY"))
print("AIS KEY:", os.getenv("AISSTREAM_API_KEY"))
print("USE_S3_MEDIA:", os.getenv("USE_S3_MEDIA"))


# -------------------------------------------------
# Core secrets / flags
# -------------------------------------------------
# SECRET_KEY comes from env in real usage; fallback is your current dev key
SECRET_KEY = os.getenv(
    "SECRET_KEY",
    "django-insecure-1jb=o$!k9_^uu*qg%=q$(mt@!qm-7yki8j&lz+^%5f16%tk(td",
)

# DEBUG from env (default True for local dev)
DEBUG = os.getenv("DEBUG", "True") == "True"

AISSTREAM_API_KEY = os.getenv("AISSTREAM_API_KEY")

# For local dev, allow everything. In prod, tighten this with env.
ALLOWED_HOSTS = ["*"]

# -------------------------------------------------
# CORS / CSRF (dev)
# -------------------------------------------------
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
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

# For now keep these hard-coded LAN origins for local
CORS_ALLOW_ALL_ORIGINS = False
CORS_ALLOWED_ORIGINS = [
    "http://192.168.1.131:8000",
    "http://172.20.10.2:8000",
    "http://192.168.0.144:8000",
    "http://192.168.0.1:8000",
    "http://192.168.1.131:8081",
    "http://192.168.0.144:8081",
    "http://192.168.0.1:8081",
    "http://172.20.10.2:8081",
    # Add Expo dev UI ports if needed:
    # "http://192.168.1.131:19006",
    # "http://172.20.10.2:19006",
]
CORS_ALLOW_CREDENTIALS = True
CORS_EXPOSE_HEADERS = ["Content-Disposition"]  # helpful for file downloads

CSRF_TRUSTED_ORIGINS = [
    "http://192.168.1.131:8000",
    "http://192.168.0.144:8000",
    "http://192.168.0.1:8000",
    "http://172.20.10.2:8000",
    "http://192.168.1.131:8081",
    "http://192.168.0.144:8081",
    "http://192.168.0.1:8081",
    "http://172.20.10.2:8081",
]

# -------------------------------------------------
# URL / Templates
# -------------------------------------------------
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

# -------------------------------------------------
# ASGI / Channels
# -------------------------------------------------
ASGI_APPLICATION = "backend.asgi.application"

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels.layers.InMemoryChannelLayer",
    }
}

# -------------------------------------------------
# Database (local sqlite)
# -------------------------------------------------
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }
}

# -------------------------------------------------
# DRF / JWT
# -------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": (
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ),
    "DEFAULT_RENDERER_CLASSES": ("rest_framework.renderers.JSONRenderer",),
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=10),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    "ROTATE_REFRESH_TOKENS": False,
    "BLACKLIST_AFTER_ROTATION": True,
    "ALGORITHM": "HS256",
    "SIGNING_KEY": SECRET_KEY,
    "AUTH_HEADER_TYPES": ("Bearer",),
}

# -------------------------------------------------
# Auth / passwords
# -------------------------------------------------
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

AUTH_USER_MODEL = "app.User"

# -------------------------------------------------
# Locale / time
# -------------------------------------------------
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

# -------------------------------------------------
# Static & Media (DEV)
# -------------------------------------------------
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = []  # add local "static" dirs here if you have them

MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# -------------------------------------------------
# Optional: switch to S3/DigitalOcean Spaces later
# -------------------------------------------------
USE_S3_MEDIA = os.getenv("USE_S3_MEDIA", "0") == "1"
if USE_S3_MEDIA:
    INSTALLED_APPS += ["storages"]

    AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID", "")
    AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY", "")
    AWS_STORAGE_BUCKET_NAME = os.getenv("AWS_STORAGE_BUCKET_NAME", "")
    AWS_S3_REGION_NAME = os.getenv("AWS_S3_REGION_NAME", "us-east-1")
    AWS_S3_ENDPOINT_URL = os.getenv("AWS_S3_ENDPOINT_URL", "") or None

    AWS_DEFAULT_ACL = None
    AWS_S3_FILE_OVERWRITE = False
    AWS_QUERYSTRING_AUTH = False

    AWS_S3_OBJECT_PARAMETERS = {
        "CacheControl": "max-age=31536000, s-maxage=31536000, immutable",
    }

    DEFAULT_FILE_STORAGE = "storages.backends.s3boto3.S3Boto3Storage"

    if AWS_S3_ENDPOINT_URL:
        AWS_S3_CUSTOM_DOMAIN = os.getenv("AWS_S3_CUSTOM_DOMAIN", "")
        if not AWS_S3_CUSTOM_DOMAIN:
            MEDIA_URL = f"{AWS_S3_ENDPOINT_URL.rstrip('/')}/{AWS_STORAGE_BUCKET_NAME}/"
        else:
            MEDIA_URL = f"https://{AWS_S3_CUSTOM_DOMAIN}/"
    else:
        AWS_S3_CUSTOM_DOMAIN = (
            f"{AWS_STORAGE_BUCKET_NAME}.s3.{AWS_S3_REGION_NAME}.amazonaws.com"
        )
        MEDIA_URL = f"https://{AWS_S3_CUSTOM_DOMAIN}/"

# -------------------------------------------------
# App-specific
# -------------------------------------------------
ETHEREUM_NODE_URL = os.getenv(
    "ETHEREUM_NODE_URL", "https://mainnet.infura.io/v3/YOUR_INFURA_PROJECT_ID"
)
ESC_CONTRACT_ADDRESS = os.getenv("ESC_CONTRACT_ADDRESS", "0xYourESCContractAddress")
ESC_PRICE_API = os.getenv(
    "ESC_PRICE_API",
    "https://api.coingecko.com/api/v3/simple/price?ids=eastside-coin&vs_currencies=usd",
)
