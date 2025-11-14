# app/urls.py
from django.urls import path
from .views import (
    # 🔐 Auth / Keys
    register_user,
    login_user,
    logout_user,
    generate_keys,
    delete_account,
    refresh_token_view,

    # 👥 Users
    search_users,      # ⬅️ keep search
    user_detail,       # ⬅️ NEW: per-user profile
    users_public_keys,
    user_public_key,

    # 💬 Chat / Messaging
    send_message,
    get_messages,
    get_conversation,
    mark_message_read,
    mark_messages_read_batch,
    conversations_index,
    mark_thread_read,

    # 💰 Wallet
    wallet_balance,
    check_balance,

    # 🧰 Services
    services_list_create,
    services_detail,
    my_services,
    services_categories,

    # 📅 Bookings
    bookings_list_create,
    bookings_detail,
    bookings_confirm,
    bookings_reject,
    bookings_cancel,
    bookings_complete,

    # 👤 Profile / Me
    me_detail_update,
    profile_avatar,
    boot_status,
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
    path("refresh/", refresh_token_view, name="refresh_token"),

    # ===========================
    # 👥 Users
    # ===========================
    path("search_users/", search_users, name="search_users"),
    path("users/search/", search_users, name="users_search_alias"),
    path("users/<int:user_id>/", user_detail, name="user_detail"),
    path("users/public_keys/", users_public_keys, name="users_public_keys"),
    path("users/<int:user_id>/public_key/", user_public_key, name="user_public_key"),

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
    path("wallet/balance/", wallet_balance, name="wallet_balance"),
    path("check_balance/<str:wallet_address>/", check_balance, name="check_balance"),
    path("wallet/<str:wallet_address>/balance/", check_balance, name="check_balance_legacy"),

    # ===========================
    # 🧰 Services
    # ===========================
    path("services/", services_list_create, name="services_list_create"),   # GET list / POST create
    path("services/mine/", my_services, name="my_services"),
    path("services/<int:service_id>/", services_detail, name="services_detail"),
    path("services/categories/", services_categories, name="services_categories"),

    # ===========================
    # 📅 Bookings
    # ===========================
    path("bookings/", bookings_list_create, name="bookings_list_create"),
    path("bookings/<int:booking_id>/", bookings_detail, name="bookings_detail"),
    path("bookings/<int:booking_id>/confirm/", bookings_confirm, name="bookings_confirm"),
    path("bookings/<int:booking_id>/reject/", bookings_reject, name="bookings_reject"),
    path("bookings/<int:booking_id>/cancel/", bookings_cancel, name="bookings_cancel"),
    path("bookings/<int:booking_id>/complete/", bookings_complete, name="bookings_complete"),

    # ===========================
    # 👤 Profile / Me
    # ===========================
    path("me/", me_detail_update, name="me"),
    path("me/update/", me_detail_update, name="me_update"),
    path("users/me/", me_detail_update, name="users_me_alias"),
    path("profile/avatar/", profile_avatar, name="profile_avatar"),
    path("users/me/avatar/", profile_avatar, name="users_me_avatar"),
    path("users/me/boot_status/", boot_status, name="boot_status"),
]
