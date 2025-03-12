from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken, AccessToken
from django.contrib.auth.hashers import make_password, check_password
from django.contrib.auth import get_user_model
from django.db import transaction
from rest_framework import status
from django.db.models import Q
from .models import *
from .encryption_utils import generate_rsa_keys, decryptAES, encryptAES
from cryptography.hazmat.primitives import serialization
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
            public_key=None  # ✅ Ensure this exists for key setup later
        )

        # ✅ Print the user object
        print(f"✅ User Registered: {user.__dict__}")

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
    received_public_key = request.data.get("public_key")

    if user.public_key:
        return Response({"message": "Keys already generated"}, status=400)

    if not received_public_key or not received_public_key.strip().startswith("-----BEGIN PUBLIC KEY-----"):
        print("❌ ERROR: Invalid or missing public key format.")
        return Response({"error": "Invalid public key format."}, status=status.HTTP_400_BAD_REQUEST)

    print(f"🔑 Storing public key for {user.email}...")

    try:
        user.public_key = received_public_key.strip()
        user.save()

        print(f"✅ Public key stored for {user.email}")

        return Response({"message": "Keys stored successfully"}, status=200)

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


# ✅ Logout User
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def logout_user(request):
    try:
        print("\n🚀 Logout API Hit!")

        auth_header = request.headers.get("Authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            print("❌ ERROR: No valid Authorization header found.")
            return Response({"error": "Authentication credentials were not provided."}, status=status.HTTP_401_UNAUTHORIZED)

        access_token = auth_header.split("Bearer ")[1]
        refresh_token = request.data.get("token")

        print(f"🔑 Extracted Access Token: {access_token}")
        print(f"🔄 Provided Refresh Token: {refresh_token}")

        if not refresh_token:
            print("❌ ERROR: No refresh token provided.")
            return Response({"error": "Refresh token required"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            refresh = RefreshToken(refresh_token)
            print(f"✅ Blacklisting Refresh Token: {refresh}")
            refresh.blacklist()
            print("✅ Logout successful, refresh token has been blacklisted.")

            return Response({"message": "Logout successful, token blacklisted."}, status=status.HTTP_200_OK)

        except Exception as e:
            print(f"❌ ERROR: Invalid token - {e}")
            return Response({"error": "Invalid token"}, status=status.HTTP_400_BAD_REQUEST)

    except Exception as e:
        print(f"❌ CRITICAL ERROR in logout: {e}")
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ✅ Search Users
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def search_users(request):
    query = request.GET.get("query", "").strip().lower()
    print(f"🚀 Searching Users: '{query}'")

    if not query:
        return Response([], status=status.HTTP_200_OK)

    users = User.objects.filter(
        Q(first_name__icontains=query) |
        Q(last_name__icontains=query) |
        Q(email__icontains=query)
    ).exclude(id=request.user.id)

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


# ✅ Retrieve Messages
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def get_messages(request):
    print("🚀 Get Messages API Hit!")

    try:
        messages = ChatMessage.objects.filter(receiver=request.user).order_by("-timestamp")

        if not messages.exists():
            print(f"⚠️ No messages found for {request.user.email}")
            return Response([], status=status.HTTP_200_OK)

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


# ✅ Mark Message as Read
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
        message.save()
        return Response({"message": "Message marked as read"}, status=status.HTTP_200_OK)

    except ChatMessage.DoesNotExist:
        return Response({"error": "Message not found"}, status=status.HTTP_404_NOT_FOUND)

    except Exception as e:
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

        try:
            receiver = User.objects.get(id=receiver_id)
        except User.DoesNotExist:
            print(f"❌ ERROR: Receiver with ID {receiver_id} not found")
            return Response({"error": "Receiver not found"}, status=status.HTTP_404_NOT_FOUND)

        encrypted_message = encryptAES(plaintext_message)

        chat_message = ChatMessage.objects.create(
            sender=request.user,
            receiver=receiver,
            encrypted_message=encrypted_message["encrypted_text"],  # ✅ Store only encrypted text
            iv=encrypted_message["iv"],  # ✅ Store IV for decryption
            key=encrypted_message["key"]  # ✅ Store Key for decryption
        )

        print(f"✅ Message Sent: ID {chat_message.id}")
        return Response({"message": "Message sent successfully", "message_id": chat_message.id}, status=status.HTTP_201_CREATED)

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
            print(f"❌ ERROR: Wallet {wallet_address} not found")
            return Response({"error": "Wallet not found"}, status=status.HTTP_404_NOT_FOUND)

        print(f"✅ Wallet Balance Check: {wallet_address} has {user.esc_balance} ESC")

        return Response({"wallet": wallet_address, "balance": user.esc_balance}, status=status.HTTP_200_OK)

    except Exception as e:
        print(f"❌ ERROR Fetching Balance: {e}")
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

