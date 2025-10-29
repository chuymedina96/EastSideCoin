# views.py
from django.utils.dateparse import parse_datetime
from django.core.paginator import Paginator, EmptyPage
from django.db.models import Q, Max, Count
from django.utils import timezone

from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework import status

from django.contrib.auth.hashers import make_password, check_password
from django.contrib.auth import get_user_model

from .models import ChatMessage  # adjust if needed

User = get_user_model()


# ---------------------------
# Utilities
# ---------------------------
def _serialize_user(u: User):
    return {
        "id": u.id,
        "email": u.email,
        "first_name": u.first_name,
        "last_name": u.last_name,
    }


def _serialize_message_for_requester(m: ChatMessage, requester_id: int):
    """
    Mobile client expects these fields. Expose both REST names and WS-style aliases
    so the app can hydrate regardless of naming differences.

    REST canonical:
      - encrypted_key          -> receiver wrap (RSA-OAEP key for recipient)
      - encrypted_key_sender   -> sender wrap   (RSA-OAEP key for sender)

    WS aliases also included:
      - encrypted_key_for_receiver
      - encrypted_key_for_sender
    """
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
# Auth / Keys
# ===========================
@api_view(["POST"])
@permission_classes([AllowAny])
def register_user(request):
    print("🚀 Register API Hit!")
    try:
        data = request.data
        first_name = data.get("first_name")
        last_name = data.get("last_name")
        email = data.get("email")
        password = data.get("password")
        wallet_address = data.get("wallet_address")

        if not all([first_name, last_name, email, password, wallet_address]):
            return Response({"error": "All fields are required"}, status=status.HTTP_400_BAD_REQUEST)

        if User.objects.filter(email=email).exists():
            return Response({"error": "Email is already in use"}, status=status.HTTP_400_BAD_REQUEST)

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
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def generate_keys(request):
    user = request.user
    received_public_key = (request.data.get("public_key") or "").strip()

    if user.public_key:
        return Response({"message": "Keys already generated"}, status=status.HTTP_400_BAD_REQUEST)

    if not received_public_key.startswith("-----BEGIN PUBLIC KEY-----"):
        print("❌ Invalid or missing public key format.")
        return Response({"error": "Invalid public key format."}, status=status.HTTP_400_BAD_REQUEST)

    try:
        user.public_key = received_public_key
        user.save(update_fields=["public_key"])
        print(f"✅ Public key stored for {user.email}")
        return Response({"message": "Keys stored successfully"}, status=status.HTTP_200_OK)
    except Exception as e:
        print(f"❌ ERROR Storing Keys: {e}")
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(["POST"])
@permission_classes([AllowAny])
def login_user(request):
    print("🚀 Login API Hit!")
    try:
        email = request.data.get("email")
        password = request.data.get("password")

        if not email or not password:
            return Response({"error": "Email and password are required"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            user = User.objects.get(email=email)
        except User.DoesNotExist:
            print("❌ Invalid credentials (email)")
            return Response({"error": "Invalid credentials"}, status=status.HTTP_401_UNAUTHORIZED)

        if not check_password(password, user.password):
            print("❌ Invalid credentials (password)")
            return Response({"error": "Invalid credentials"}, status=status.HTTP_401_UNAUTHORIZED)

        refresh = RefreshToken.for_user(user)
        access = str(refresh.access_token)

        print(f"✅ Login Successful for {user.email}")
        return Response(
            {
                "access": access,
                "refresh": str(refresh),
                "user": {
                    **_serialize_user(user),
                    "wallet_address": user.wallet_address,
                    "public_key": user.public_key,
                },
            },
            status=status.HTTP_200_OK,
        )
    except Exception as e:
        print(f"❌ CRITICAL ERROR in login: {e}")
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def logout_user(request):
    try:
        print("🚀 Logout API Hit!")
        refresh_token = request.data.get("token")
        if not refresh_token:
            return Response({"error": "Refresh token required"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            refresh = RefreshToken(refresh_token)
            refresh.blacklist()
            print("✅ Logout successful; refresh token blacklisted.")
            return Response({"message": "Logout successful, token blacklisted."}, status=status.HTTP_200_OK)
        except Exception as e:
            print(f"❌ Invalid refresh token: {e}")
            return Response({"error": "Invalid token"}, status=status.HTTP_400_BAD_REQUEST)
    except Exception as e:
        print(f"❌ CRITICAL ERROR in logout: {e}")
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(["DELETE"])
@permission_classes([IsAuthenticated])
def delete_account(request):
    """
    DELETE /api/delete_account/
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

        # Delete all messages involving the user
        ChatMessage.objects.filter(Q(sender=user) | Q(receiver=user)).delete()
        user.delete()

        return Response(status=status.HTTP_204_NO_CONTENT)
    except Exception as e:
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ===========================
# Users / Search
# ===========================
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def search_users(request):
    query = (request.GET.get("query") or "").strip().lower()
    print(f"🚀 Searching Users: '{query}'")
    if not query:
        return Response([], status=status.HTTP_200_OK)

    users = (
        User.objects.filter(
            Q(first_name__icontains=query) |
            Q(last_name__icontains=query) |
            Q(email__icontains=query)
        )
        .exclude(id=request.user.id)
        .only("id", "first_name", "last_name", "email")
    )
    return Response([_serialize_user(u) for u in users], status=status.HTTP_200_OK)


# ===========================
# Threads (Server-backed)
# ===========================
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def conversations_index(request):
    """
    GET /api/conversations/index/
    Returns the canonical list of conversation partners for the authed user,
    with latest message timestamp and unread count (server-owned).
    """
    me = request.user
    try:
        # All messages where I'm involved
        base = ChatMessage.objects.filter(Q(sender=me) | Q(receiver=me))

        # Latest timestamp per partner (me, other)
        # Build a dict: partner_id -> latest_ts
        latest_rows = base.values("sender_id", "receiver_id").annotate(last_ts=Max("timestamp"))

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

        # Unread counts per partner = messages sent *to me* and not read
        unread_qs = ChatMessage.objects.filter(receiver=me, is_read=False, sender_id__in=partner_ids) \
            .values("sender_id").annotate(unread=Count("id"))
        unread_map = {row["sender_id"]: row["unread"] for row in unread_qs}

        # Load partners
        partners = User.objects.filter(id__in=partner_ids).only("id", "first_name", "last_name", "email")

        # Build response items
        items = []
        for u in partners:
            items.append({
                "id": u.id,
                "first_name": u.first_name,
                "last_name": u.last_name,
                "email": u.email,
                "updatedAt": (partner_latest.get(u.id) or timezone.now()).isoformat(),
                "unread": unread_map.get(u.id, 0),
                "lastText": "",  # keep empty; client can fill after first decrypt page
            })

        # Sort newest first
        items.sort(key=lambda x: x["updatedAt"], reverse=True)
        return Response(items, status=status.HTTP_200_OK)
    except Exception as e:
        print("❌ conversations_index error:", e)
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mark_thread_read(request, other_id: int):
    """
    POST /api/conversations/mark_read/<other_id>/
    Marks messages from other_id -> me as read.
    """
    me = request.user
    try:
        updated = ChatMessage.objects.filter(
            sender_id=other_id,
            receiver=me,
            is_read=False
        ).update(is_read=True)
        return Response({"updated": updated}, status=status.HTTP_200_OK)
    except Exception as e:
        print("❌ mark_thread_read error:", e)
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ===========================
# Messages / Conversations
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
        messages = ChatMessage.objects.filter(receiver=request.user).order_by("-timestamp", "-id")
        results = [_serialize_message_for_requester(m, request.user.id) for m in messages]
        return Response(results, status=status.HTTP_200_OK)
    except Exception as e:
        print("❌ get_messages error:", e)
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def my_threads(request):
    """
    (Legacy) Returns a list of peers with latest timestamp and a ciphertext preview.
    Kept for backward compatibility; prefer conversations_index.
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

        peers = User.objects.filter(id__in=list(latest_by_peer.keys())).only("id", "first_name", "last_name", "email")

        items = []
        for u in peers:
            meta = latest_by_peer.get(u.id)
            items.append({
                "peer": _serialize_user(u),
                "latest_timestamp": meta["timestamp"].isoformat() if meta["timestamp"] else None,
                "latest_encrypted_message": meta["encrypted_message"],
            })

        items.sort(key=lambda x: x["latest_timestamp"] or "", reverse=True)
        return Response(items, status=status.HTTP_200_OK)
    except Exception as e:
        print("❌ my_threads error:", e)
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def get_conversation(request, other_id: int):
    """
    GET /api/conversations/<other_id>/?limit=50&page=1&before=...&after=...
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
            Q(sender=request.user, receiver=other) |
            Q(sender=other, receiver=request.user)
        )
        if after:
            qs = qs.filter(timestamp__gt=after)
        if before:
            qs = qs.filter(timestamp__lt=before)

        qs = qs.order_by("timestamp", "id")  # ASC for UI; id tiebreaker for null/dupes

        paginator = Paginator(qs, limit)
        try:
            page_obj = paginator.page(page)
        except EmptyPage:
            return Response({
                "results": [],
                "next_page": None,
                "prev_page": None,
                "count": paginator.count,
            }, status=status.HTTP_200_OK)

        items = [_serialize_message_for_requester(m, request.user.id) for m in page_obj.object_list]
        next_page = page + 1 if page_obj.has_next() else None
        prev_page = page - 1 if page_obj.has_previous() else None

        return Response({
                "results": items,
                "next_page": next_page,
                "prev_page": prev_page,
                "count": paginator.count,
            }, status=status.HTTP_200_OK)
    except Exception as e:
        print("❌ get_conversation error:", e)
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mark_message_read(request):
    print("🚀 Mark Message Read API Hit!")
    message_id = request.data.get("message_id")
    if not message_id:
        return Response({"error": "Message ID is required"}, status=status.HTTP_400_BAD_REQUEST)

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
        return Response({"error": "ids must be a non-empty list"}, status=status.HTTP_400_BAD_REQUEST)
    try:
        updated = ChatMessage.objects.filter(
            id__in=ids,
            receiver=request.user,
            is_read=False
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
      # either naming is accepted:
      "encrypted_key" or "encrypted_key_for_receiver": "<b64>",  # required
      "encrypted_key_sender" or "encrypted_key_for_sender": "<b64>"  # optional
    }
    """
    print("🚀 Send Message API Hit!")
    try:
        data = request.data
        # Debug payload shape (keys only)
        try:
            print("📥 send_message keys:", list(data.keys()))
        except Exception:
            pass

        receiver_id = data.get("receiver_id")
        enc_msg = data.get("encrypted_message")
        iv = data.get("iv")
        mac = data.get("mac")

        # Accept both REST and WS aliases for wraps
        enc_key_recv = data.get("encrypted_key") or data.get("encrypted_key_for_receiver")
        enc_key_sender = data.get("encrypted_key_sender") or data.get("encrypted_key_for_sender")

        if not all([receiver_id, enc_msg, iv, mac, enc_key_recv]):
            return Response(
                {"error": "receiver_id, encrypted_message, iv, mac, and encrypted_key (receiver) are required"},
                status=status.HTTP_400_BAD_REQUEST
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

        # Echo canonical payload (with aliases too) for immediate client merge
        payload = _serialize_message_for_requester(msg, request.user.id)
        return Response(payload, status=status.HTTP_201_CREATED)
    except Exception as e:
        print(f"❌ ERROR Sending Message: {e}")
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ===========================
# Wallet / Keys
# ===========================
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def check_balance(request, wallet_address):
    try:
        print(f"🚀 Checking wallet balance for: {wallet_address}")
        user = User.objects.filter(wallet_address=wallet_address).first()
        if not user:
            return Response({"error": "Wallet not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response({"wallet": wallet_address, "balance": user.esc_balance}, status=status.HTTP_200_OK)
    except Exception as e:
        print(f"❌ ERROR Fetching Balance: {e}")
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def get_user_public_key(request, user_id):
    try:
        user = User.objects.get(id=user_id)
        if not user.public_key:
            return Response({"error": "Public key not available."}, status=status.HTTP_404_NOT_FOUND)
        return Response({"public_key": user.public_key}, status=status.HTTP_200_OK)
    except User.DoesNotExist:
        return Response({"error": "User not found."}, status=status.HTTP_404_NOT_FOUND)
