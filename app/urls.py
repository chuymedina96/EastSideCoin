from django.urls import path
from .views import register_user, login_user, check_balance, logout_user
from rest_framework_simplejwt.views import TokenRefreshView

urlpatterns = [
    path('register/', register_user, name='register_user'),
    path('login/', login_user, name='login_user'),
    path('balance/<str:wallet_address>/', check_balance, name='check_balance'),
    path("logout/", logout_user, name="logout"),
    path("token/refresh/", TokenRefreshView.as_view(), name="token_refresh"),
]

