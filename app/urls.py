from django.urls import path
from .views import (
    register_user,
    login_user,
    logout_user,
    generate_keys,  # ✅ Added missing key generation endpoint
    search_users,
    send_message,
    get_messages,
    mark_message_read,
    check_balance,
    get_user_public_key,
    get_conversation
)

urlpatterns = [
    path("register/", register_user, name="register"),  # ✅ Register new users
    path("login/", login_user, name="login"),  # ✅ User login
    path("logout/", logout_user, name="logout"),  # ✅ User logout
    path("generate_keys/", generate_keys, name="generate_keys"),  # ✅ NEW: Key Generation Endpoint
    path("users/search/", search_users, name="search_users"),  # ✅ Search users by name/email
    path("users/<int:user_id>/public_key/", get_user_public_key), # ✅ Get public key of a user
    
    # ✅ Messages (Grouped URLs)
    path("messages/send/", send_message, name="send_message"),  # ✅ Send encrypted messages
    path("messages/", get_messages, name="get_messages"),  # ✅ Retrieve encrypted messages
    path("messages/read/", mark_message_read, name="mark_message_read"),  # ✅ Mark messages as read

    # ✅ Wallet (Consistent URL Pattern)
    path("wallet/<str:wallet_address>/balance/", check_balance, name="check_balance"),  # ✅ Check ESC balance
    path("conversations/<int:other_id>/", get_conversation, name="get_conversation")
]
