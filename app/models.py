from django.contrib.auth.models import AbstractUser, BaseUserManager
from django.db import models

# ✅ Custom User Manager (Remove username requirement)
class CustomUserManager(BaseUserManager):
    def create_user(self, email, password=None, **extra_fields):
        if not email:
            raise ValueError("The Email field must be set")
        email = self.normalize_email(email)
        extra_fields.setdefault("is_active", True)

        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        return self.create_user(email, password, **extra_fields)

# ✅ Custom User Model
class User(AbstractUser):
    username = None  # Remove default username field
    first_name = models.CharField(max_length=30)
    last_name = models.CharField(max_length=30)
    email = models.EmailField(unique=True)
    wallet_address = models.CharField(
        max_length=42, 
        unique=True, 
        null=False, 
        blank=False, 
        default="0x0000000000000000000000000000000000000000"  # Placeholder address
    )

    USERNAME_FIELD = "email"  # Set email as the username field
    REQUIRED_FIELDS = ["first_name", "last_name"]  # Keep these required

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
        return f"User({self.id}) - {self.first_name} {self.last_name} | Email: {self.email} | Wallet: {self.wallet_address} | Balance: {self.esc_balance} | VIP: {self.is_vip}"

class Service(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    title = models.CharField(max_length=255)
    description = models.TextField()
    price = models.DecimalField(max_digits=10, decimal_places=2)
    created_at = models.DateTimeField(auto_now_add=True)

class Transaction(models.Model):
    sender = models.ForeignKey(User, on_delete=models.CASCADE, related_name='sent_transactions')
    receiver = models.ForeignKey(User, on_delete=models.CASCADE, related_name='received_transactions')
    amount = models.DecimalField(max_digits=20, decimal_places=4)
    created_at = models.DateTimeField(auto_now_add=True)

class ChatMessage(models.Model):
    sender = models.ForeignKey(User, on_delete=models.CASCADE, related_name='sent_messages')
    receiver = models.ForeignKey(User, on_delete=models.CASCADE, related_name='received_messages')
    message = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
