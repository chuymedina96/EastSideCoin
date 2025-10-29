from django.urls import path
from .views import (
    # 🔐 Auth / Keys
    register_user,
    login_user,
    logout_user,
    generate_keys,
    delete_account,

    # 👥 Users
    search_users,
    get_user_public_key,

    # 💬 Chat / Messaging
    send_message,
    get_messages,
    get_conversation,
    mark_message_read,
    mark_messages_read_batch,
    conversations_index,
    mark_thread_read,

    # 💰 Wallet
    check_balance,
)

urlpatterns = [
    # ===========================
    # 🔐 Auth
    # ===========================
    path("register/", register_user, name="register_user"),
    path("login/", login_user, name="login_user"),
    path("logout/", logout_user, name="logout_user"),
    path("generate_keys/", generate_keys, name="generate_keys"),
    path("delete_account/", delete_account, name="delete_account"),

    # ===========================
    # 👥 Users
    # ===========================
    path("users/search/", search_users, name="search_users"),
    path("users/<int:user_id>/public_key/", get_user_public_key, name="get_user_public_key"),

    # ===========================
    # 💬 Conversations / Threads
    # ===========================
    path("conversations/index/", conversations_index, name="conversations_index"),
    path("conversations/mark_read/<int:other_id>/", mark_thread_read, name="mark_thread_read"),
    path("conversations/<int:other_id>/", get_conversation, name="get_conversation"),

    # ===========================
    # 💌 Messages
    # ===========================
    path("messages/send/", send_message, name="send_message"),
    path("messages/", get_messages, name="get_messages"),
    path("messages/read/", mark_message_read, name="mark_message_read"),
    path("messages/read_batch/", mark_messages_read_batch, name="mark_messages_read_batch"),

    # ===========================
    # 💰 Wallet
    # ===========================
    path("wallet/<str:wallet_address>/balance/", check_balance, name="check_balance"),
]
