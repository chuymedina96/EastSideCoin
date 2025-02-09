from rest_framework.decorators import api_view
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken, AccessToken
from django.contrib.auth import get_user_model
from django.contrib.auth.models import update_last_login
from django.contrib.auth.hashers import make_password
from django.contrib.auth import authenticate, get_user_model
from django.db import transaction
from rest_framework_simplejwt.tokens import OutstandingToken, BlacklistedToken
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken
import json

User = get_user_model()

# ✅ User Registration (Synchronous)
# ✅ Register User with Logging
@api_view(["POST"])
def register_user(request):
    print("🚀 Register API Hit!")
    print("📡 Raw Request Data:", request.body.decode('utf-8'))
    print("📡 Received Data (Parsed):", json.dumps(request.data, indent=2))

    first_name = request.data.get("first_name")
    last_name = request.data.get("last_name")
    email = request.data.get("email")
    password = request.data.get("password")
    wallet_address = request.data.get("wallet_address")

    if not all([first_name, last_name, email, password, wallet_address]):
        print("❌ ERROR: Missing Fields")
        return Response({"error": "All fields are required"}, status=400)

    print("✅ First Name:", first_name)
    print("✅ Last Name:", last_name)
    print("✅ Email:", email)
    print("✅ Wallet Address:", wallet_address)

    # ✅ Check if email already exists
    if User.objects.filter(email=email).exists():
        print("❌ ERROR: Email already in use")
        return Response({"error": "Email is already in use"}, status=400)

    try:
        # ✅ Create user and ensure password is set correctly
        user = User(
            first_name=first_name,
            last_name=last_name,
            email=email,
            wallet_address=wallet_address,
        )
        user.set_password(password)  # ✅ Properly hash the password
        user.save()

        print("✅ User Created Successfully:", user.email)

        # ✅ Authenticate the user immediately
        authenticated_user = authenticate(username=email, password=password)
        if authenticated_user is None:
            print("❌ ERROR: Auto-login failed due to authentication issue")
            return Response({"error": "Authentication failed after registration"}, status=500)

        # ✅ Generate JWT tokens
        refresh = RefreshToken.for_user(user)
        access = str(refresh.access_token)

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
        }, status=201)

    except Exception as e:
        print("❌ ERROR: Could not create user -", str(e))
        return Response({"error": str(e)}, status=500)


# ✅ Login User with Logging
@api_view(["POST"])
def login_user(request):
    print("🚀 Login API Hit!")
    print("📡 Received Data:", request.data)

    email = request.data.get("email")
    password = request.data.get("password")

    if not email or not password:
        print("❌ ERROR: Missing email or password")
        return Response({"error": "Email and password are required"}, status=400)

    user = authenticate(username=email, password=password)

    if user is None:
        print("❌ ERROR: Invalid Credentials")
        return Response({"error": "Invalid credentials"}, status=401)

    refresh = RefreshToken.for_user(user)
    access = str(refresh.access_token)

    update_last_login(None, user)

    print("✅ Login Successful for:", email)
    print("🔑 Access Token:", access)

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
    }, status=200)


    



@api_view(["POST"])
def logout_user(request):
    try:
        print("\n🚀 Logout API Hit!")  # ✅ Step 1: API is triggered

        token = request.data.get("token")
        if not token:
            print("❌ ERROR: No token provided in logout request.")
            return Response({"error": "Token required"}, status=400)

        # ✅ Try blacklisting as a Refresh Token
        try:
            print("🔍 Attempting to blacklist refresh token...")
            refresh_token = RefreshToken(token)
            refresh_token.blacklist()
            print("✅ SUCCESS: Refresh token blacklisted!")
            return Response({"message": "Logout successful, token blacklisted."}, status=200)
        except Exception as e:
            print(f"⚠️ WARNING: Token is NOT a refresh token. Error: {e}")

        # ✅ If it's an access token, acknowledge logout but don't blacklist
        try:
            print("🔍 Checking if token is an access token...")
            access_token = AccessToken(token)  # Validate if it's an access token
            print("✅ SUCCESS: Access token detected. No blacklist needed.")
            return Response({"message": "Access token removed from frontend. No server blacklist needed."}, status=200)
        except Exception as e:
            print(f"⚠️ WARNING: Invalid token provided. Error: {e}")
            return Response({"error": "Invalid token"}, status=400)

    except Exception as e:
        print(f"❌ CRITICAL ERROR: Server error during logout. Error: {e}")
        return Response({"error": str(e)}, status=500)



# ✅ Check User ESC Balance (Synchronous)
@api_view(['GET'])
def check_balance(request, wallet_address):
    try:
        user = User.objects.get(wallet_address=wallet_address)
        return Response({'wallet': wallet_address, 'balance': user.esc_balance})
    except User.DoesNotExist:
        return Response({'error': 'Wallet not found'}, status=404)
