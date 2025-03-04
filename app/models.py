from django.contrib.auth.models import AbstractUser, BaseUserManager
from django.db import models
from django.contrib.auth.hashers import make_password
import uuid


# ✅ Custom User Manager (Handles password hashing)
class CustomUserManager(BaseUserManager):
    def create_user(self, email, password=None, **extra_fields):
        if not email:
            raise ValueError("The Email field must be set")
        email = self.normalize_email(email)
        extra_fields.setdefault("is_active", True)

        user = self.model(email=email, **extra_fields)
        user.password = make_password(password)  # ✅ Hash password before saving
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        return self.create_user(email, password, **extra_fields)


# ✅ Custom User Model (Email-based authentication, wallet, hashed password)
class User(AbstractUser):
    username = None  # Remove username field
    first_name = models.CharField(max_length=30)
    last_name = models.CharField(max_length=30)
    email = models.EmailField(unique=True)
    password = models.CharField(max_length=128)  # ✅ Ensure password is stored hashed
    public_key = models.TextField(blank=True, null=True)  # ✅ Store Public Key
    wallet_address = models.CharField(
        max_length=42, 
        unique=True, 
        null=False, 
        blank=False, 
        default="0x0000000000000000000000000000000000000000"
    )

    USERNAME_FIELD = "email"  # Set email as the username field
    REQUIRED_FIELDS = ["first_name", "last_name"]

    objects = CustomUserManager()

    esc_balance = models.DecimalField(max_digits=20, decimal_places=4, default=0.0000)
    is_vip = models.BooleanField(default=False)
    
    groups = models.ManyToManyField(
        "auth.Group", related_name="app_user_groups", blank=True
    )
    user_permissions = models.ManyToManyField(
        "auth.Permission", related_name="app_user_permissions", blank=True
    )

    def __str__(self):
        return (
            f"🆔 User ID: {self.id}\n"
            f"👤 Name: {self.first_name} {self.last_name}\n"
            f"📧 Email: {self.email}\n"
            f"💰 Wallet: {self.wallet_address}\n"
            f"🔑 Public Key: {self.public_key if self.public_key else '❌ No Public Key'}\n"
            f"💵 Balance: {self.esc_balance}\n"
            f"🌟 VIP: {'Yes' if self.is_vip else 'No'}\n"
        )


# ✅ Service Listings (Users offering services for Eastside Coin)
class Service(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    title = models.CharField(max_length=255)
    description = models.TextField()
    price = models.DecimalField(max_digits=10, decimal_places=2)
    category = models.CharField(max_length=100)  # ✅ Categorization for easy searching
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"Service({self.title}) by {self.user.email}"


# ✅ Transactions (Payments in Eastside Coin)
class Transaction(models.Model):
    sender = models.ForeignKey(User, on_delete=models.CASCADE, related_name="sent_transactions")
    receiver = models.ForeignKey(User, on_delete=models.CASCADE, related_name="received_transactions")
    amount = models.DecimalField(max_digits=20, decimal_places=4)
    status = models.CharField(
        max_length=20, choices=[("pending", "Pending"), ("completed", "Completed"), ("failed", "Failed")], default="pending"
    )  # ✅ Track transaction status
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]  # ✅ Latest transactions first

    def __str__(self):
        return f"Transaction({self.amount} ESC from {self.sender.email} to {self.receiver.email})"


# ✅ Chat Messages (End-to-End Encrypted)
class ChatMessage(models.Model):
    sender = models.ForeignKey(User, on_delete=models.CASCADE, related_name="sent_messages")
    receiver = models.ForeignKey(User, on_delete=models.CASCADE, related_name="received_messages")
    encrypted_message = models.TextField()  # ✅ Store encrypted text, not plaintext
    timestamp = models.DateTimeField(auto_now_add=True)
    is_read = models.BooleanField(default=False)  # ✅ Track if the message has been read

    class Meta:
        ordering = ["-timestamp"]  # ✅ Show latest messages first

    def __str__(self):
        return f"Message from {self.sender.email} to {self.receiver.email} at {self.timestamp}"


# ✅ Wallet Activity (Logs all wallet-related actions)
class WalletActivity(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="wallet_activities")
    activity_type = models.CharField(
        max_length=50, choices=[("deposit", "Deposit"), ("withdraw", "Withdraw"), ("transfer", "Transfer")]
    )
    amount = models.DecimalField(max_digits=20, decimal_places=4)
    transaction_hash = models.CharField(max_length=100, null=True, blank=True)  # ✅ Optional Blockchain Tx Hash
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]  # ✅ Show latest wallet activity first

    def __str__(self):
        return f"WalletActivity({self.activity_type} of {self.amount} ESC by {self.user.email})"
