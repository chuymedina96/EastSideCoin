# views.py
from django.utils.dateparse import parse_datetime
from django.core.paginator import Paginator, EmptyPage
from django.db.models import Q
from django.utils import timezone

from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework import status

from django.contrib.auth.hashers import make_password, check_password
from django.contrib.auth import get_user_model

from .models import ChatMessage  # adjust import if needed

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
    Return fields expected by the mobile client.
    - Always include both `encrypted_key` (receiver) and `encrypted_key_sender` (sender) for compatibility.
    - The client will pick the right one based on who they are in each row.
    """
    return {
        "id": str(m.id),
        "sender": m.sender_id,
        "receiver": m.receiver_id,
        "encrypted_message": m.encrypted_message,
        "iv": m.iv,
        "mac": m.mac,
        # map model fields to the names the app expects
        "encrypted_key": m.encrypted_key_for_receiver,
        "encrypted_key_sender": m.encrypted_key_for_sender,
        "timestamp": m.timestamp.isoformat(),
        "is_read": m.is_read,
    }


# ✅ Register User
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

        hashed_password = make_password(password)
        user = User.objects.create(
            first_name=first_name,
            last_name=last_name,
            email=email,
            password=hashed_password,
            wallet_address=wallet_address,
            public_key=None,  # set later by /generate_keys
        )

        print(f"✅ User Registered: {user.id} {user.email}")
        return Response(
            {"message": "User registered successfully", "requires_key_setup": True},
            status=status.HTTP_201_CREATED,
        )
    except Exception as e:
        print(f"❌ ERROR Registering User: {e}")
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ✅ Store user's public key (client generates keys)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def generate_keys(request):
    user = request.user
    received_public_key = request.data.get("public_key")

    if user.public_key:
        return Response({"message": "Keys already generated"}, status=status.HTTP_400_BAD_REQUEST)

    if not received_public_key or not received_public_key.strip().startswith("-----BEGIN PUBLIC KEY-----"):
        print("❌ Invalid or missing public key format.")
        return Response({"error": "Invalid public key format."}, status=status.HTTP_400_BAD_REQUEST)

    try:
        user.public_key = received_public_key.strip()
        user.save(update_fields=["public_key"])
        print(f"✅ Public key stored for {user.email}")
        return Response({"message": "Keys stored successfully"}, status=status.HTTP_200_OK)
    except Exception as e:
        print(f"❌ ERROR Storing Keys: {e}")
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ✅ Login User
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
                "user": _serialize_user(user)
                | {"wallet_address": user.wallet_address, "public_key": user.public_key},
            },
            status=status.HTTP_200_OK,
        )
    except Exception as e:
        print(f"❌ CRITICAL ERROR in login: {e}")
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ✅ Logout User
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


# ✅ Search Users
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def search_users(request):
    query = (request.GET.get("query") or "").strip().lower()
    print(f"🚀 Searching Users: '{query}'")
    if not query:
        return Response([], status=status.HTTP_200_OK)

    users = (
        User.objects.filter(
            Q(first_name__icontains=query)
            | Q(last_name__icontains=query)
            | Q(email__icontains=query)
        )
        .exclude(id=request.user.id)
        .only("id", "first_name", "last_name", "email")
    )

    results = [_serialize_user(u) for u in users]
    return Response(results, status=status.HTTP_200_OK)


# ✅ Retrieve Messages (inbox-style for the authenticated receiver)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def get_messages(request):
    print("🚀 Get Messages API Hit!")
    try:
        messages = ChatMessage.objects.filter(receiver=request.user).order_by("-timestamp")
        results = [_serialize_message_for_requester(m, request.user.id) for m in messages]
        return Response(results, status=status.HTTP_200_OK)
    except Exception as e:
        print("❌ get_messages error:", e)
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ✅ Conversation fetch (both directions, paginated, optional before/after ISO-8601)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def get_conversation(request, other_id: int):
    """
    GET /api/conversations/<other_id>/?limit=50&page=1&before=...&after=...
    Returns encrypted messages BETWEEN the authed user and other_id.
    Sorted ASC (oldest -> newest) for UI-friendly rendering.
    """
    print(f"🚀 Get Conversation API Hit: other_id={other_id}")
    try:
        try:
            other = User.objects.get(id=other_id)
        except User.DoesNotExist:
            return Response({"error": "User not found."}, status=status.HTTP_404_NOT_FOUND)

        limit = max(1, min(int(request.GET.get("limit", 50)), 200))
        page = int(request.GET.get("page", 1))
        before = request.GET.get("before")
        after = request.GET.get("after")

        qs = ChatMessage.objects.filter(
            Q(sender=request.user, receiver=other) |
            Q(sender=other, receiver=request.user)
        )

        if after:
            dt = parse_datetime(after)
            if dt:
                qs = qs.filter(timestamp__gt=dt)
        if before:
            dt = parse_datetime(before)
            if dt:
                qs = qs.filter(timestamp__lt=dt)

        qs = qs.order_by("timestamp")  # ASC for UI

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


# ✅ Mark Message as Read (single)
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


# ✅ Mark Messages as Read (batch)
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
        updated = ChatMessage.objects.filter(id__in=ids, receiver=request.user, is_read=False).update(is_read=True)
        return Response({"updated": updated}, status=status.HTTP_200_OK)
    except Exception as e:
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ✅ Send Encrypted Chat Message (client-side E2EE bundle)
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
      "encrypted_key": "<b64>",          # RSA-OAEP(key) for receiver  (required)
      "encrypted_key_sender": "<b64>"    # RSA-OAEP(key) for sender    (optional but recommended)
    }
    """
    print("🚀 Send Message API Hit!")
    try:
        data = request.data
        receiver_id = data.get("receiver_id")
        enc_msg = data.get("encrypted_message")
        iv = data.get("iv")
        mac = data.get("mac")
        enc_key_recv = data.get("encrypted_key")  # receiver wrap
        enc_key_sender = data.get("encrypted_key_sender")  # sender wrap (optional)

        if not all([receiver_id, enc_msg, iv, mac, enc_key_recv]):
            return Response(
                {"error": "receiver_id, encrypted_message, iv, mac, encrypted_key are required"},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            receiver = User.objects.get(id=receiver_id)
        except User.DoesNotExist:
            return Response({"error": "Receiver not found"}, status=status.HTTP_404_NOT_FOUND)

        chat_message = ChatMessage.objects.create(
            sender=request.user,
            receiver=receiver,
            encrypted_message=enc_msg,
            iv=iv,
            mac=mac,
            encrypted_key_for_receiver=enc_key_recv,
            encrypted_key_for_sender=enc_key_sender,  # may be None
            timestamp=timezone.now(),  # explicit for safety
        )

        print(f"✅ Message stored: {chat_message.id}")
        return Response({"message": "Message stored", "message_id": str(chat_message.id)}, status=status.HTTP_201_CREATED)
    except Exception as e:
        print(f"❌ ERROR Sending Message: {e}")
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ✅ Check Wallet Balance
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


# ✅ Public key getter (for encrypting to a recipient)
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
