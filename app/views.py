# views.py
from datetime import timedelta

from django.utils.dateparse import parse_datetime
from django.core.paginator import Paginator, EmptyPage
from django.db.models import Q, Max, Count, Sum
from django.utils import timezone
from django.contrib.auth.hashers import make_password, check_password
from django.contrib.auth import get_user_model
from django.conf import settings
from django.core.files.images import get_image_dimensions
from django.core.files.uploadedfile import InMemoryUploadedFile, TemporaryUploadedFile
from django.core.mail import send_mail
from django.db import transaction as db_transaction

from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework import status

from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError

from decimal import Decimal, InvalidOperation

from .models import (
    ChatMessage,
    Service,
    Booking,
    Transaction,
    WalletActivity,
    EscEconomySnapshot,  # 🔥 new: sim snapshot model
)  # noqa: F401

User = get_user_model()


# ---------------------------
# Utilities
# ---------------------------
def _avatar_url(u: User, request=None):
    if getattr(u, "avatar", None):
        try:
            url = u.avatar.url
        except Exception:
            url = f"{getattr(settings, 'MEDIA_URL', '/media/')}{u.avatar.name}"
        return request.build_absolute_uri(url) if request else url
    return None


def _serialize_user(u: User, request=None):
    return {
        "id": u.id,
        "email": u.email,
        "first_name": u.first_name,
        "last_name": u.last_name,
    }


def _serialize_user_with_wallet(u: User, request=None):
    return {
        "id": u.id,
        "email": u.email,
        "first_name": u.first_name,
        "last_name": u.last_name,
        "wallet_address": getattr(u, "wallet_address", None),
        "avatar_url": _avatar_url(u, request),
        "has_public_key": bool(getattr(u, "public_key", None)),
    }


def _serialize_me(u: User, request=None):
    return {
        "id": u.id,
        "email": u.email,
        "first_name": u.first_name,
        "last_name": u.last_name,
        "wallet_address": getattr(u, "wallet_address", None),
        "public_key": getattr(u, "public_key", None),
        "has_public_key": bool(
            getattr(u, "public_key", None)
        ),  # ✅ quick boolean for client
        "avatar_url": _avatar_url(u, request),
        "esc_balance": float(getattr(u, "esc_balance", 0.0)),
        "is_vip": bool(getattr(u, "is_vip", False)),
        "bio": getattr(u, "bio", "") or "",
        "education": getattr(u, "education", "") or "",
        "age": getattr(u, "age", None),
        "neighborhood": getattr(u, "neighborhood", "") or "",
        "skills": getattr(u, "skills", "") or "",
        "languages": getattr(u, "languages", "") or "",
        "onboarding_completed": bool(getattr(u, "onboarding_completed", False)),
    }


def _serialize_message_for_requester(m: ChatMessage, requester_id: int):
    ts = m.timestamp or timezone.now()
    return {
        "id": str(m.id),
        "sender": m.sender_id,
        "receiver": m.receiver_id,
        "encrypted_message": m.encrypted_message,
        "iv": m.iv,
        "mac": m.mac,
        # REST canon
        "encrypted_key": m.encrypted_key_for_receiver,
        "encrypted_key_sender": m.encrypted_key_for_sender,
        # WS aliases
        "encrypted_key_for_receiver": m.encrypted_key_for_receiver,
        "encrypted_key_for_sender": m.encrypted_key_for_sender,
        "timestamp": ts.isoformat(),
        "is_read": m.is_read,
    }


def _tzsafe_parse(dt_str):
    if not dt_str:
        return None
    dt = parse_datetime(dt_str)
    if not dt:
        return None
    if timezone.is_naive(dt):
        dt = timezone.make_aware(dt, timezone.get_current_timezone())
    return dt


# ===========================
# 🔐 Auth / Keys
# ===========================
@api_view(["POST"])
@permission_classes([AllowAny])
def register_user(request):
    print("🚀 Register API Hit!")
    try:
        data = request.data
        first_name = data.get("first_name")
        last_name = data.get("last_name")
        email = (data.get("email") or "").strip().lower()
        password = data.get("password")
        wallet_address = data.get("wallet_address")

        if not all([first_name, last_name, email, password, wallet_address]):
            return Response(
                {"error": "All fields are required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if User.objects.filter(email=email).exists():
            return Response(
                {"error": "Email is already in use"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        user = User.objects.create(
            first_name=first_name,
            last_name=last_name,
            email=email,
            password=make_password(password),
            wallet_address=wallet_address,
            public_key=None,
        )
        print(f"✅ User Registered: {user.id} {user.email}")
        return Response(
            {"message": "User registered successfully", "requires_key_setup": True},
            status=status.HTTP_201_CREATED,
        )
    except Exception as e:
        print(f"❌ ERROR Registering User: {e}")
        return Response(
            {"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def generate_keys(request):
    user = request.user
    received_public_key = (request.data.get("public_key") or "").strip()

    if user.public_key:
        return Response(
            {"message": "Keys already generated"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if not received_public_key.startswith("-----BEGIN PUBLIC KEY-----"):
        print("❌ Invalid or missing public key format.")
        return Response(
            {"error": "Invalid public key format."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    try:
        user.public_key = received_public_key
        user.save(update_fields=["public_key"])
        print(f"✅ Public key stored for {user.email}")
        return Response(
            {"message": "Keys stored successfully"}, status=status.HTTP_200_OK
        )
    except Exception as e:
        print(f"❌ ERROR Storing Keys: {e}")
        return Response(
            {"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )


@api_view(["POST"])
@permission_classes([AllowAny])
def login_user(request):
    print("🚀 Login API Hit!")
    try:
        email = (request.data.get("email") or "").strip().lower()
        password = request.data.get("password")

        if not email or not password:
            return Response(
                {"error": "Email and password are required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            user = User.objects.get(email=email)
        except User.DoesNotExist:
            print("❌ Invalid credentials (email)")
            return Response(
                {"error": "Invalid credentials"},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        if not check_password(password, user.password):
            print("❌ Invalid credentials (password)")
            return Response(
                {"error": "Invalid credentials"},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        refresh = RefreshToken.for_user(user)
        access = refresh.access_token

        print(f"✅ Login Successful for {user.email}")
        return Response(
            {
                "access": str(access),
                "refresh": str(refresh),
                "exp": int(access["exp"]),
                "user": {
                    **_serialize_user_with_wallet(user, request),
                    "public_key": getattr(user, "public_key", None),
                    "has_public_key": bool(
                        getattr(user, "public_key", None)
                    ),  # mirror /me/
                },
            },
            status=status.HTTP_200_OK,
        )
    except Exception as e:
        print(f"❌ CRITICAL ERROR in login: {e}")
        return Response(
            {"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )


@api_view(["POST"])
@permission_classes([AllowAny])
def refresh_token_view(request):
    """
    POST /refresh/
    Body: { "refresh": "<refresh-token>" }
    Returns: { "access": "<new-access>", "exp": <unix-seconds> }
    """
    try:
        raw = request.data.get("refresh")
        if not raw:
            return Response({"error": "Missing refresh"}, status=400)
        rt = RefreshToken(raw)
        at = rt.access_token
        return Response({"access": str(at), "exp": int(at["exp"])}, status=200)
    except (InvalidToken, TokenError):
        return Response({"error": "Invalid refresh"}, status=401)
    except Exception as e:
        print("❌ refresh error:", e)
        return Response({"error": str(e)}, status=500)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def logout_user(request):
    try:
        print("🚀 Logout API Hit!")
        refresh_token = request.data.get("token")
        if not refresh_token:
            return Response(
                {"error": "Refresh token required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            refresh = RefreshToken(refresh_token)
            refresh.blacklist()
            print("✅ Logout successful; refresh token blacklisted.")
            return Response(
                {"message": "Logout successful, token blacklisted."},
                status=status.HTTP_200_OK,
            )
        except Exception as e:
            print(f"❌ Invalid refresh token: {e}")
            return Response({"error": "Invalid token"}, status=status.HTTP_400_BAD_REQUEST)
    except Exception as e:
        print(f"❌ CRITICAL ERROR in logout: {e}")
        return Response(
            {"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )


@api_view(["DELETE"])
@permission_classes([IsAuthenticated])
def delete_account(request):
    """
    DELETE /delete_account/
    Optional body: { "refresh": "<refresh_token_string>" }
    """
    try:
        user = request.user
        refresh = request.data.get("refresh")

        if refresh:
            try:
                RefreshToken(refresh).blacklist()
            except Exception:
                pass

        ChatMessage.objects.filter(Q(sender=user) | Q(receiver=user)).delete()
        user.delete()

        return Response(status=status.HTTP_204_NO_CONTENT)
    except Exception as e:
        return Response(
            {"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )


# ===========================
# 👤 Me / Profile / Avatar
# ===========================
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def me_profile(request):
    """GET /me/ — current user profile (includes avatar_url, wallet, etc.)"""
    return Response(_serialize_me(request.user, request), status=200)


@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticated])
def me_detail_update(request):
    """
    GET  /me/ or /users/me/           -> profile payload (same as me_profile)
    PATCH /me/update/ or /users/me/   -> partial update of profile fields
       Body can include any subset of:
        - neighborhood (str)
        - skills (str)
        - languages (str)
        - bio (str)
        - age (int or null)
        - onboarding_completed (bool)
    """
    me = request.user

    if request.method == "GET":
        return Response(_serialize_me(me, request), status=200)

    # PATCH
    data = request.data or {}
    if "body" in data and isinstance(data["body"], dict):
        data = data["body"]

    fields = {}
    if "neighborhood" in data:
        fields["neighborhood"] = (data.get("neighborhood") or "").strip()
    if "skills" in data:
        fields["skills"] = (data.get("skills") or "").strip()
    if "languages" in data:
        fields["languages"] = (data.get("languages") or "").strip()
    if "bio" in data:
        fields["bio"] = (data.get("bio") or "").strip()
    if "age" in data:
        age_val = data.get("age")
        try:
            fields["age"] = int(age_val) if age_val is not None else None
        except (ValueError, TypeError):
            return Response({"error": "age must be an integer"}, status=400)
    if "onboarding_completed" in data:
        fields["onboarding_completed"] = bool(data.get("onboarding_completed"))

    if not fields:
        return Response({"error": "No updatable fields supplied"}, status=400)

    for k, v in fields.items():
        setattr(me, k, v)
    me.save(update_fields=list(fields.keys()))

    return Response(_serialize_me(me, request), status=200)


@api_view(["POST", "DELETE"])
@permission_classes([IsAuthenticated])
def profile_avatar(request):
    """
    POST /profile/avatar/  (multipart/form-data, field 'avatar')
    DELETE /profile/avatar/
    """
    me = request.user

    if request.method == "DELETE":
        if getattr(me, "avatar", None):
            me.avatar.delete(save=False)
            me.avatar = None
        me.save(update_fields=["avatar"])
        return Response({"avatar_url": None}, status=200)

    file = request.FILES.get("avatar")
    if not file:
        return Response(
            {"error": "No file uploaded (use 'avatar' field)."}, status=400
        )

    allowed = {"image/jpeg", "image/png", "image/webp", "image/gif"}
    content_type = getattr(file, "content_type", "").lower()
    if content_type not in allowed:
        return Response(
            {"error": "Unsupported image type. Use JPEG/PNG/WebP/GIF."},
            status=400,
        )

    max_bytes = 5 * 1024 * 1024  # 5MB
    if file.size > max_bytes:
        return Response({"error": "File too large (max 5MB)."}, status=400)

    try:
        if isinstance(file, (InMemoryUploadedFile, TemporaryUploadedFile)):
            width, height = get_image_dimensions(file)
            if not width or not height:
                return Response({"error": "Invalid image."}, status=400)
            if width > 6000 or height > 6000:
                return Response(
                    {"error": "Image too large in dimensions (max 6000x6000)."},
                    status=400,
                )
    except Exception:
        pass

    if getattr(me, "avatar", None):
        me.avatar.delete(save=False)
    me.avatar = file
    me.save(update_fields=["avatar"])

    return Response({"avatar_url": _avatar_url(me, request)}, status=200)


# ===========================
# 👥 Users / Search / Detail
# ===========================
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def search_users(request):
    raw = request.GET.get("q") or request.GET.get("query") or ""
    query = raw.strip()
    print(f"🚀 Searching Users: '{query}'")
    if not query:
        return Response([], status=status.HTTP_200_OK)

    tokens = [t for t in query.split() if t]
    qs = User.objects.exclude(id=request.user.id)

    for t in tokens:
        qs = qs.filter(
            Q(first_name__icontains=t)
            | Q(last_name__icontains=t)
            | Q(email__icontains=t)
            | Q(wallet_address__icontains=t)
        )

    users = qs.only("id", "first_name", "last_name", "email", "wallet_address")[
        :25
    ]
    return Response(
        [_serialize_user_with_wallet(u, request) for u in users],
        status=status.HTTP_200_OK,
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def user_detail(request, user_id: int):
    """
    GET /users/<id>/
      - If id == me.id -> full me-style payload
      - Else -> public-ish info with wallet + profile fields
    """
    try:
        u = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return Response({"error": "User not found"}, status=404)

    if u.id == request.user.id:
        payload = _serialize_me(u, request)
    else:
        payload = _serialize_user_with_wallet(u, request)
        # public profile fields for neighbors
        payload.update(
            {
                "bio": getattr(u, "bio", "") or "",
                "education": getattr(u, "education", "") or "",
                "age": getattr(u, "age", None),
                "neighborhood": getattr(u, "neighborhood", "") or "",
                "skills": getattr(u, "skills", "") or "",
                "languages": getattr(u, "languages", "") or "",
            }
        )

    return Response(payload, status=200)


# ===========================
# 💬 Threads (Server-backed)
# ===========================
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def conversations_index(request):
    """
    GET /conversations/index/
    """
    me = request.user
    try:
        base = ChatMessage.objects.filter(Q(sender=me) | Q(receiver=me))
        latest_rows = base.values("sender_id", "receiver_id").annotate(
            last_ts=Max("timestamp")
        )

        partner_latest = {}
        for row in latest_rows:
            s_id, r_id, ts = row["sender_id"], row["receiver_id"], row["last_ts"]
            other_id = r_id if s_id == me.id else s_id
            if other_id == me.id or other_id is None:
                continue
            prev = partner_latest.get(other_id)
            if (not prev) or (ts and ts > prev):
                partner_latest[other_id] = ts

        partner_ids = list(partner_latest.keys())
        if not partner_ids:
            return Response([], status=status.HTTP_200_OK)

        unread_qs = (
            ChatMessage.objects.filter(
                receiver=me, is_read=False, sender_id__in=partner_ids
            )
            .values("sender_id")
            .annotate(unread=Count("id"))
        )
        unread_map = {row["sender_id"]: row["unread"] for row in unread_qs}

        partners = User.objects.filter(id__in=partner_ids).only(
            "id", "first_name", "last_name", "email"
        )

        items = []
        for u in partners:
            items.append(
                {
                    "id": u.id,
                    "first_name": u.first_name,
                    "last_name": u.last_name,
                    "email": u.email,
                    "updatedAt": (
                        partner_latest.get(u.id) or timezone.now()
                    ).isoformat(),
                    "unread": unread_map.get(u.id, 0),
                    "lastText": "",
                    "avatar_url": _avatar_url(u, request),
                    "has_public_key": bool(getattr(u, "public_key", None)),
                }
            )

        items.sort(key=lambda x: x["updatedAt"], reverse=True)
        return Response(items, status=status.HTTP_200_OK)
    except Exception as e:
        print("❌ conversations_index error:", e)
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mark_thread_read(request, other_id: int):
    """
    POST /conversations/mark_read/<other_id>/
    """
    me = request.user
    try:
        updated = ChatMessage.objects.filter(
            sender_id=other_id, receiver=me, is_read=False
        ).update(is_read=True)
        return Response({"updated": updated}, status=status.HTTP_200_OK)
    except Exception as e:
        print("❌ mark_thread_read error:", e)
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ===========================
# 💌 Messages / Conversations
# ===========================
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def get_messages(request):
    """
    Inbox-style for the authenticated user (as receiver).
    If you want both directions, prefer get_conversation().
    """
    print("🚀 Get Messages API Hit!")
    try:
        messages = ChatMessage.objects.filter(receiver=request.user).order_by(
            "-timestamp", "-id"
        )
        results = [
            _serialize_message_for_requester(m, request.user.id) for m in messages
        ]
        return Response(results, status=status.HTTP_200_OK)
    except Exception as e:
        print("❌ get_messages error:", e)
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def my_threads(request):
    """
    (Legacy) Returns peers with latest timestamp and a ciphertext preview.
    Prefer conversations_index.
    """
    print("🚀 My Threads API Hit!")
    try:
        me = request.user
        peer_pairs = ChatMessage.objects.filter(
            Q(sender=me) | Q(receiver=me)
        ).values_list("sender_id", "receiver_id", "id", "timestamp", "encrypted_message")

        latest_by_peer = {}
        for s_id, r_id, msg_id, ts, enc in peer_pairs:
            other_id = r_id if s_id == me.id else s_id
            if other_id == me.id:
                continue
            prev = latest_by_peer.get(other_id)
            if (not prev) or (ts and ts > prev["timestamp"]):
                latest_by_peer[other_id] = {"timestamp": ts, "encrypted_message": enc or ""}

        if not latest_by_peer:
            return Response([], status=status.HTTP_200_OK)

        peers = User.objects.filter(id__in=list(latest_by_peer.keys())).only(
            "id", "first_name", "last_name", "email"
        )

        items = []
        for u in peers:
            meta = latest_by_peer.get(u.id)
            items.append(
                {
                    "peer": _serialize_user(u),
                    "latest_timestamp": meta["timestamp"].isoformat()
                    if meta["timestamp"]
                    else None,
                    "latest_encrypted_message": meta["encrypted_message"],
                }
            )

        items.sort(key=lambda x: x["latest_timestamp"] or "", reverse=True)
        return Response(items, status=status.HTTP_200_OK)
    except Exception as e:
        print("❌ my_threads error:", e)
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def get_conversation(request, other_id: int):
    """
    GET /conversations/<other_id>/?limit=50&page=1&before=...&after=...
    Returns encrypted messages BETWEEN the authed user and other_id.
    Sorted ASC (oldest -> newest).
    """
    print(f"🚀 Get Conversation API Hit: other_id={other_id}")
    try:
        try:
            other = User.objects.get(id=other_id)
        except User.DoesNotExist:
            return Response({"error": "User not found."}, status=status.HTTP_404_NOT_FOUND)

        limit = max(1, min(int(request.GET.get("limit", 50)), 200))
        page = int(request.GET.get("page", 1))
        before = _tzsafe_parse(request.GET.get("before"))
        after = _tzsafe_parse(request.GET.get("after"))

        qs = ChatMessage.objects.filter(
            Q(sender=request.user, receiver=other)
            | Q(sender=other, receiver=request.user)
        )
        if after:
            qs = qs.filter(timestamp__gt=after)
        if before:
            qs = qs.filter(timestamp__lt=before)

        qs = qs.order_by("timestamp", "id")

        paginator = Paginator(qs, limit)
        try:
            page_obj = paginator.page(page)
        except EmptyPage:
            return Response(
                {
                    "results": [],
                    "next_page": None,
                    "prev_page": None,
                    "count": paginator.count,
                },
                status=status.HTTP_200_OK,
            )

        items = [
            _serialize_message_for_requester(m, request.user.id)
            for m in page_obj.object_list
        ]
        next_page = page + 1 if page_obj.has_next() else None
        prev_page = page - 1 if page_obj.has_previous() else None

        return Response(
            {
                "results": items,
                "next_page": next_page,
                "prev_page": prev_page,
                "count": paginator.count,
            },
            status=status.HTTP_200_OK,
        )
    except Exception as e:
        print("❌ get_conversation error:", e)
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mark_message_read(request):
    print("🚀 Mark Message Read API Hit!")
    message_id = request.data.get("message_id")
    if not message_id:
        return Response(
            {"error": "Message ID is required"}, status=status.HTTP_400_BAD_REQUEST
        )

    try:
        message = ChatMessage.objects.get(id=message_id, receiver=request.user)
        message.is_read = True
        message.save(update_fields=["is_read"])
        return Response({"message": "Message marked as read"}, status=status.HTTP_200_OK)
    except ChatMessage.DoesNotExist:
        return Response({"error": "Message not found"}, status=status.HTTP_404_NOT_FOUND)
    except Exception as e:
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mark_messages_read_batch(request):
    """
    Body: { "ids": ["uuid1","uuid2", ...] }
    Marks only messages where receiver==request.user.
    """
    print("🚀 Mark Messages Read BATCH API Hit!")
    ids = request.data.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return Response(
            {"error": "ids must be a non-empty list"},
            status=status.HTTP_400_BAD_REQUEST,
        )
    try:
        updated = ChatMessage.objects.filter(
            id__in=ids, receiver=request.user, is_read=False
        ).update(is_read=True)
        return Response({"updated": updated}, status=status.HTTP_200_OK)
    except Exception as e:
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def send_message(request):
    """
    Expect body:
    {
      "receiver_id": <int>,
      "encrypted_message": "<b64>",
      "iv": "<b64>",
      "mac": "<b64>",
      "encrypted_key" or "encrypted_key_for_receiver": "<b64>",  # required
      "encrypted_key_sender" or "encrypted_key_for_sender": "<b64>"  # optional
    }
    """
    print("🚀 Send Message API Hit!")
    try:
        data = request.data
        try:
            print("📥 send_message keys:", list(data.keys()))
        except Exception:
            pass

        receiver_id = data.get("receiver_id")
        enc_msg = data.get("encrypted_message")
        iv = data.get("iv")
        mac = data.get("mac")
        enc_key_recv = data.get("encrypted_key") or data.get(
            "encrypted_key_for_receiver"
        )
        enc_key_sender = data.get("encrypted_key_sender") or data.get(
            "encrypted_key_for_sender"
        )

        if not all([receiver_id, enc_msg, iv, mac, enc_key_recv]):
            return Response(
                {
                    "error": "receiver_id, encrypted_message, iv, mac, and encrypted_key (receiver) are required"
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            receiver = User.objects.get(id=receiver_id)
        except User.DoesNotExist:
            return Response({"error": "Receiver not found"}, status=status.HTTP_404_NOT_FOUND)

        msg = ChatMessage.objects.create(
            sender=request.user,
            receiver=receiver,
            encrypted_message=enc_msg,
            iv=iv,
            mac=mac,
            encrypted_key_for_receiver=enc_key_recv,
            encrypted_key_for_sender=enc_key_sender,
            timestamp=timezone.now(),
        )

        print(f"✅ Message stored: {msg.id}")
        payload = _serialize_message_for_requester(msg, request.user.id)
        return Response(payload, status=status.HTTP_201_CREATED)
    except Exception as e:
        print(f"❌ ERROR Sending Message: {e}")
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ===========================
# 💰 Wallet
# ===========================
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def wallet_balance(request):
    """
    GET /wallet/balance/
    """
    me = request.user
    balance = Decimal(getattr(me, "esc_balance", 0) or 0)
    # For now: fixed reference price; later, wire to on-chain or econ config.
    price_usd = Decimal(str(getattr(settings, "ESC_PRICE_USD", "0.10")))
    value_usd = balance * price_usd

    return Response(
        {
            "address": me.wallet_address,
            "balance": float(balance),
            "price_usd": float(price_usd),
            "value_usd": float(value_usd),
            "pending": False,
        },
        status=status.HTTP_200_OK,
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def check_balance(request, wallet_address):
    """
    GET /check_balance/<wallet_address>/
    """
    try:
        print(f"🚀 Checking wallet balance for: {wallet_address}")
        user = User.objects.filter(wallet_address=wallet_address).first()
        if not user:
            return Response({"error": "Wallet not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response(
            {
                "wallet": wallet_address,
                "balance": float(getattr(user, "esc_balance", 0.0)),
            },
            status=status.HTTP_200_OK,
        )
    except Exception as e:
        print(f"❌ ERROR Fetching Balance: {e}")
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def wallet_transactions(request):
    """
    GET /wallet/transactions/?limit=50
    Simple transaction history for the authenticated user.
    """
    me = request.user
    try:
        limit = int(request.GET.get("limit", 50))
    except ValueError:
        limit = 50
    limit = max(1, min(limit, 200))

    qs = (
        Transaction.objects.filter(Q(sender=me) | Q(receiver=me))
        .select_related("sender", "receiver")
        .order_by("-created_at")[:limit]
    )

    items = []
    for tx in qs:
        direction = "outgoing" if tx.sender_id == me.id else "incoming"
        other = tx.receiver if direction == "outgoing" else tx.sender

        # There should be at most one booking tied to this tx
        booking = Booking.objects.filter(transaction=tx).select_related(
            "service"
        ).first()

        items.append(
            {
                "id": tx.id,
                "direction": direction,
                "tx_type": getattr(tx, "tx_type", "payment"),
                "status": tx.status,
                "amount": float(tx.amount),
                "price_usd": float(getattr(tx, "price_usd", Decimal("0"))),
                "amount_usd": float(getattr(tx, "amount_usd", Decimal("0"))),
                "memo": getattr(tx, "memo", "") or "",
                "created_at": tx.created_at.isoformat() if tx.created_at else None,
                "other_user": {
                    "id": other.id if other else None,
                    "first_name": getattr(other, "first_name", "") if other else "",
                    "last_name": getattr(other, "last_name", "") if other else "",
                    "email": getattr(other, "email", "") if other else "",
                }
                if other
                else None,
                "booking": {
                    "id": booking.id,
                    "service_title": booking.service.title
                    if booking and booking.service
                    else "",
                    "start_at": booking.start_at.isoformat()
                    if booking and booking.start_at
                    else None,
                }
                if booking
                else None,
            }
        )

    return Response({"results": items}, status=status.HTTP_200_OK)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def wallet_pay(request):
    """
    POST /wallet/pay/
    Body:
      {
        "booking_id": <int>,
        "amount": <esc_amount>,   # or "amount_esc"
        "memo": "optional note"
      }

    - Only the client for the booking can pay.
    - Booking must be COMPLETED by the provider.
    - Moves esc_balance from client -> provider.
    - Creates Transaction + WalletActivity + ties to Booking.
    """
    me = request.user
    data = request.data or {}
    booking_id = data.get("booking_id")
    raw_amount = data.get("amount") or data.get("amount_esc")
    memo = (data.get("memo") or "").strip()

    if not booking_id or raw_amount is None:
        return Response(
            {"error": "booking_id and amount are required"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    try:
        amount = Decimal(str(raw_amount))
    except Exception:
        return Response(
            {"error": "amount must be numeric"}, status=status.HTTP_400_BAD_REQUEST
        )

    if amount <= 0:
        return Response(
            {"error": "amount must be positive"}, status=status.HTTP_400_BAD_REQUEST
        )

    try:
        booking = Booking.objects.select_related(
            "service", "provider", "client"
        ).get(id=booking_id)
    except Booking.DoesNotExist:
        return Response({"error": "Booking not found"}, status=status.HTTP_404_NOT_FOUND)

    if booking.client_id != me.id:
        return Response(
            {"error": "Only the client for this booking can pay"},
            status=status.HTTP_403_FORBIDDEN,
        )

    if booking.status != Booking.Status.COMPLETED:
        return Response(
            {
                "error": "Booking must be completed before payment",
                "current_status": booking.status,
            },
            status=status.HTTP_400_BAD_REQUEST,
        )

    expected = (
        booking.price_snapshot
        if booking.price_snapshot is not None
        else booking.service.price
    )
    if expected is not None and amount != expected:
        return Response(
            {
                "error": "Payment amount must match booking price",
                "expected_amount": float(expected),
            },
            status=status.HTTP_400_BAD_REQUEST,
        )

    provider = booking.provider

    # For now: fixed “neighborhood reference price”
    price_usd = Decimal(str(getattr(settings, "ESC_PRICE_USD", "0.10")))
    amount_usd = amount * price_usd

    with db_transaction.atomic():
        me.refresh_from_db()
        provider.refresh_from_db()

        current_balance = Decimal(getattr(me, "esc_balance", 0) or 0)
        provider_balance = Decimal(getattr(provider, "esc_balance", 0) or 0)

        if current_balance < amount:
            return Response(
                {
                    "error": "Insufficient ESC balance",
                    "current_balance": float(current_balance),
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Move ESC
        me.esc_balance = current_balance - amount
        provider.esc_balance = provider_balance + amount
        me.save(update_fields=["esc_balance"])
        provider.save(update_fields=["esc_balance"])

        # Create Transaction record
        tx = Transaction.objects.create(
            sender=me,
            receiver=provider,
            amount=amount,
            status="completed",
            tx_type="payment",
            price_usd=price_usd,
            amount_usd=amount_usd,
            memo=(
                memo
                or f"Payment for {booking.service.title} on {booking.start_at:%Y-%m-%d %I:%M %p}"
            ),
        )

        # Link booking to tx + mark paid_at
        booking.transaction = tx
        booking.paid_at = timezone.now()
        booking.updated_at = booking.paid_at
        booking.save(update_fields=["transaction", "paid_at", "updated_at"])

        # WalletActivity logs
        WalletActivity.objects.create(
            user=me,
            activity_type="transfer",
            amount=-amount,
            transaction_hash=str(tx.id),
        )
        WalletActivity.objects.create(
            user=provider,
            activity_type="transfer",
            amount=amount,
            transaction_hash=str(tx.id),
        )

    # Email receipt to provider (best-effort; won't break tx if this fails)
    try:
        if provider.email:
            subject = f"[ESC] Payment received: {amount} ESC"
            lines = [
                f"Hi {provider.first_name or provider.email},",
                "",
                f"You just received {amount} ESC (~${amount_usd} at time of payment).",
                "",
                f"From: {me.first_name or me.email}",
                f"Service: {booking.service.title}",
                f"When: {booking.start_at:%Y-%m-%d %I:%M %p}",
                "",
                f"Memo: {memo or '(none)'}",
            ]
            send_mail(
                subject,
                "\n".join(lines),
                getattr(
                    settings,
                    "DEFAULT_FROM_EMAIL",
                    "no-reply@eastsidecoin.app",
                ),
                [provider.email],
                fail_silently=True,
            )
    except Exception as e:
        print("⚠️ send_mail error in wallet_pay:", e)

    return Response(
        {
            "tx_id": tx.id,
            "amount": float(tx.amount),
            "amount_usd": float(tx.amount_usd),
            "sender_balance": float(me.esc_balance),
            "receiver_balance": float(provider.esc_balance),
        },
        status=status.HTTP_201_CREATED,
    )


# ===========================
# 🧰 Services
# ===========================
def _serialize_service(s: Service):
    u = s.user
    return {
        "id": s.id,
        "title": s.title,
        "description": s.description,
        "price": float(s.price),
        "category": s.category or "Other",
        "created_at": (s.created_at or timezone.now()).isoformat(),
        "user": {
            "id": u.id,
            "email": u.email,
            "first_name": u.first_name,
            "last_name": u.last_name,
            "wallet_address": getattr(u, "wallet_address", None),
            "avatar_url": _avatar_url(u),
        },
    }


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def services_categories(request):
    try:
        cats = (
            Service.objects.exclude(category__isnull=True)
            .exclude(category__exact(""))
            .values_list("category", flat=True)
            .distinct()
        )
        normalized = sorted({(c or "Other").strip()[:100] for c in cats})
        return Response(normalized, status=200)
    except Exception as e:
        print("❌ services_categories error:", e)
        return Response({"error": str(e)}, status=500)


@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def services_list_create(request):
    """
    GET /services/?q=<text>&category=<name>&limit=50&page=1
    POST /services/  { title, description, price, category }
    """
    if request.method == "GET":
        q = (request.GET.get("q") or "").strip()
        category = (request.GET.get("category") or "").strip()
        limit = max(1, min(int(request.GET.get("limit", 50)), 200))
        page = int(request.GET.get("page", 1))

        qs = Service.objects.select_related("user").all()
        if category and category.lower() != "all":
            qs = qs.filter(category__iexact=category)
        if q:
            qs = qs.filter(
                Q(title__icontains=q)
                | Q(description__icontains=q)
                | Q(user__first_name__icontains=q)
                | Q(user__last_name__icontains=q)
                | Q(user__email__icontains=q)
            ).distinct()

        paginator = Paginator(qs.order_by("-created_at", "-id"), limit)
        try:
            page_obj = paginator.page(page)
        except EmptyPage:
            return Response(
                {
                    "results": [],
                    "next_page": None,
                    "prev_page": None,
                    "count": 0,
                },
                status=200,
            )

        items = [_serialize_service(s) for s in page_obj.object_list]
        return Response(
            {
                "results": items,
                "next_page": page + 1 if page_obj.has_next() else None,
                "prev_page": page - 1 if page_obj.has_previous() else None,
                "count": paginator.count,
            },
            status=200,
        )

    # POST (create)
    data = request.data
    title = (data.get("title") or "").strip()
    description = (data.get("description") or "").strip()
    category = (data.get("category") or "Other").strip()
    price_raw = data.get("price")

    if not title or not description or price_raw in (None, ""):
        return Response(
            {"error": "title, description, and price are required"},
            status=400,
        )

    try:
        price = Decimal(str(price_raw))
        if price < 0:
            raise InvalidOperation()
    except (InvalidOperation, ValueError, TypeError):
        return Response({"error": "price must be a non-negative number"}, status=400)

    s = Service.objects.create(
        user=request.user,
        title=title[:255],
        description=description,
        price=price,
        category=category[:100] if category else "Other",
    )
    return Response(_serialize_service(s), status=201)


@api_view(["GET", "PATCH", "PUT", "DELETE"])
@permission_classes([IsAuthenticated])
def services_detail(request, service_id: int):
    """
    GET /services/<id>/
    PATCH /services/<id>/
    PUT /services/<id>/
    DELETE /services/<id>/
    """
    try:
        s = Service.objects.select_related("user").get(id=service_id)
    except Service.DoesNotExist:
        return Response({"error": "Service not found"}, status=404)

    if request.method == "GET":
        return Response(_serialize_service(s), status=200)

    if s.user_id != request.user.id:
        return Response({"error": "Not allowed"}, status=403)

    if request.method == "DELETE":
        s.delete()
        return Response(status=204)

    data = request.data or {}
    if "title" in data:
        s.title = (data.get("title") or s.title or "").strip()[:255]
    if "description" in data:
        s.description = data.get("description") or s.description or ""
    if "category" in data:
        s.category = (data.get("category") or s.category or "Other").strip()[:100]
    if "price" in data:
        try:
            p = Decimal(str(data.get("price")))
            if p < 0:
                raise InvalidOperation()
            s.price = p
        except (InvalidOperation, ValueError, TypeError):
            return Response({"error": "price must be a non-negative number"}, status=400)

    s.save()
    return Response(_serialize_service(s), status=200)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def my_services(request):
    """
    GET /services/mine/
    """
    qs = (
        Service.objects.filter(user=request.user)
        .select_related("user")
        .order_by("-created_at", "-id")
    )
    return Response([_serialize_service(s) for s in qs], status=200)


# ===========================
# 📅 Bookings
# ===========================
def _serialize_booking(b: Booking):
    return {
        "id": b.id,
        "service": {
            "id": b.service_id,
            "title": b.service.title,
            "price": float(b.service.price),
            "category": b.service.category,
        },
        "provider": _serialize_user(b.provider),
        "client": _serialize_user(b.client),
        "start_at": b.start_at.isoformat(),
        "end_at": b.end_at.isoformat(),
        "status": b.status,
        "price_snapshot": float(b.price_snapshot)
        if b.price_snapshot is not None
        else None,
        "currency": b.currency,
        "transaction_id": b.transaction_id,
        "notes": b.notes or "",
        "note": b.notes or "",  # alias for UI compatibility
        "created_at": b.created_at.isoformat(),
        "updated_at": b.updated_at.isoformat(),
        "cancelled_at": b.cancelled_at.isoformat() if b.cancelled_at else None,
        "completed_at": b.completed_at.isoformat() if b.completed_at else None,
        "paid_at": b.paid_at.isoformat() if b.paid_at else None,
    }


def _provider_has_conflict(provider_id: int, start_at, end_at, exclude_id=None):
    qs = Booking.objects.filter(
        provider_id=provider_id,
        status__in=[Booking.Status.CONFIRMED, Booking.Status.PENDING],
    )
    if exclude_id:
        qs = qs.exclude(id=exclude_id)
    return qs.filter(start_at__lt=end_at, end_at__gt=start_at).exists()


@api_view(["POST", "GET"])
@permission_classes([IsAuthenticated])
def bookings_list_create(request):
    """
    POST /bookings/
      { service_id, start_at, end_at, note?/notes? }
    GET /bookings/?role=client|provider|all&status=&from=&to=&limit=&page=
    """
    if request.method == "POST":
        data = request.data or {}
        service_id = data.get("service_id")
        start_at = _tzsafe_parse(data.get("start_at"))
        end_at = _tzsafe_parse(data.get("end_at"))
        notes = (data.get("note") or data.get("notes") or "").strip()[:500]

        if not all([service_id, start_at, end_at]):
            return Response(
                {"error": "service_id, start_at, end_at are required"}, status=400
            )
        if end_at <= start_at:
            return Response({"error": "end_at must be after start_at"}, status=400)

        try:
            service = Service.objects.select_related("user").get(id=service_id)
        except Service.DoesNotExist:
            return Response({"error": "Service not found"}, status=404)

        provider = service.user
        client = request.user
        if provider.id == client.id:
            return Response(
                {"error": "You cannot book your own service"}, status=400
            )

        if _provider_has_conflict(provider.id, start_at, end_at):
            return Response(
                {"error": "Time window conflicts with an existing booking"},
                status=409,
            )

        b = Booking.objects.create(
            service=service,
            provider=provider,
            client=client,
            start_at=start_at,
            end_at=end_at,
            status=Booking.Status.PENDING,
            price_snapshot=service.price,
            currency="ESC",
            notes=notes,
        )
        return Response(_serialize_booking(b), status=201)

    # GET (list)
    role = (request.GET.get("role") or "all").lower()
    status_filter = (request.GET.get("status") or "").strip().lower()
    t_from = _tzsafe_parse(request.GET.get("from"))
    t_to = _tzsafe_parse(request.GET.get("to"))
    limit = max(1, min(int(request.GET.get("limit", 50)), 200))
    page = int(request.GET.get("page", 1))

    qs = Booking.objects.select_related("service", "provider", "client")

    if role == "client":
        qs = qs.filter(client=request.user)
    elif role == "provider":
        qs = qs.filter(provider=request.user)
    else:
        qs = qs.filter(Q(client=request.user) | Q(provider=request.user))

    if status_filter:
        qs = qs.filter(status=status_filter)

    if t_from:
        qs = qs.filter(end_at__gte=t_from)
    if t_to:
        qs = qs.filter(start_at__lte=t_to)

    qs = qs.order_by("-start_at", "-id")

    paginator = Paginator(qs, limit)
    try:
        page_obj = paginator.page(page)
    except EmptyPage:
        return Response(
            {
                "results": [],
                "next_page": None,
                "prev_page": None,
                "count": 0,
            },
            status=200,
        )

    items = [_serialize_booking(b) for b in page_obj.object_list]
    return Response(
        {
            "results": items,
            "next_page": page + 1 if page_obj.has_next() else None,
            "prev_page": page - 1 if page_obj.has_previous() else None,
            "count": paginator.count,
        },
        status=200,
    )


def _mutate_booking(me: User, b: Booking, action: str, new_notes: str):
    now = timezone.now()

    if new_notes:
        b.notes = (
            new_notes if not b.notes else (b.notes + "\n" + new_notes)
        )[:2000]

    action = (action or "").lower().strip()
    if action == "confirm":
        if me.id != b.provider_id:
            return {"error": "Only provider can confirm"}, 403
        if b.status != Booking.Status.PENDING:
            return {"error": f"Cannot confirm from status {b.status}"}, 400
        if _provider_has_conflict(
            b.provider_id, b.start_at, b.end_at, exclude_id=b.id
        ):
            return {
                "error": "Time window conflicts with another booking"
            }, 409
        b.mark_confirmed()
        b.save()
        return _serialize_booking(b), 200

    if action == "reject":
        if me.id != b.provider_id:
            return {"error": "Only provider can reject"}, 403
        if b.status != Booking.Status.PENDING:
            return {"error": f"Cannot reject from status {b.status}"}, 400
        b.status = Booking.Status.REJECTED
        b.updated_at = now
        b.save(update_fields=["status", "updated_at", "notes"])
        return _serialize_booking(b), 200

    if action == "cancel":
        if me.id not in (b.client_id, b.provider_id):
            return {"error": "Only client or provider can cancel"}, 403
        if b.status not in [
            Booking.Status.PENDING,
            Booking.Status.CONFIRMED,
        ]:
            return {"error": f"Cannot cancel from status {b.status}"}, 400
        b.mark_cancelled()
        b.save()
        return _serialize_booking(b), 200

    if action == "complete":
        if me.id != b.provider_id:
            return {"error": "Only provider can complete"}, 403
        if b.status != Booking.Status.CONFIRMED:
            return {"error": f"Cannot complete from status {b.status}"}, 400
        b.mark_completed()
        b.save()
        return _serialize_booking(b), 200

    return {"error": "Unsupported action"}, 400


@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticated])
def bookings_detail(request, booking_id: int):
    """
    GET /bookings/<id>/
    PATCH /bookings/<id>/ { action: confirm|reject|cancel|complete, note?/notes? }
    """
    try:
        b = Booking.objects.select_related(
            "service", "provider", "client"
        ).get(id=booking_id)
    except Booking.DoesNotExist:
        return Response({"error": "Booking not found"}, status=404)

    me = request.user
    if request.method == "GET":
        if me.id not in (b.client_id, b.provider_id):
            return Response({"error": "Not allowed"}, status=403)
        return Response(_serialize_booking(b), status=200)

    data = request.data or {}
    action = (data.get("action") or "").strip().lower()
    if not action:
        return Response({"error": "action is required"}, status=400)

    new_notes = (data.get("note") or data.get("notes") or "").strip()
    payload, code = _mutate_booking(me, b, action, new_notes)
    return Response(payload, status=code)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def bookings_confirm(request, booking_id: int):
    try:
        b = Booking.objects.select_related(
            "service", "provider", "client"
        ).get(id=booking_id)
    except Booking.DoesNotExist:
        return Response({"error": "Booking not found"}, status=404)
    payload, code = _mutate_booking(
        request.user,
        b,
        "confirm",
        (request.data.get("note") or request.data.get("notes") or "").strip(),
    )
    return Response(payload, status=code)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def bookings_reject(request, booking_id: int):
    try:
        b = Booking.objects.select_related(
            "service", "provider", "client"
        ).get(id=booking_id)
    except Booking.DoesNotExist:
        return Response({"error": "Booking not found"}, status=404)
    payload, code = _mutate_booking(
        request.user,
        b,
        "reject",
        (request.data.get("note") or request.data.get("notes") or "").strip(),
    )
    return Response(payload, status=code)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def bookings_cancel(request, booking_id: int):
    try:
        b = Booking.objects.select_related(
            "service", "provider", "client"
        ).get(id=booking_id)
    except Booking.DoesNotExist:
        return Response({"error": "Booking not found"}, status=404)
    payload, code = _mutate_booking(
        request.user,
        b,
        "cancel",
        (request.data.get("note") or request.data.get("notes") or "").strip(),
    )
    return Response(payload, status=code)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def bookings_complete(request, booking_id: int):
    try:
        b = Booking.objects.select_related(
            "service", "provider", "client"
        ).get(id=booking_id)
    except Booking.DoesNotExist:
        return Response({"error": "Booking not found"}, status=404)
    payload, code = _mutate_booking(
        request.user,
        b,
        "complete",
        (request.data.get("note") or request.data.get("notes") or "").strip(),
    )
    return Response(payload, status=code)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def boot_status(request):
    u = request.user
    data = {
        "onboarding_completed": bool(getattr(u, "onboarding_completed", False)),
        "has_public_key": bool(getattr(u, "public_key", None)),
        "avatar_set": bool(getattr(u, "avatar", None)),
        "wallet_address": getattr(u, "wallet_address", None) or "",
        "id": u.id,
        "email": u.email,
    }
    return Response(data, status=200)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def users_public_keys(request):
    """
    GET /users/public_keys/?ids=1,2,3
    -> { "1":"-----BEGIN...","2":null,"3":"-----BEGIN..." }
    """
    ids_param = request.query_params.get("ids", "")
    try:
        ids = [int(x) for x in ids_param.split(",") if x.strip().isdigit()]
    except Exception:
        ids = []

    if not ids:
        return Response({})

    rows = User.objects.filter(id__in=ids).values("id", "public_key")
    out = {str(r["id"]): r["public_key"] for r in rows}
    return Response(out, status=200)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def user_public_key(request, user_id: int):
    """
    GET /users/<id>/public_key/ -> { id, public_key }
    """
    try:
        u = User.objects.only("id", "public_key").get(id=user_id)
    except User.DoesNotExist:
        return Response({"error": "User not found"}, status=404)
    return Response(
        {"id": u.id, "public_key": getattr(u, "public_key", None)}, status=200
    )


# ===========================
# 📊 ESC ECONOMY STATS (snapshot-aware)
# ===========================
def _snap_val(snap, names, default):
    """
    Helper: read a field from EscEconomySnapshot, coerce to Decimal.
    names can be a string or list of strings.
    """
    if not snap:
        return default
    if isinstance(names, str):
        names = [names]
    for n in names:
        if hasattr(snap, n):
            v = getattr(snap, n)
            if v is None:
                continue
            if isinstance(v, Decimal):
                return v
            try:
                return Decimal(str(v))
            except Exception:
                return default
    return default


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def esc_stats(request):
    """
    GET /esc/stats/

    Returns aggregate token + neighborhood metrics for the HomeScreen dashboard.

    IMPORTANT:
    - If an EscEconomySnapshot exists, we use its numbers for price, supply,
      circulating, burned, market cap, etc.
    - If no snapshot exists yet, we fall back to sane defaults + live DB stats.
    """
    try:
        now = timezone.now()

        # optional ?days= hist window (for price_history length)
        try:
            days_param = int(request.query_params.get("days", 7))
        except (TypeError, ValueError):
            days_param = 7
        history_days = max(3, min(days_param, 90))

        # latest snapshot from your sim
        snap = EscEconomySnapshot.objects.order_by("-window_end", "-id").first()
        if snap:
            print(f"📈 esc_stats using EscEconomySnapshot id={snap.id}")
        else:
            print("📈 esc_stats: no snapshot found, using fallback config/live data")

        # --- base config defaults (overridden by snapshot where possible) ---
        cfg_total_supply = Decimal(str(getattr(settings, "ESC_TOTAL_SUPPLY", "1000000")))
        cfg_price_usd = Decimal(str(getattr(settings, "ESC_PRICE_USD", "0.10")))
        cfg_burned = Decimal(str(getattr(settings, "ESC_BURNED_SUPPLY", "0")))
        cfg_founder_reserve = Decimal(
            str(getattr(settings, "ESC_FOUNDER_RESERVE_ESC", "400000"))
        )
        cfg_treasury_reserve = Decimal(
            str(getattr(settings, "ESC_TREASURY_RESERVE_ESC", "400000"))
        )
        starter_accounts = int(getattr(settings, "ESC_STARTER_ACCOUNTS", 100))
        starter_per_account = int(getattr(settings, "ESC_STARTER_PER_ACCOUNT", 100))
        starter_allocation_esc = Decimal(starter_accounts * starter_per_account)

        # --- supply / price pulled from snapshot when present ---
        total_supply = _snap_val(
            snap,
            ["effective_total_supply", "total_supply", "total_supply_esc"],
            cfg_total_supply,
        )

        price_usd = _snap_val(
            snap,
            ["final_price_usd", "final_price", "price_usd"],
            cfg_price_usd,
        )

        burned_supply = _snap_val(
            snap,
            ["burned_total", "burned_supply"],
            cfg_burned,
        )

        # circulating from snapshot if present, otherwise from live user balances
        user_qs = User.objects.all()
        live_circulating = user_qs.aggregate(total=Sum("esc_balance"))["total"] or Decimal("0")

        circulating_supply = _snap_val(
            snap,
            ["circulating_ex_treasury", "circulating_supply"],
            live_circulating,
        )

        holders_snapshot = getattr(snap, "holders", None) if snap else None
        if holders_snapshot is not None:
            holders = int(holders_snapshot)
        else:
            holders = user_qs.filter(esc_balance__gt=0).count()

        # --- 24h TX stats from Transaction table (still live) ---
        since = now - timedelta(days=1)
        tx_qs = Transaction.objects.filter(created_at__gte=since)
        tx_24h = tx_qs.count()
        volume_24h_esc = tx_qs.aggregate(total=Sum("amount"))["total"] or Decimal("0")
        volume_24h_usd = volume_24h_esc * price_usd

        # --- LP / pool metrics ---
        lp_locked_usd = _snap_val(
            snap,
            ["lp_locked_usd"],
            Decimal(str(getattr(settings, "ESC_LP_LOCKED_USD", "2500"))),
        )
        lp_tokens = int(
            _snap_val(
                snap,
                ["lp_tokens"],
                Decimal(str(getattr(settings, "ESC_LP_TOKENS", "500"))),
            )
        )

        # Approx 50/50 split to show ESC/USDC composition
        lp_usdc = lp_locked_usd / Decimal("2") if lp_locked_usd > 0 else Decimal("0")
        lp_esc = lp_usdc / price_usd if price_usd > 0 else Decimal("0")

        # --- reserves / undistributed ---
        founder_reserve_esc = _snap_val(
            snap,
            ["founder_reserve_esc", "founder_reserve"],
            cfg_founder_reserve,
        )
        treasury_reserve_esc = _snap_val(
            snap,
            ["treasury_reserve_esc", "treasury_reserve"],
            cfg_treasury_reserve,
        )

        circ_plus_res = (
            circulating_supply
            + burned_supply
            + founder_reserve_esc
            + treasury_reserve_esc
        )
        undistributed_supply = max(total_supply - circ_plus_res, Decimal("0"))

        # minted = everything not undistributed
        minted_esc = total_supply - undistributed_supply
        minted_usd = minted_esc * price_usd if minted_esc > 0 else Decimal("0")

        # --- market cap ---
        market_cap_usd = price_usd * circulating_supply if circulating_supply > 0 else Decimal("0")

        # --- price history ---
        snap_series = None
        if snap and hasattr(snap, "price_series"):
            snap_series = getattr(snap, "price_series")

        settings_history = getattr(settings, "ESC_PRICE_HISTORY", None)

        price_history = None
        if snap_series:
            if isinstance(snap_series, (list, tuple)):
                price_history = [float(x) for x in snap_series]
            else:
                try:
                    import json

                    arr = json.loads(snap_series)
                    if isinstance(arr, (list, tuple)):
                        price_history = [float(x) for x in arr]
                except Exception:
                    price_history = None

        if price_history is None and settings_history and isinstance(settings_history, (list, tuple)):
            price_history = [float(x) for x in settings_history]

        if price_history is None:
            # generate a simple ramp from ~30% of current price up to current price
            if history_days < 2:
                history_days = 2
            start_price = float(price_usd) * 0.3
            end_price = float(price_usd)
            step = (end_price - start_price) / (history_days - 1)
            price_history = [
                round(start_price + step * i, 5) for i in range(history_days)
            ]
        else:
            history_days = len(price_history)

        # labels like -6d ... Now
        price_labels = []
        for i in range(history_days):
            if i == history_days - 1:
                price_labels.append("Now")
            else:
                days_ago = history_days - 1 - i
                price_labels.append(f"-{days_ago}d")

        payload = {
            # core supply & price
            "total_supply": float(total_supply),
            "circulating_supply": float(circulating_supply),
            "burned_supply": float(burned_supply),
            "burned_esc": float(burned_supply),
            "holders": holders,
            "price_usd": float(price_usd),
            "price_usdc": float(price_usd),  # sim assumes 1:1 with USDC

            # market / activity
            "market_cap_usd": float(market_cap_usd),
            "tx_24h": tx_24h,
            "volume_24h_esc": float(volume_24h_esc),
            "volume_24h_usd": float(volume_24h_usd),

            # LP
            "lp_locked_usd": float(lp_locked_usd),
            "lp_tokens": lp_tokens,
            "lp_esc": float(lp_esc),
            "lp_usdc": float(lp_usdc),

            # starter pool
            "starter_accounts": starter_accounts,
            "starter_per_account": starter_per_account,
            "starter_allocation_esc": float(starter_allocation_esc),

            # reserves / undistributed
            "founder_reserve_esc": float(founder_reserve_esc),
            "treasury_reserve_esc": float(treasury_reserve_esc),
            "undistributed_supply": float(undistributed_supply),

            # minted
            "minted_esc": float(minted_esc),
            "minted_usd": float(minted_usd),

            # history
            "price_history": price_history,
            "price_labels": price_labels,
            "history_days": history_days,
        }

        return Response(payload, status=200)
    except Exception as e:
        print("❌ esc_stats error:", e)
        # Frontend will fall back to client-side sim if this fails
        return Response({"error": str(e)}, status=500)
