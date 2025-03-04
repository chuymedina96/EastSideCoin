from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken, AccessToken
from django.contrib.auth.hashers import make_password, check_password
from django.contrib.auth import get_user_model
from django.db import transaction
from rest_framework import status
from .models import *
from .encryption_utils import generate_rsa_keys, decryptAES, encryptAES
from cryptography.hazmat.primitives import serialization  # ✅ FIXED missing import
import json

User = get_user_model()


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
        )

        print(f"✅ User Registered: {user.email}")

        return Response({
            "message": "User registered successfully",
            "requires_key_setup": True  # ✅ Tell frontend that key setup is needed
        }, status=status.HTTP_201_CREATED)

    except Exception as e:
        print(f"❌ ERROR Registering User: {e}")
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ✅ Generate Keys
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def generate_keys(request):
    user = request.user

    if user.public_key:
        return Response({"message": "Keys already generated"}, status=400)

    print(f"🔑 Generating RSA keys for {user.email}...")

    try:
        private_key, public_key = generate_rsa_keys()

        user.public_key = public_key.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo
        ).decode()
        user.save()

        print(f"✅ Keys Generated for {user.email}")

        return Response({"message": "Keys generated successfully"}, status=200)
    
    except Exception as e:
        print(f"❌ ERROR Generating Keys: {e}")
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
            print("❌ ERROR: Invalid credentials")
            return Response({"error": "Invalid credentials"}, status=status.HTTP_401_UNAUTHORIZED)

        if not check_password(password, user.password):
            print("❌ ERROR: Password does not match")
            return Response({"error": "Invalid credentials"}, status=status.HTTP_401_UNAUTHORIZED)

        refresh = RefreshToken.for_user(user)
        access = str(refresh.access_token)

        print(f"✅ Login Successful for {user.email}")

        return Response({
            "access": access,
            "refresh": str(refresh),
            "user": {
                "id": user.id,
                "email": user.email,
                "first_name": user.first_name,
                "last_name": user.last_name,
                "wallet_address": user.wallet_address,
            }
        }, status=status.HTTP_200_OK)

    except Exception as e:
        print(f"❌ CRITICAL ERROR in login: {e}")
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ✅ Send Encrypted Chat Message
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def send_message(request):
    print("🚀 Send Message API Hit!")

    try:
        data = request.data
        receiver_id = data.get("receiver_id")
        plaintext_message = data.get("message")

        if not receiver_id or not plaintext_message:
            return Response({"error": "Receiver and message are required"}, status=status.HTTP_400_BAD_REQUEST)

        receiver = User.objects.get(id=receiver_id)
        encrypted_message = encryptAES(plaintext_message)

        chat_message = ChatMessage.objects.create(
            sender=request.user,
            receiver=receiver,
            encrypted_message=encrypted_message
        )

        print(f"✅ Message Sent: {chat_message.id}")
        return Response({"message": "Message sent successfully", "message_id": chat_message.id}, status=status.HTTP_201_CREATED)

    except User.DoesNotExist:
        return Response({"error": "Receiver not found"}, status=status.HTTP_404_NOT_FOUND)

    except Exception as e:
        print(f"❌ ERROR Sending Message: {e}")
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ✅ Logout User
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def logout_user(request):
    try:
        print("\n🚀 Logout API Hit!")

        token = request.data.get("token")
        if not token:
            return Response({"error": "Token required"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            refresh_token = RefreshToken(token)
            refresh_token.blacklist()
            return Response({"message": "Logout successful, token blacklisted."}, status=status.HTTP_200_OK)
        except Exception as e:
            return Response({"error": "Invalid token"}, status=status.HTTP_400_BAD_REQUEST)

    except Exception as e:
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ✅ Retrieve Messages
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def get_messages(request):
    print("🚀 Get Messages API Hit!")

    try:
        messages = ChatMessage.objects.filter(receiver=request.user).order_by("-timestamp")

        messages_data = [
            {
                "id": str(msg.id),
                "sender": msg.sender.email,
                "encrypted_message": msg.encrypted_message,
                "decrypted_message": decryptAES(msg.encrypted_message),
                "timestamp": msg.timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                "is_read": msg.is_read
            }
            for msg in messages
        ]

        print(f"✅ Retrieved {len(messages_data)} messages for {request.user.email}")
        return Response(messages_data, status=status.HTTP_200_OK)

    except Exception as e:
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
    
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mark_message_read(request):
    """
    ✅ Mark a chat message as read
    """
    print("🚀 Mark Message Read API Hit!")
    print("📡 Received Data:", json.dumps(request.data, indent=2))

    message_id = request.data.get("message_id")

    if not message_id:
        print("❌ ERROR: Message ID is required")
        return Response({"error": "Message ID is required"}, status=status.HTTP_400_BAD_REQUEST)

    try:
        message = ChatMessage.objects.get(id=message_id, receiver=request.user)
        message.is_read = True
        message.save()

        print(f"✅ Message Marked as Read: {message.id} by {request.user.email}")
        print(f"🔍 Updated Message Object: {message.__dict__}")

        return Response({"message": "Message marked as read"}, status=status.HTTP_200_OK)

    except ChatMessage.DoesNotExist:
        print("❌ ERROR: Message not found")
        return Response({"error": "Message not found"}, status=status.HTTP_404_NOT_FOUND)

    except Exception as e:
        print("❌ ERROR Marking Message as Read:", str(e))
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
from django.db.models import Q  # ✅ Ensure this is imported

@api_view(["GET"])
@permission_classes([IsAuthenticated])
def search_users(request):
    """
    🔍 Search for users by first name, last name, or email
    """
    query = request.GET.get("query", "").strip().lower()
    print(f"🚀 Searching Users: '{query}'")  # ✅ Log query string

    if not query:
        print("❌ ERROR: Empty query received.")
        return Response([], status=status.HTTP_200_OK)

    # ✅ Fetch users that match first name, last name, or email
    users = User.objects.filter(
        Q(first_name__icontains=query) |
        Q(last_name__icontains=query) |
        Q(email__icontains=query)
    ).exclude(id=request.user.id)  # ✅ Exclude the requesting user

    # ✅ Log fetched users
    print(f"✅ Found {users.count()} users matching '{query}'")
    
    results = [
        {
            "id": user.id,
            "first_name": user.first_name,
            "last_name": user.last_name,
            "email": user.email,
        }
        for user in users
    ]

    return Response(results, status=status.HTTP_200_OK)

# ✅ Check Wallet Balance
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def check_balance(request, wallet_address):
    try:
        user = User.objects.get(wallet_address=wallet_address)
        print(f"✅ Wallet Balance Check for {wallet_address}: {user.esc_balance} ESC")
        return Response({"wallet": wallet_address, "balance": user.esc_balance}, status=status.HTTP_200_OK)
    
    except User.DoesNotExist:
        print(f"❌ ERROR: Wallet {wallet_address} not found")
        return Response({"error": "Wallet not found"}, status=status.HTTP_404_NOT_FOUND)

    except Exception as e:
        print(f"❌ ERROR Fetching Balance: {e}")
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


