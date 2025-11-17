import random
import uuid
from datetime import timedelta
from decimal import Decimal

from django.core.management.base import BaseCommand
from django.utils import timezone
from django.db import transaction as db_transaction
from django.core.files.base import ContentFile
from django.contrib.auth.hashers import make_password
from django.apps import apps

from faker import Faker
import requests

from app.models import (
    User,
    Service,
    Booking,
    Transaction,
    WalletActivity,
    WalletAccount,
    WalletTransaction,
)

fake = Faker("en_US")

# ================================================================
# ESC TOKENOMICS + LP / PRICE SIM CONSTANTS
# ================================================================

TOTAL_SUPPLY_ESC = Decimal("1000000")      # 1,000,000 ESC total
FOUNDER_RESERVE_ESC = Decimal("400000")    # your long-term reserve (off-market)

# Phase-1 circulating slice (conceptual free float / LP side)
CIRCULATING_SLICE_ESC = Decimal("50000")   # 50,000 ESC

# LP: 50,000 ESC vs 500 USDC ⇒ $0.01 / ESC
ESC_INITIAL_PRICE_USD = Decimal("0.01")
LP_USDC = Decimal("500")
LP_ESC = CIRCULATING_SLICE_ESC

# Treasury supply (before starter pool)
TREASURY_SUPPLY_ESC = TOTAL_SUPPLY_ESC - FOUNDER_RESERVE_ESC - CIRCULATING_SLICE_ESC
# = 1,000,000 - 400,000 - 50,000 = 550,000 ESC

# Starter airdrops: 100 ESC × 100 wallets = 10,000 ESC
STARTER_ACCOUNTS = 100
STARTER_PER_ACCOUNT_ESC = Decimal("100")
STARTER_ALLOCATION_ESC = STARTER_PER_ACCOUNT_ESC * STARTER_ACCOUNTS  # 10,000 ESC

# For the DB sim:
#  - Founder reserve is conceptually separate (no DB row needed).
#  - LP ESC side lives in the AMM contract.
#  - Treasury wallet holds: TREASURY_SUPPLY_ESC + STARTER_ALLOCATION_ESC.
TREASURY_WALLET_INITIAL_ESC = TREASURY_SUPPLY_ESC + STARTER_ALLOCATION_ESC

print("🔢 ESC tokenomics (sim context)")
print(f"  Total supply        : {TOTAL_SUPPLY_ESC} ESC")
print(f"  Founder reserve     : {FOUNDER_RESERVE_ESC} ESC")
print(f"  Circulating slice   : {CIRCULATING_SLICE_ESC} ESC")
print(f"    ↳ LP ESC side     : {LP_ESC} ESC vs {LP_USDC} USDC → ${ESC_INITIAL_PRICE_USD} / ESC")
print(f"  Treasury supply     : {TREASURY_SUPPLY_ESC} ESC")
print(f"  Starter airdrop pool: {STARTER_ALLOCATION_ESC} ESC "
      f"({STARTER_PER_ACCOUNT_ESC} ESC × {STARTER_ACCOUNTS} wallets)")
print(f"  Treasury wallet DB  : {TREASURY_WALLET_INITIAL_ESC} ESC (treasury + starter pool)")
print("--------------------------------------------------------------")


# Neighborhoods for user.neighborhood
NEIGHBORHOODS = [
    "East Side",
    "South Deering",
    "Back of the Yards",
    "Little Village",
    "Pilsen",
    "Rogers Park",
    "Logan Square",
    "Humboldt Park",
    "Englewood",
    "Bronzeville",
    "Hyde Park",
    "Uptown",
    "Avondale",
    "Hermosa",
    "West Town",
]

LANGUAGE_SETS = [
    "English",
    "English, Spanish",
    "English, Spanish, Polish",
    "English, Spanish, Arabic",
    "English, Polish",
    "English, Spanish, French",
]

# Wide variety of neighbor-friendly services
SERVICE_TEMPLATES = [
    # Barber / beauty
    ("Fade & Line-Up", "Barber / Beauty", Decimal("15.00"),
     "Clean fades, line-ups, and beard trims out of the neighborhood."),
    ("Kids Haircut", "Barber / Beauty", Decimal("10.00"),
     "Patient with kids, weekend and after-school slots available."),
    ("Twists & Braids", "Barber / Beauty", Decimal("25.00"),
     "Protective styles and braids done with care."),
    ("Nail Care (Manicure)", "Barber / Beauty", Decimal("18.00"),
     "Basic manicure with shaping and polish."),

    # Tutoring / education
    ("After-School Math Tutoring", "Tutoring", Decimal("20.00"),
     "One-hour math sessions for middle and high school students."),
    ("Reading & Homework Help", "Tutoring", Decimal("18.00"),
     "Reading practice and homework help for grades 1–6."),
    ("College Application Review", "Tutoring", Decimal("30.00"),
     "Help with essays, resumes, and applications."),

    # Child / elder care
    ("Date Night Babysitting (2 hr)", "Childcare", Decimal("22.00"),
     "Reliable babysitting for date nights or errands."),
    ("Elder Check-In Visits", "Elders", Decimal("15.00"),
     "Short visits to check in, chat, and help with small tasks."),

    # House / errands
    ("House Cleaning (2 hr)", "Household", Decimal("25.00"),
     "Deep clean kitchens, bathrooms, and common spaces."),
    ("Laundry & Folding", "Household", Decimal("15.00"),
     "Wash, dry, and fold clothes with care."),
    ("Grocery Pickup & Delivery", "Errands", Decimal("6.00"),
     "Local grocery runs for elders or busy neighbors."),
    ("Pharmacy Pickup", "Errands", Decimal("5.00"),
     "Pick up prescriptions and drop them off at your door."),

    # Auto
    ("Basic Car Detailing", "Auto", Decimal("30.00"),
     "Vacuum, wipe down interior, and basic exterior wash."),
    ("Oil Change Help (You Bring Oil)", "Auto", Decimal("20.00"),
     "Assistance with oil change in driveway or garage."),

    # Handyman / home
    ("Small Home Repairs", "Handyman", Decimal("22.00"),
     "Fix shelves, patch small holes, minor installs."),
    ("Furniture Assembly", "Handyman", Decimal("18.00"),
     "Assemble flat-pack furniture and basic installs."),
    ("TV Mounting", "Handyman", Decimal("28.00"),
     "Mount TVs securely with clean cable routing."),

    # Tech / digital
    ("Phone / Laptop Setup", "Tech Help", Decimal("18.00"),
     "Help set up new devices, apps, and backups."),
    ("WiFi & Router Tune-Up", "Tech Help", Decimal("20.00"),
     "Improve home WiFi coverage and speed."),
    ("Resume & LinkedIn Refresh", "Tech Help", Decimal("22.00"),
     "Update resume and LinkedIn for job hunting."),

    # Creative / music / media
    ("Beat-Making Session (1 hr)", "Creative / Music", Decimal("18.00"),
     "Come through and cook up a track from scratch together."),
    ("Vocal Recording Session (1 hr)", "Creative / Music", Decimal("22.00"),
     "Record vocals with light mixing and autotune."),
    ("Portrait Photography Session", "Creative / Media", Decimal("25.00"),
     "Outdoor portraits with light editing included."),
    ("Small Business Branding Photos", "Creative / Media", Decimal("30.00"),
     "Product and storefront photos for social media."),

    # Food / cooking
    ("Meal Prep for the Week", "Cooking", Decimal("35.00"),
     "Cook simple, healthy meals for the week."),
    ("Tamales by the Dozen (Labor Only)", "Cooking", Decimal("20.00"),
     "Help prep tamales for a family gathering (you bring ingredients)."),

    # Fitness / wellness
    ("Neighborhood Walk & Stretch", "Fitness", Decimal("10.00"),
     "Light walk + stretching session for beginners."),
    ("Boxing / Pad Work Session", "Fitness", Decimal("18.00"),
     "Basic mitt work and conditioning for all levels."),

    # Yard / garden
    ("Lawn Mowing (Front / Back)", "Yard", Decimal("18.00"),
     "Cut grass and bag clippings."),
    ("Garden Bed Cleanup", "Yard", Decimal("16.00"),
     "Weed, mulch, and tidy small garden beds."),

    # Language / translation
    ("Spanish–English Translation (Docs)", "Translation", Decimal("22.00"),
     "Translate short letters, flyers, and notices."),
    ("Interpretation for Appointments", "Translation", Decimal("18.00"),
     "Spanish–English interpretation for local appointments."),
]


def _wallet_address():
    """Generate a Web3-style 0x + 40 hex wallet address."""
    return "0x" + "".join(random.choice("0123456789abcdef") for _ in range(40))


def _fetch_avatar_content():
    """
    Grab a random avatar from randomuser.me (men + women).
    No API key required.
    """
    try:
        gender = random.choice(["men", "women"])
        idx = random.randint(1, 98)
        url = f"https://randomuser.me/api/portraits/{gender}/{idx}.jpg"
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            return ContentFile(
                resp.content,
                name=f"avatar_{gender}_{idx}_{uuid.uuid4().hex}.jpg",
            )
    except Exception as e:
        print("⚠️ Avatar fetch failed:", e)
    return None


def _get_or_create_wallet_for_user(user, initial_balance=Decimal("0.0")):
    """
    Ensure each user has a WalletAccount aligned with user.wallet_address.
    """
    if not user.wallet_address:
        user.wallet_address = _wallet_address()
        user.save(update_fields=["wallet_address"])

    wallet, created = WalletAccount.objects.get_or_create(
        user=user,
        defaults={
            "address": user.wallet_address,
            "balance": initial_balance,
        },
    )
    return wallet


def _create_treasury_user():
    """
    Treasury user for the sim.

    Conceptual breakdown (on-chain story):
      - Founder reserve:           400,000 ESC   (off-market; not a DB wallet)
      - LP ESC side:               50,000 ESC    (in AMM vs 500 USDC)
      - Treasury supply:          550,000 ESC    (protocol / DAO)
      - Starter airdrop pool:     10,000 ESC     (subset of treasury; for 100×100 ESC)

    For the DB sim, this wallet holds:
      TREASURY_WALLET_INITIAL_ESC = TREASURY_SUPPLY_ESC + STARTER_ALLOCATION_ESC
      = 560,000 ESC
    """
    email = "treasury@escdemo.local"
    u, created = User.objects.get_or_create(
        email=email,
        defaults={
            "first_name": "ESC",
            "last_name": "Treasury",
            "password": make_password("esc-treasury-demo"),
            "wallet_address": _wallet_address(),
            "bio": "Internal treasury account for ESC simulations.",
            "neighborhood": "East Side",
            "esc_balance": TREASURY_WALLET_INITIAL_ESC,
            "onboarding_completed": True,
        },
    )

    treasury_wallet = _get_or_create_wallet_for_user(
        u, initial_balance=TREASURY_WALLET_INITIAL_ESC
    )

    # If existing wallet is low (old runs), top it to the target for a clean sim
    if not created and treasury_wallet.balance < TREASURY_WALLET_INITIAL_ESC:
        treasury_wallet.balance = TREASURY_WALLET_INITIAL_ESC
        treasury_wallet.save(update_fields=["balance"])

    print(f"{'✅ Created' if created else 'ℹ️ Using existing'} treasury user: {u.email}")
    print(
        f"   Treasury wallet: {treasury_wallet.address} "
        f"balance={treasury_wallet.balance} ESC (treasury + starter pool)"
    )
    return u


def _create_fake_users(count=100, domain="escdemo.local"):
    """
    Create ~count users with realistic profiles + avatars + WalletAccount.
    No public_key set → app will route to KeyScreenSetup when logging in.
    """
    users = []

    for i in range(count):
        first = fake.first_name()
        last = fake.last_name()
        base_email = f"{first.lower()}.{last.lower()}.{i}@{domain}"
        email = base_email

        # Ensure email uniqueness
        if User.objects.filter(email=email).exists():
            email = f"{first.lower()}.{last.lower()}.{i}-{uuid.uuid4().hex[:4]}@{domain}"

        # Unique wallet address
        wallet = _wallet_address()
        while User.objects.filter(wallet_address=wallet).exists():
            wallet = _wallet_address()

        neighborhood = random.choice(NEIGHBORHOODS)
        languages = random.choice(LANGUAGE_SETS)
        skills_list = fake.words(nb=random.randint(3, 7))
        skills = ", ".join(skills_list)

        bio = fake.sentence(nb_words=8) + " " + fake.sentence(nb_words=10)

        # Simple default password for all demo users (dev only)
        default_password = "escdemo123"

        u = User.objects.create(
            first_name=first,
            last_name=last,
            email=email,
            password=make_password(default_password),
            wallet_address=wallet,
            esc_balance=Decimal("0.0000"),
            is_vip=random.random() < 0.12,
            neighborhood=neighborhood,
            languages=languages,
            skills=skills,
            bio=bio,
            onboarding_completed=True,
        )

        # Attach avatar image (if fetch succeeds)
        avatar_content = _fetch_avatar_content()
        if avatar_content:
            u.avatar.save(avatar_content.name, avatar_content, save=True)

        # Create wallet account with matching address + 0 balance
        _get_or_create_wallet_for_user(u, initial_balance=Decimal("0.0"))

        users.append(u)

    print(f"✅ Created {len(users)} ESC neighbor users.")
    print("   (All seeded users use password: 'escdemo123')")
    return users


def _airdrop_esc_to_users(treasury, users):
    """
    Airdrop the starter pool:

      - Target: 100 ESC to 100 wallets = 10,000 ESC
      - Uses ESC_INITIAL_PRICE_USD = $0.01 for USD context
      - Stops once STARTER_ALLOCATION_ESC is exhausted

    Syncs:
      - User.esc_balance
      - WalletAccount.balance
      - Transaction + WalletTransaction + WalletActivity
    """
    remaining = STARTER_ALLOCATION_ESC
    price_usd = ESC_INITIAL_PRICE_USD
    total_airdropped = Decimal("0.0000")
    recipients = 0

    treasury_wallet = _get_or_create_wallet_for_user(
        treasury, initial_balance=TREASURY_WALLET_INITIAL_ESC
    )

    if remaining <= 0:
        print("⚠️ No starter allocation configured; skipping airdrop.")
        return

    shuffled_users = list(users)
    random.shuffle(shuffled_users)

    with db_transaction.atomic():
        for u in shuffled_users:
            if remaining <= 0:
                break

            amount = min(STARTER_PER_ACCOUNT_ESC, remaining)
            if amount <= 0:
                continue

            user_wallet = _get_or_create_wallet_for_user(u)

            # Move balances (user)
            treasury.esc_balance -= amount
            u.esc_balance += amount
            treasury.save(update_fields=["esc_balance"])
            u.save(update_fields=["esc_balance"])

            # Move balances (wallet)
            treasury_wallet.balance -= amount
            user_wallet.balance += amount
            treasury_wallet.save(update_fields=["balance"])
            user_wallet.save(update_fields=["balance"])

            amount_usd = (amount * price_usd).quantize(Decimal("0.0000"))

            tx = Transaction.objects.create(
                sender=treasury,
                receiver=u,
                amount=amount,
                tx_type="airdrop",
                status="completed",
                price_usd=price_usd,
                amount_usd=amount_usd,
                memo="Starter ESC airdrop (demo)",
            )

            WalletTransaction.objects.create(
                from_wallet=treasury_wallet,
                to_wallet=user_wallet,
                amount=amount,
                category="airdrop",
                memo="Initial ESC airdrop",
            )

            WalletActivity.objects.create(
                user=u,
                activity_type="deposit",
                amount=amount,
                transaction_hash=str(tx.id),
            )
            WalletActivity.objects.create(
                user=treasury,
                activity_type="withdraw",
                amount=-amount,
                transaction_hash=str(tx.id),
            )

            remaining -= amount
            total_airdropped += amount
            recipients += 1

    print(
        f"✅ Starter airdrop complete: {total_airdropped} ESC to {recipients} wallets "
        f"(pool {STARTER_ALLOCATION_ESC} ESC)."
    )


def _create_services_for_users(users, max_services_per_user=3):
    """
    Create services for a subset of users based on SERVICE_TEMPLATES.
    """
    services = []

    for u in users:
        # Not everyone offers services
        if random.random() < 0.35:
            continue

        num_services = random.randint(1, max_services_per_user)
        templates = random.sample(SERVICE_TEMPLATES, k=num_services)

        for title, category, base_price, desc in templates:
            # Slight jitter on prices to make listings unique but still reasonable
            price_jitter = Decimal(random.uniform(-2.0, 3.0)).quantize(Decimal("0.01"))
            final_price = max(Decimal("5.0"), base_price + price_jitter)

            s = Service.objects.create(
                user=u,
                title=title,
                description=desc,
                price=final_price,
                category=category,
            )
            services.append(s)

    print(f"✅ Created {len(services)} services across neighbors.")
    return services


def _update_price_from_volume(sim_state):
    """
    Toy price curve for the sim:

      price = ESC_INITIAL_PRICE_USD * (1 + 1.5 * min(volume / circulating_slice, 5))

    So:
      - At zero volume: 0.01
      - When total traded volume ≈ circulating slice (50k): ~ 0.025
      - When 2x circulating volume trades: ~ 0.04
      - Clipped at 5× for sanity.
    """
    volume = sim_state["volume_esc"]
    if CIRCULATING_SLICE_ESC <= 0:
        return

    progress = volume / CIRCULATING_SLICE_ESC
    if progress < 0:
        progress = Decimal("0")
    if progress > Decimal("5"):
        progress = Decimal("5")

    factor = Decimal("1.0") + Decimal("1.5") * progress
    new_price = (ESC_INITIAL_PRICE_USD * factor).quantize(Decimal("0.000001"))
    sim_state["price_usd"] = new_price


def _ensure_liquidity_for_payment(treasury, client, amount, price_usd, sim_state):
    """
    Ensure the client has enough ESC for a payment, by simulating a purchase
    from the treasury / protocol if needed.

    Updates:
      - treasury.esc_balance
      - client.esc_balance
      - WalletAccount balances
      - WalletTransaction + WalletActivity (onramp)
      - sim_state["onramp_esc"], sim_state["onramp_usd"]
    """
    needed = amount - client.esc_balance
    if needed <= 0:
        return

    treasury_wallet = _get_or_create_wallet_for_user(
        treasury, initial_balance=TREASURY_WALLET_INITIAL_ESC
    )
    client_wallet = _get_or_create_wallet_for_user(client)

    # Cap by what the treasury actually has (or just mint; here we cap)
    if treasury.esc_balance < needed:
        needed = max(Decimal("0"), treasury.esc_balance)

    if needed <= 0:
        return

    # Move balances (user)
    treasury.esc_balance -= needed
    client.esc_balance += needed
    treasury.save(update_fields=["esc_balance"])
    client.save(update_fields=["esc_balance"])

    # Move balances (wallet)
    treasury_wallet.balance -= needed
    client_wallet.balance += needed
    treasury_wallet.save(update_fields=["balance"])
    client_wallet.save(update_fields=["balance"])

    # Simulated on-ramp
    tx_hash = f"onramp-{uuid.uuid4().hex}"
    WalletTransaction.objects.create(
        from_wallet=treasury_wallet,
        to_wallet=client_wallet,
        amount=needed,
        category="onramp_purchase",
        memo="Simulated ESC purchase from treasury",
    )
    WalletActivity.objects.create(
        user=client,
        activity_type="deposit",
        amount=needed,
        transaction_hash=tx_hash,
    )
    WalletActivity.objects.create(
        user=treasury,
        activity_type="withdraw",
        amount=-needed,
        transaction_hash=tx_hash,
    )

    sim_state.setdefault("onramp_esc", Decimal("0.0"))
    sim_state.setdefault("onramp_usd", Decimal("0.0"))
    sim_state["onramp_esc"] += needed
    sim_state["onramp_usd"] += (needed * price_usd).quantize(Decimal("0.0000"))


def _create_bookings_and_payments(
    services,
    users,
    treasury,
    sim_state,
    target_payments=1000,
    window_days=180,
):
    """
    Create bookings between neighbors and simulate ~target_payments COMPLETED payments
    spread roughly across the last `window_days` days.

    Syncs:
      - User.esc_balance
      - WalletAccount.balance
      - Transaction + WalletTransaction + WalletActivity
    Keeps:
      - sim_state["tx_count"]
      - sim_state["volume_esc"]
      - sim_state["burned_esc"]
      - sim_state["price_usd"] (dynamic)
      - sim_state["onramp_esc"], sim_state["onramp_usd"]
    """
    if not services or len(users) < 2:
        print("⚠️ Not enough services/users to create bookings.")
        return

    now = timezone.now()
    bookings_created = 0
    payments_created = 0

    max_iterations = target_payments * 5  # safety cap

    with db_transaction.atomic():
        for _ in range(max_iterations):
            if payments_created >= target_payments:
                break

            s = random.choice(services)
            provider = s.user
            possible_clients = [u for u in users if u.id != provider.id]
            if not possible_clients:
                continue

            client = random.choice(possible_clients)

            provider_wallet = _get_or_create_wallet_for_user(provider)
            client_wallet = _get_or_create_wallet_for_user(client)

            # Random time within [-window_days, 0] → last ~6 months
            offset_days = random.randint(-window_days, 0)
            start_hour = random.randint(8, 19)  # 8am–7pm
            start_at = now + timedelta(days=offset_days)
            start_at = start_at.replace(
                hour=start_hour,
                minute=0,
                second=0,
                microsecond=0,
            )
            end_at = start_at + timedelta(hours=1)

            # We set status straight to COMPLETED so it counts as a finished job.
            b = Booking.objects.create(
                service=s,
                provider=provider,
                client=client,
                start_at=start_at,
                end_at=end_at,
                status=Booking.Status.COMPLETED,
                price_snapshot=s.price,
                currency="ESC",
                notes="Auto-generated booking for ESC neighborhood 6-month sim.",
            )
            bookings_created += 1

            amount = s.price.quantize(Decimal("0.0001"))

            # Ensure the client has enough ESC (simulate on-ramp if needed)
            price_usd = sim_state["price_usd"]
            _ensure_liquidity_for_payment(treasury, client, amount, price_usd, sim_state)

            if client.esc_balance < amount:
                # Even after attempted on-ramp, still can't pay
                continue

            # 1% burn
            burn_rate = Decimal("0.01")
            burn_amount = (amount * burn_rate).quantize(Decimal("0.0000"))
            net_to_provider = amount - burn_amount

            if net_to_provider <= 0:
                continue

            # Update sim_state aggregates
            sim_state["tx_count"] += 1
            sim_state["volume_esc"] += amount
            sim_state["burned_esc"] += burn_amount

            # Update price from cumulative volume
            _update_price_from_volume(sim_state)
            price_usd = sim_state["price_usd"]
            amount_usd = (net_to_provider * price_usd).quantize(Decimal("0.0000"))

            # Move balances (User)
            client.esc_balance -= amount
            provider.esc_balance += net_to_provider
            client.save(update_fields=["esc_balance"])
            provider.save(update_fields=["esc_balance"])

            # Move balances (WalletAccount)
            client_wallet.balance -= amount
            provider_wallet.balance += net_to_provider
            client_wallet.save(update_fields=["balance"])
            provider_wallet.save(update_fields=["balance"])

            tx = Transaction.objects.create(
                sender=client,
                receiver=provider,
                amount=net_to_provider,  # what provider actually receives
                tx_type="payment",
                status="completed",
                price_usd=price_usd,
                amount_usd=amount_usd,
                memo=(
                    f"Payment for {s.title} on {start_at:%Y-%m-%d} "
                    f"(1% burned: {burn_amount} ESC)"
                ),
            )

            # Link to booking
            b.transaction = tx
            b.paid_at = timezone.now()
            b.save(update_fields=["transaction", "paid_at"])

            # Low-level ledger entry for AMM-style sims
            WalletTransaction.objects.create(
                from_wallet=client_wallet,
                to_wallet=provider_wallet,
                amount=net_to_provider,
                category="booking_payment",
                memo=f"Booking payment for {s.title}",
                booking=b,
            )

            # Wallet activities
            WalletActivity.objects.create(
                user=client,
                activity_type="transfer",
                amount=-amount,
                transaction_hash=str(tx.id),
            )
            WalletActivity.objects.create(
                user=provider,
                activity_type="transfer",
                amount=net_to_provider,
                transaction_hash=str(tx.id),
            )

            payments_created += 1

    print(f"✅ Created {bookings_created} bookings total.")
    print(f"✅ Created {payments_created} completed payments linked to bookings.")
    print(
        f"📈 Sim volume: {sim_state['volume_esc']} ESC across {sim_state['tx_count']} payments."
    )
    print(f"🔥 Total burned (1% fee): {sim_state['burned_esc']} ESC.")
    print(f"💵 Final simulated price: ${sim_state['price_usd']} per ESC.")
    if "onramp_esc" in sim_state:
        print(
            f"🏦 On-ramped: {sim_state['onramp_esc']} ESC "
            f"(~${sim_state.get('onramp_usd', Decimal('0.0'))} USD simulated in)."
        )


class Command(BaseCommand):
    help = "Seed ESC neighborhood with fake users, avatars, services, bookings, and payments."

    def add_arguments(self, parser):
        parser.add_argument(
            "--users",
            type=int,
            default=100,
            help="Number of neighbor users to create (default: 100)",
        )
        parser.add_argument(
            "--target-payments",
            type=int,
            default=1000,
            help="Approximate number of completed payments to simulate (default: 1000)",
        )
        parser.add_argument(
            "--window-days",
            type=int,
            default=180,
            help="Look-back window in days for simulated activity (default: 180 ≈ 6 months)",
        )

    def handle(self, *args, **options):
        count = options["users"]
        target_payments = options["target_payments"]
        window_days = options["window_days"]

        self.stdout.write(self.style.WARNING("🚧 Seeding ESC neighborhood demo data..."))
        self.stdout.write(
            f"   → users={count}, target_payments≈{target_payments}, window_days={window_days}"
        )

        # global sim state for price + burns + volume + on-ramps
        sim_state = {
            "initial_price_usd": ESC_INITIAL_PRICE_USD,
            "price_usd": ESC_INITIAL_PRICE_USD,
            "volume_esc": Decimal("0.0"),
            "tx_count": 0,
            "burned_esc": Decimal("0.0"),
            "onramp_esc": Decimal("0.0"),
            "onramp_usd": Decimal("0.0"),
        }

        treasury = _create_treasury_user()
        users = _create_fake_users(count=count)
        _airdrop_esc_to_users(treasury, users)
        services = _create_services_for_users(users)
        _create_bookings_and_payments(
            services,
            users,
            treasury,
            sim_state=sim_state,
            target_payments=target_payments,
            window_days=window_days,
        )

        # Founder reserve value tracking
        founder_initial_value = (FOUNDER_RESERVE_ESC * sim_state["initial_price_usd"]).quantize(
            Decimal("0.01")
        )
        founder_final_value = (FOUNDER_RESERVE_ESC * sim_state["price_usd"]).quantize(
            Decimal("0.01")
        )

        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS("✅ ESC neighborhood seeding complete."))
        self.stdout.write(
            f"👑 Founder reserve: {FOUNDER_RESERVE_ESC} ESC "
            f"(initial ${sim_state['initial_price_usd']} → ${sim_state['price_usd']} per ESC)"
        )
        self.stdout.write(
            f"   Value at start : ${founder_initial_value} USD\n"
            f"   Value after sim: ${founder_final_value} USD"
        )

        # ================================
        # 📊 OPTIONAL: Summary model write
        # ================================
        try:
            EscEconomySnapshot = apps.get_model("app", "EscEconomySnapshot")
        except LookupError:
            EscEconomySnapshot = None

        if EscEconomySnapshot:
            now = timezone.now()
            window_start = now - timedelta(days=window_days)
            window_end = now

            # Aggregate circulating + holders from users
            from django.db.models import Sum

            circ = (
                User.objects.aggregate(total=Sum("esc_balance"))["total"]
                or Decimal("0.0")
            )
            holders = User.objects.filter(esc_balance__gt=0).count()

            snapshot = EscEconomySnapshot.objects.create(
                label=f"demo_{now:%Y%m%d_%H%M}",
                total_supply_esc=TOTAL_SUPPLY_ESC,
                founder_reserve_esc=FOUNDER_RESERVE_ESC,
                circulating_slice_esc=CIRCULATING_SLICE_ESC,
                lp_esc=LP_ESC,
                lp_usdc=LP_USDC,
                price_initial_usd=sim_state["initial_price_usd"],
                price_final_usd=sim_state["price_usd"],
                burned_esc=sim_state["burned_esc"],
                volume_esc=sim_state["volume_esc"],
                tx_count=sim_state["tx_count"],
                onramp_esc=sim_state["onramp_esc"],
                onramp_usd=sim_state["onramp_usd"],
                circulating_supply_esc=circ,
                holder_count=holders,
                window_start=window_start,
                window_end=window_end,
            )

            self.stdout.write(
                self.style.SUCCESS(
                    f"📊 EscEconomySnapshot stored (id={snapshot.id}) "
                    f"for window {window_start.date()} → {window_end.date()} "
                    f"with tx_count={sim_state['tx_count']}."
                )
            )
        else:
            self.stdout.write(
                self.style.WARNING(
                    "ℹ️ EscEconomySnapshot model not found – skipping summary row. "
                    "Add it in app.models if you want persistent sim stats."
                )
            )
