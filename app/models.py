from django.contrib.auth.models import AbstractUser, BaseUserManager
from django.db import models
from django.contrib.auth.hashers import make_password
from django.utils import timezone
from decimal import Decimal
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


def user_avatar_path(instance, filename):
    # Keep user uploads in a stable, per-user folder
    return f"users/{instance.id}/avatar/{filename}"


# ✅ Custom User Model (Email-based auth, wallet, public key, onboarding/profile)
class User(AbstractUser):
    username = None  # Remove username field
    first_name = models.CharField(max_length=30)
    last_name = models.CharField(max_length=30)
    email = models.EmailField(unique=True)
    password = models.CharField(max_length=128)  # ✅ stored hashed

    # Device public key (PEM) uploaded by the client
    public_key = models.TextField(null=True, blank=True)

    # ⚠️ Unique wallet address bound to the user (legacy direct field)
    wallet_address = models.CharField(
        max_length=42,
        unique=True,
        null=False,
        blank=False,
    )

    # 🎯 Onboarding/Profile fields
    avatar = models.ImageField(upload_to=user_avatar_path, null=True, blank=True)
    bio = models.TextField(blank=True)
    education = models.TextField(blank=True)
    age = models.PositiveSmallIntegerField(null=True, blank=True)
    neighborhood = models.CharField(max_length=100, blank=True)
    skills = models.CharField(max_length=255, blank=True)      # CSV/tags for now
    languages = models.CharField(max_length=255, blank=True)   # CSV/tags for now
    onboarding_completed = models.BooleanField(default=False)

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["first_name", "last_name"]

    objects = CustomUserManager()

    # Core ESC wallet fields (can be treated as cached balance if you want)
    esc_balance = models.DecimalField(
        max_digits=20, decimal_places=4, default=Decimal("0.0000")
    )
    is_vip = models.BooleanField(default=False)

    # Keep custom related_names to avoid clashes with AbstractUser
    groups = models.ManyToManyField(
        "auth.Group", related_name="app_user_groups", blank=True
    )
    user_permissions = models.ManyToManyField(
        "auth.Permission", related_name="app_user_permissions", blank=True
    )

    class Meta:
        indexes = [
            models.Index(fields=["email"]),
            models.Index(fields=["wallet_address"]),
            models.Index(fields=["first_name", "last_name"]),
        ]

    def __str__(self):
        return (
            f"🆔 User ID: {self.id}\n"
            f"👤 Name: {self.first_name} {self.last_name}\n"
            f"📧 Email: {self.email}\n"
            f"💰 Wallet: {self.wallet_address}\n"
            f"🔑 Public Key: {self.public_key if self.public_key else '❌ No Public Key'}\n"
            f"💵 Balance: {self.esc_balance}\n"
            f"🌟 VIP: {'Yes' if self.is_vip else 'No'}\n"
            f"✅ Onboarding: {'Done' if self.onboarding_completed else 'Pending'}\n"
        )

    # Optional helpers if you want to keep esc_balance in sync with wallet account
    def credit(self, amount: Decimal):
        self.esc_balance = (self.esc_balance or Decimal("0")) + amount
        self.save(update_fields=["esc_balance"])

    def debit(self, amount: Decimal):
        self.esc_balance = (self.esc_balance or Decimal("0")) - amount
        self.save(update_fields=["esc_balance"])


# ✅ WalletAccount – primary ledger account per user (for AMM sims)
class WalletAccount(models.Model):
    user = models.OneToOneField(
        User,
        on_delete=models.CASCADE,
        related_name="wallet_account",
    )
    address = models.CharField(
        max_length=128,
        unique=True,
        help_text="Internal ESC wallet address for this user.",
    )
    balance = models.DecimalField(
        max_digits=24,
        decimal_places=8,
        default=Decimal("0.00000000"),
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=["address"]),
            models.Index(fields=["user"]),
        ]

    def __str__(self):
        return f"WalletAccount({self.address}) user={self.user.email} balance={self.balance}"


# ✅ Service Listings (Users offering services for Eastside Coin)
class Service(models.Model):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="services"
    )
    title = models.CharField(max_length=255)
    description = models.TextField()
    price = models.DecimalField(
        max_digits=10, decimal_places=2
    )  # treated as ESC for now
    category = models.CharField(
        max_length=100
    )  # ✅ Categorization for easy searching
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=["category", "created_at"]),
            models.Index(fields=["title"]),
        ]
        ordering = ["-created_at"]

    def __str__(self):
        return f"Service({self.title}) by {self.user.email}"


# ✅ Bookings (Client ↔ Provider for a Service)
class Booking(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"       # created by client; awaiting provider action
        CONFIRMED = "confirmed", "Confirmed" # accepted by provider
        REJECTED = "rejected", "Rejected"    # declined by provider
        CANCELLED = "cancelled", "Cancelled" # cancelled by client/provider
        COMPLETED = "completed", "Completed" # service delivered
        NO_SHOW = "no_show", "No Show"       # client didn’t show

    # Who offers the service
    service = models.ForeignKey(
        Service, on_delete=models.CASCADE, related_name="bookings"
    )

    # Parties
    provider = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="provider_bookings"
    )
    client = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="client_bookings"
    )

    # When
    start_at = models.DateTimeField()
    end_at = models.DateTimeField()

    # State
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.PENDING
    )

    # Pricing snapshot (so later price changes on Service don’t affect past bookings)
    price_snapshot = models.DecimalField(
        max_digits=10, decimal_places=2, null=True, blank=True
    )
    currency = models.CharField(max_length=10, default="ESC")  # e.g., "ESC" or "USD"

    # Optional linkage to funds transfer (high-level tx, if you want)
    transaction = models.ForeignKey(
        "Transaction",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="bookings",
    )

    # When the booking was actually paid
    paid_at = models.DateTimeField(null=True, blank=True)

    # Audit
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-start_at"]
        indexes = [
            models.Index(fields=["provider", "start_at"]),
            models.Index(fields=["client", "start_at"]),
            models.Index(fields=["status", "start_at"]),
            models.Index(fields=["service", "start_at"]),
        ]
        constraints = [
            # Prevent identical duplicate “requests” at the same time window by the same client for the same service.
            models.UniqueConstraint(
                fields=["service", "client", "start_at", "end_at", "status"],
                name="uniq_pending_client_request_window",
                condition=models.Q(status="pending"),
            ),
        ]

    def __str__(self):
        return (
            f"Booking({self.service.title}) "
            f"{self.start_at.isoformat()} → {self.end_at.isoformat()} | "
            f"{self.client.email} → {self.provider.email} [{self.status}]"
        )

    # Small helpers you can use in views later
    @property
    def is_active(self):
        return self.status in {self.Status.PENDING, self.Status.CONFIRMED}

    @property
    def is_paid(self):
        return self.transaction is not None or self.paid_at is not None

    def mark_confirmed(self):
        self.status = self.Status.CONFIRMED
        self.updated_at = timezone.now()

    def mark_cancelled(self):
        self.status = self.Status.CANCELLED
        self.cancelled_at = timezone.now()
        self.updated_at = self.cancelled_at

    def mark_completed(self):
        self.status = self.Status.COMPLETED
        self.completed_at = timezone.now()
        self.updated_at = self.completed_at


# ✅ Transactions (High-level Payments in Eastside Coin – user-to-user)
class Transaction(models.Model):
    TX_TYPE_CHOICES = [
        ("payment", "Payment"),
        ("airdrop", "Airdrop"),
        ("adjustment", "Adjustment"),
        ("treasury", "Treasury"),
    ]

    STATUS_CHOICES = [
        ("pending", "Pending"),
        ("completed", "Completed"),
        ("failed", "Failed"),
    ]

    sender = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="sent_transactions",
    )
    receiver = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="received_transactions",
    )
    amount = models.DecimalField(max_digits=20, decimal_places=4)

    # Economic context at time of tx (local “price”)
    price_usd = models.DecimalField(
        max_digits=18,
        decimal_places=6,
        default=Decimal("0.000000"),
    )
    amount_usd = models.DecimalField(
        max_digits=20,
        decimal_places=4,
        default=Decimal("0.0000"),
    )

    tx_type = models.CharField(
        max_length=20,
        choices=TX_TYPE_CHOICES,
        default="payment",
    )

    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default="pending",
    )

    memo = models.CharField(max_length=255, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["created_at"]),
            models.Index(fields=["status"]),
            models.Index(fields=["tx_type"]),
        ]

    def __str__(self):
        return (
            f"Transaction({self.amount} ESC from {self.sender.email} "
            f"to {self.receiver.email} [{self.tx_type}/{self.status}])"
        )

    def save(self, *args, **kwargs):
        # auto-compute amount_usd if price_usd is set and amount_usd is zero-ish
        if self.price_usd and (self.amount_usd is None or self.amount_usd == Decimal("0.0000")):
            self.amount_usd = (self.amount or Decimal("0")) * (self.price_usd or Decimal("0"))
        super().save(*args, **kwargs)


# ✅ WalletTransaction – low-level ledger between wallet accounts (for AMM sims)
class WalletTransaction(models.Model):
    from_wallet = models.ForeignKey(
        WalletAccount,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="outgoing_txs",
    )
    to_wallet = models.ForeignKey(
        WalletAccount,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="incoming_txs",
    )
    amount = models.DecimalField(
        max_digits=24,
        decimal_places=8,
    )
    category = models.CharField(
        max_length=64,
        default="payment",
        help_text="e.g. booking_payment, tip, gift, service_payment, reimbursement",
    )
    memo = models.CharField(max_length=255, blank=True)
    booking = models.ForeignKey(
        "Booking",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="payments",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["created_at"]),
            models.Index(fields=["category"]),
        ]

    def __str__(self):
        return f"WalletTx({self.amount} from {self.from_wallet_id} to {self.to_wallet_id} [{self.category}])"


# ✅ Chat Messages (End-to-End Encrypted)
class ChatMessage(models.Model):
    # UUID so clients can reference messages immediately
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    sender = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="sent_messages"
    )
    receiver = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="received_messages"
    )

    # 🔒 E2EE payload
    encrypted_message = models.TextField()  # base64 ciphertext
    iv = models.CharField(max_length=512)   # base64 IV
    mac = models.CharField(max_length=512)  # base64 HMAC(iv||ciphertext)

    # 🔑 AES key wrapped for each party (RSA-OAEP)
    encrypted_key_for_receiver = models.TextField()                 # required
    encrypted_key_for_sender = models.TextField(null=True, blank=True)  # recommended for sender history

    timestamp = models.DateTimeField(auto_now_add=True)
    is_read = models.BooleanField(default=False)

    class Meta:
        ordering = ["-timestamp"]
        indexes = [
            models.Index(fields=["receiver", "timestamp"]),
            models.Index(fields=["sender", "timestamp"]),
            models.Index(fields=["is_read"]),
        ]

    def __str__(self):
        return f"Message {self.id} from {self.sender.email} to {self.receiver.email} at {self.timestamp}"


# ✅ Wallet Activity (Logs all wallet-related actions)
class WalletActivity(models.Model):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="wallet_activities"
    )
    activity_type = models.CharField(
        max_length=50,
        choices=[
            ("deposit", "Deposit"),
            ("withdraw", "Withdraw"),
            ("transfer", "Transfer"),
        ],
    )
    amount = models.DecimalField(max_digits=20, decimal_places=4)
    transaction_hash = models.CharField(
        max_length=100, null=True, blank=True
    )  # optional on-chain hash or tx.id
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["user", "created_at"]),
            models.Index(fields=["activity_type"]),
        ]

    def __str__(self):
        return f"WalletActivity({self.activity_type} of {self.amount} ESC by {self.user.email})"


# ✅ EscEconomySnapshot – high-level sim summary (for 1,000-trade / 6-month windows, etc.)
class EscEconomySnapshot(models.Model):
    """
    High-level summary of the ESC economy for a given simulation or time window.
    Used so the app / dashboard can show:
      - price change
      - volume
      - tx counts
      - circulating supply
      - on-ramp stats
    """

    label = models.CharField(
        max_length=100,
        help_text="Short label for this snapshot (e.g. 'demo_20251116_1200').",
    )

    # Core tokenomics
    total_supply_esc = models.DecimalField(
        max_digits=20, decimal_places=4, default=Decimal("0")
    )
    founder_reserve_esc = models.DecimalField(
        max_digits=20, decimal_places=4, default=Decimal("0")
    )
    circulating_slice_esc = models.DecimalField(
        max_digits=20, decimal_places=4, default=Decimal("0")
    )
    lp_esc = models.DecimalField(
        max_digits=20, decimal_places=4, default=Decimal("0")
    )
    lp_usdc = models.DecimalField(
        max_digits=20, decimal_places=4, default=Decimal("0")
    )

    # Prices
    price_initial_usd = models.DecimalField(
        max_digits=20, decimal_places=6, default=Decimal("0")
    )
    price_final_usd = models.DecimalField(
        max_digits=20, decimal_places=6, default=Decimal("0")
    )

    # Activity over the window
    burned_esc = models.DecimalField(
        max_digits=20, decimal_places=4, default=Decimal("0")
    )
    volume_esc = models.DecimalField(
        max_digits=20, decimal_places=4, default=Decimal("0")
    )
    tx_count = models.PositiveIntegerField(default=0)

    # On-ramp (simulated buys from treasury / off-chain→on-chain)
    onramp_esc = models.DecimalField(
        max_digits=20, decimal_places=4, default=Decimal("0")
    )
    onramp_usd = models.DecimalField(
        max_digits=20, decimal_places=4, default=Decimal("0")
    )

    # Snapshot of circulating state at end of window
    circulating_supply_esc = models.DecimalField(
        max_digits=20, decimal_places=4, default=Decimal("0")
    )
    holder_count = models.PositiveIntegerField(default=0)

    # Time window this summary covers
    window_start = models.DateTimeField()
    window_end = models.DateTimeField()

    # Metadata
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.label} (tx={self.tx_count}, price=${self.price_final_usd})"
