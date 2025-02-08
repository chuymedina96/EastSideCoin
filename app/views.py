from rest_framework.decorators import api_view
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken, AccessToken
from django.contrib.auth import get_user_model
from django.contrib.auth.models import update_last_login
from django.contrib.auth.hashers import make_password
from django.contrib.auth import authenticate
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
        # ✅ Attempt to create the user
        user = User.objects.create_user(
            first_name=first_name,
            last_name=last_name,
            email=email,
            password=password,
            wallet_address=wallet_address
        )
        user.save()

        print("✅ User Created Successfully:", user.email)

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
    email = request.data.get("email")
    password = request.data.get("password")

    if not email or not password:
        return Response({"error": "Email and password are required"}, status=400)

    user = authenticate(username=email, password=password)

    if user is None:
        return Response({"error": "Invalid credentials"}, status=401)

    refresh = RefreshToken.for_user(user)
    access = str(refresh.access_token)

    update_last_login(None, user)

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
    })


@api_view(["POST"])
def logout_user(request):
    try:
        token = request.data.get("token")
        if not token:
            return Response({"error": "Token required"}, status=400)

        # Try blacklisting as Refresh Token
        try:
            refresh_token = RefreshToken(token)
            refresh_token.blacklist()
            return Response({"message": "Logout successful"}, status=200)
        except:
            pass  # If it's not a refresh token, continue

        # If it's an access token, we just delete it from frontend storage
        try:
            access_token = AccessToken(token)  # Validate if it's an access token
            return Response({"message": "Access token removed from frontend. No server blacklist needed."}, status=200)
        except:
            return Response({"error": "Invalid token"}, status=400)

    except Exception as e:
        return Response({"error": str(e)}, status=500)



# ✅ Check User ESC Balance (Synchronous)
@api_view(['GET'])
def check_balance(request, wallet_address):
    try:
        user = User.objects.get(wallet_address=wallet_address)
        return Response({'wallet': wallet_address, 'balance': user.esc_balance})
    except User.DoesNotExist:
        return Response({'error': 'Wallet not found'}, status=404)
