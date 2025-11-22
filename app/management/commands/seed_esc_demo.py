import random
import uuid
from datetime import timedelta
from decimal import Decimal, getcontext
from collections import defaultdict
import csv
import os

from django.core.management.base import BaseCommand
from django.utils import timezone
from django.db import transaction as db_transaction
from django.core.files.base import ContentFile
from django.contrib.auth.hashers import make_password
from django.apps import apps
from django.db.models import Sum  # 🔹 for circulating + market cap stats

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

# 🔹 High precision for AMM math
getcontext().prec = 28

fake = Faker("en_US")

# ================================================================
# ESC TOKENOMICS + LP / PRICE SIM CONSTANTS
# ================================================================

TOTAL_SUPPLY_ESC = Decimal("1000000")      # 1,000,000 ESC (theoretical base supply)
FOUNDER_RESERVE_ESC = Decimal("400000")    # long-term founder / movement reserve

# For phase 1 we conceptually want:
#  - 50,000 ESC in the LP (vs USDC)
#  - 50,000 ESC available for starter airdrops (1000×50 ESC capacity)
#  → 100,000 ESC early circulating slice (LP + airdrops capacity)
LP_ESC = Decimal("50000")                  # LP side
STARTER_ACCOUNTS = 1000
STARTER_PER_ACCOUNT_ESC = Decimal("50")
STARTER_ALLOCATION_ESC = STARTER_PER_ACCOUNT_ESC * STARTER_ACCOUNTS  # 50,000 ESC

CIRCULATING_SLICE_ESC = LP_ESC + STARTER_ALLOCATION_ESC  # 100,000 ESC

# Treasury supply (before we park the starter pool there for distribution)
TREASURY_SUPPLY_ESC = TOTAL_SUPPLY_ESC - FOUNDER_RESERVE_ESC - CIRCULATING_SLICE_ESC
# = 1,000,000 - 400,000 - 100,000 = 500,000 ESC

# For the DB sim, the treasury wallet actually holds:
#  - Treasury supply (500,000 ESC)
#  - Plus the starter airdrop pool (50,000 ESC) which will be streamed out
TREASURY_WALLET_INITIAL_ESC = TREASURY_SUPPLY_ESC + STARTER_ALLOCATION_ESC  # 550,000 ESC

# LP: 50,000 ESC vs 500 USDC ⇒ $0.01 / ESC
# 🔒 Start price is locked to 0.01 in this script (no CLI override).
ESC_INITIAL_PRICE_USD = Decimal("0.01")
LP_USDC = Decimal("500")

# Dynamic Sarafu-style behavior: allow protocol minting when treasury is tight.
ALLOW_TREASURY_MINT = True
TREASURY_MINT_BUFFER_MULTIPLIER = Decimal("1.5")  # mint a bit more than "needed" for cushion

# ================================================================
# 📈 Price curve tuning (neighborhood / toy curve)
# ================================================================
# This is the internal neighborhood “reference price”.
# The AMM section below uses real constant-product math for LP.
PRICE_VOLUME_SLOPE = Decimal("6")
PRICE_VOLUME_CAP = Decimal("20")

# 🔥 Wallet top-up threshold: trigger simulated DEX buys when wallet ≤ this
WALLET_TOPUP_THRESHOLD_ESC = Decimal("15")

# To avoid hammering randomuser.me on huge seeds
MAX_AVATAR_SEED_USERS = 2000      # only attempt avatars for the first N users
AVATAR_TIMEOUT_SECONDS = 8

print("🔢 ESC tokenomics (sim context)")
print(f"  Total supply (base)        : {TOTAL_SUPPLY_ESC} ESC")
print(f"  Founder reserve            : {FOUNDER_RESERVE_ESC} ESC")
print(f"  Early circulating slice    : {CIRCULATING_SLICE_ESC} ESC")
print(f"    ↳ LP ESC side            : {LP_ESC} ESC vs {LP_USDC} USDC → ${ESC_INITIAL_PRICE_USD} / ESC")
print(
    f"    ↳ Starter pool           : {STARTER_ALLOCATION_ESC} ESC "
    f"({STARTER_PER_ACCOUNT_ESC} ESC × {STARTER_ACCOUNTS} wallets capacity)"
)
print(f"  Treasury supply (protocol) : {TREASURY_SUPPLY_ESC} ESC")
print(f"  Treasury wallet DB balance : {TREASURY_WALLET_INITIAL_ESC} ESC (treasury + starter pool)")
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

# Simple occupation profiles to make bios feel like real workers/teachers/etc.
OCCUPATION_PROFILES = [
    {
        "label": "Elementary School Teacher",
        "short": "teacher",
        "skills": [
            "reading support",
            "math tutoring",
            "classroom management",
            "bilingual education",
            "parent communication",
            "homework help",
        ],
        "bio_templates": [
            "Elementary school teacher on the {hood}, helping kids stay confident with reading and math.",
            "Local teacher who loves building up neighborhood students with patient tutoring and clear explanations.",
        ],
    },
    {
        "label": "High School Tutor",
        "short": "tutor",
        "skills": [
            "algebra",
            "geometry",
            "essay writing",
            "college prep",
            "study skills",
            "ACT/SAT prep",
        ],
        "bio_templates": [
            "High school tutor on the {hood}, helping teens with math, writing, and college prep.",
            "Local tutor supporting neighborhood students with homework, test prep, and confidence.",
        ],
    },
    {
        "label": "Barber / Stylist",
        "short": "barber",
        "skills": [
            "fades",
            "line-ups",
            "braids",
            "protective styles",
            "beard trims",
            "kids cuts",
        ],
        "bio_templates": [
            "Neighborhood barber keeping fades, line-ups, and beards clean for folks on the {hood}.",
            "Local stylist focused on clean, affordable cuts and styles for the community.",
        ],
    },
    {
        "label": "Childcare Worker",
        "short": "childcare",
        "skills": [
            "babysitting",
            "early childhood education",
            "bedtime routines",
            "homework help",
            "meal prep for kids",
        ],
        "bio_templates": [
            "Trusted childcare worker supporting parents on the {hood} with patient, reliable babysitting.",
            "Local sitter who keeps kids safe, fed, and entertained so parents can handle business.",
        ],
    },
    {
        "label": "Home Cleaner",
        "short": "cleaner",
        "skills": [
            "deep cleaning",
            "kitchen cleaning",
            "bathroom cleaning",
            "laundry",
            "organization",
        ],
        "bio_templates": [
            "House cleaner helping neighbors keep kitchens, bathrooms, and living rooms fresh.",
            "Local cleaner who focuses on respectful, detailed work so homes feel lighter.",
        ],
    },
    {
        "label": "Handyman / Repair",
        "short": "handyman",
        "skills": [
            "basic electrical",
            "small home repairs",
            "furniture assembly",
            "TV mounting",
            "yard work",
        ],
        "bio_templates": [
            "Neighborhood handyman helping with small repairs, installs, and setup jobs.",
            "Local worker doing the small fix-it projects that pile up around the house.",
        ],
    },
    {
        "label": "Tech Helper",
        "short": "tech",
        "skills": [
            "phone setup",
            "laptop setup",
            "WiFi tuning",
            "app installs",
            "basic troubleshooting",
        ],
        "bio_templates": [
            "Tech helper on the {hood} getting phones, laptops, and WiFi tuned up for neighbors.",
            "Local tech support for folks who need patient help with devices and apps.",
        ],
    },
    {
        "label": "Community Organizer",
        "short": "organizer",
        "skills": [
            "meeting facilitation",
            "translation",
            "community outreach",
            "flyer design",
            "event planning",
        ],
        "bio_templates": [
            "Community organizer helping neighbors connect, share info, and build power together.",
            "Local worker focused on outreach, translation, and connecting resources across the {hood}.",
        ],
    },
    {
        "label": "Food Vendor / Cook",
        "short": "cook",
        "skills": [
            "meal prep",
            "batch cooking",
            "family-style meals",
            "event cooking",
            "street food",
        ],
        "bio_templates": [
            "Neighborhood cook making simple, filling meals for busy families on the {hood}.",
            "Local food vendor who loves feeding neighbors at small events and family gatherings.",
        ],
    },
    {
        "label": "Rideshare / Delivery Driver",
        "short": "driver",
        "skills": [
            "errand runs",
            "school drop-offs",
            "grocery runs",
            "appointment rides",
            "package delivery",
        ],
        "bio_templates": [
            "Local driver helping neighbors get to appointments, work, and errands on time.",
            "Neighborhood driver doing safe, reliable rides and drop-offs across the {hood}.",
        ],
    },
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
    return "0x" + "".join(
        random.choice("0123456789abcdef") for _ in range(40)
    )


def _fetch_avatar_content(gender_slug=None):
    """
    Grab a random avatar from randomuser.me.
    gender_slug ∈ {"men", "women"} to keep pics aligned with names.

    We keep this best-effort and skip on any error/timeout so large seeds
    do not crash just because avatars flaked.
    """
    try:
        if gender_slug not in ("men", "women"):
            gender_slug = random.choice(["men", "women"])
        idx = random.randint(1, 98)
        url = f"https://randomuser.me/api/portraits/{gender_slug}/{idx}.jpg"
        resp = requests.get(url, timeout=AVATAR_TIMEOUT_SECONDS)
        if resp.status_code == 200:
            return ContentFile(
                resp.content,
                name=f"avatar_{gender_slug}_{idx}_{uuid.uuid4().hex}.jpg",
            )
    except Exception as e:
        print("⚠️ Avatar fetch failed:", e)
    return None


def _get_or_create_wallet_for_user(user, initial_balance=Decimal("0.0")):
    """
    Ensure each user has a WalletAccount aligned with user.wallet_address.

    For existing users, `initial_balance` is only used on first creation.
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

    Conceptual breakdown (on chain story):
      - Founder reserve:           400,000 ESC   (off market; not a DB wallet)
      - LP ESC side:                50,000 ESC   (in AMM vs 500 USDC)
      - Treasury supply:           500,000 ESC   (protocol / DAO)
      - Starter airdrop pool:      50,000 ESC    (subset of circulating, held by treasury for now)

    For the DB sim, this wallet holds:
      TREASURY_WALLET_INITIAL_ESC = TREASURY_SUPPLY_ESC + STARTER_ALLOCATION_ESC
      = 550,000 ESC
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
        diff = TREASURY_WALLET_INITIAL_ESC - treasury_wallet.balance
        treasury_wallet.balance = TREASURY_WALLET_INITIAL_ESC
        treasury_wallet.save(update_fields=["balance"])
        # keep u.esc_balance logically in sync as best we can
        if u.esc_balance < TREASURY_WALLET_INITIAL_ESC:
            u.esc_balance += diff
            u.save(update_fields=["esc_balance"])

    print(f"{'✅ Created' if created else 'ℹ️ Using existing'} treasury user: {u.email}")
    print(
        f"   Treasury wallet: {treasury_wallet.address} "
        f"balance={treasury_wallet.balance} ESC (treasury + starter pool)"
    )
    return u


def _create_fake_users(count=1000, domain="escdemo.local"):
    """
    Create ~count users with realistic profiles + avatars + WalletAccount.
    No public_key set → app will route to KeyScreenSetup when logging in.
    """
    users = []

    for i in range(count):
        # Decide gender first so names + avatars line up
        gender = random.choice(["female", "male"])
        if gender == "female":
            first = fake.first_name_female()
            gender_slug = "women"
        else:
            first = fake.first_name_male()
            gender_slug = "men"

        last = fake.last_name()
        base_email = f"{first.lower()}.{last.lower()}.{i}@{domain}"
        email = base_email

        # Ensure email uniqueness
        if User.objects.filter(email=email).exists():
            email = f"{first.lower()}.{last.lower()}.{i}-{uuid.uuid4().hex[:4]}@{domain}"

        wallet = _wallet_address()

        neighborhood = random.choice(NEIGHBORHOODS)
        languages = random.choice(LANGUAGE_SETS)

        # Pick an occupation profile to make skills/bio coherent
        occ = random.choice(OCCUPATION_PROFILES)
        occ_skills = occ["skills"]
        sample_skills = ", ".join(
            random.sample(occ_skills, k=min(len(occ_skills), random.randint(3, 5)))
        )

        bio_template = random.choice(occ["bio_templates"])
        bio = bio_template.format(hood=neighborhood)

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
            skills=sample_skills,
            bio=bio,
            onboarding_completed=True,
        )

        # Attach avatar image with matching gender for first N users only
        if i < MAX_AVATAR_SEED_USERS:
            avatar_content = _fetch_avatar_content(gender_slug=gender_slug)
            if avatar_content:
                u.avatar.save(avatar_content.name, avatar_content, save=True)

        # Create wallet account
        _get_or_create_wallet_for_user(u, initial_balance=Decimal("0.0"))

        users.append(u)

    print(f"✅ Created {len(users)} ESC neighbor users.")
    print("   (All seeded users use password: 'escdemo123')")
    return users


def _airdrop_esc_to_users(treasury, users):
    """
    Airdrop the starter pool:

      - Target: 50 ESC to up to 1000 wallets = 50,000 ESC capacity
      - Uses ESC_INITIAL_PRICE_USD for USD context
      - Stops once STARTER_ALLOCATION_ESC is exhausted

    Note:
      If you seed fewer users than STARTER_ACCOUNTS (for example --users=100),
      the remaining starter allocation simply stays in the treasury.
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
        f"(pool capacity {STARTER_ALLOCATION_ESC} ESC)."
    )


def _create_services_for_users(users, max_services_per_user=3):
    """
    Create services for a subset of users based on SERVICE_TEMPLATES.

    Guarantees:
      - Every SERVICE_TEMPLATES entry exists at least MIN_PER_TEMPLATE times.
    """
    services = []
    title_provider_ids = defaultdict(set)
    MIN_PER_TEMPLATE = 3  # “a few options” per service type

    if not users:
        print("⚠️ No users to attach services to.")
        return services

    # First pass: random assignment
    for u in users:
        # Not everyone offers services
        if random.random() < 0.35:
            continue

        num_services = random.randint(1, max_services_per_user)
        templates = random.sample(SERVICE_TEMPLATES, k=num_services)

        for title, category, base_price, desc in templates:
            # Slight jitter on prices
            price_jitter = Decimal(str(random.uniform(-2.0, 3.0))).quantize(Decimal("0.01"))
            final_price = max(Decimal("5.0"), base_price + price_jitter)

            s = Service.objects.create(
                user=u,
                title=title,
                description=desc,
                price=final_price,
                category=category,
            )
            services.append(s)
            title_provider_ids[title].add(u.id)

    # Second pass: ensure minimum providers per template
    for title, category, base_price, desc in SERVICE_TEMPLATES:
        current_count = len(title_provider_ids[title])
        while current_count < MIN_PER_TEMPLATE:
            candidate_users = [u for u in users if u.id not in title_provider_ids[title]]
            if not candidate_users:
                candidate_users = users  # fallback

            u = random.choice(candidate_users)

            price_jitter = Decimal(str(random.uniform(-2.0, 3.0))).quantize(Decimal("0.01"))
            final_price = max(Decimal("5.0"), base_price + price_jitter)

            s = Service.objects.create(
                user=u,
                title=title,
                description=desc,
                price=final_price,
                category=category,
            )
            services.append(s)
            title_provider_ids[title].add(u.id)
            current_count = len(title_provider_ids[title])

    print(f"✅ Created {len(services)} services across neighbors.")
    print("   Every service template has at least 3 providers.")
    return services


def _update_price_from_volume(sim_state):
    """
    Toy price curve for the neighborhood sim (internal reference only):

      price = ESC_INITIAL_PRICE_USD * (1 + SLOPE * min(volume / circulating_slice, CAP))
    """
    volume = sim_state["volume_esc"]
    if CIRCULATING_SLICE_ESC <= 0:
        return

    progress = volume / CIRCULATING_SLICE_ESC

    if progress < 0:
        progress = Decimal("0")
    if progress > PRICE_VOLUME_CAP:
        progress = PRICE_VOLUME_CAP

    factor = Decimal("1.0") + PRICE_VOLUME_SLOPE * progress
    new_price = (ESC_INITIAL_PRICE_USD * factor).quantize(Decimal("0.000001"))
    sim_state["price_usd"] = new_price


def _ensure_liquidity_for_payment(treasury, client, amount, price_usd, sim_state):
    """
    Ensure the client has enough ESC for a payment by simulating a purchase
    from the treasury if needed (with optional Sarafu style mint).

    NOTE: This represents off chain / DAO controlled liquidity.
    The on chain AMM math is handled separately below for analytics.
    """
    needed = amount - client.esc_balance
    if needed <= 0:
        return

    treasury_wallet = _get_or_create_wallet_for_user(
        treasury, initial_balance=TREASURY_WALLET_INITIAL_ESC
    )
    client_wallet = _get_or_create_wallet_for_user(client)

    # If the treasury does not have enough, optionally mint more
    if treasury.esc_balance < needed:
        if ALLOW_TREASURY_MINT:
            shortfall = needed - treasury.esc_balance
            mint_amount = (shortfall * TREASURY_MINT_BUFFER_MULTIPLIER).quantize(
                Decimal("0.0000")
            )
            if mint_amount > 0:
                treasury.esc_balance += mint_amount
                treasury_wallet.balance += mint_amount
                treasury.save(update_fields=["esc_balance"])
                treasury_wallet.save(update_fields=["balance"])

                sim_state.setdefault("minted_esc", Decimal("0.0"))
                sim_state["minted_esc"] += mint_amount
        else:
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

    # Simulated on ramp
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


def _simulate_dex_topup_for_user(user, sim_state, _price_usd_unused, target_esc_amount):
    """
    When a user's wallet balance falls to or below the configured threshold,
    simulate one or more constant-product AMM buys in fixed USDC chunks
    (for example 5 USD each) until we roughly hit `target_esc_amount`
    of new ESC for that user.

    This uses an internal AMM pool stored in sim_state:

      - dex_amm_esc_reserve
      - dex_amm_usdc_reserve
      - dex_amm_k

    It updates that pool as if users are really buying from the DEX.
    Treasury balances are not touched here.
    """
    if target_esc_amount <= 0:
        return

    wallet = _get_or_create_wallet_for_user(user)

    # If they are already comfortably above threshold + target, skip
    if wallet.balance >= WALLET_TOPUP_THRESHOLD_ESC + target_esc_amount:
        return

    esc_reserve = sim_state.get("dex_amm_esc_reserve", LP_ESC)
    usdc_reserve = sim_state.get("dex_amm_usdc_reserve", LP_USDC)
    k = sim_state.get("dex_amm_k", esc_reserve * usdc_reserve)

    dex_trade_size_usd = sim_state.get("dex_trade_size_usd", Decimal("5"))
    if dex_trade_size_usd <= 0:
        dex_trade_size_usd = Decimal("5")

    total_esc_bought = Decimal("0.0")
    total_usdc_spent = Decimal("0.0")

    MAX_TRADES_PER_TOPUP = 40  # keep one drained wallet from eating the whole pool

    for _ in range(MAX_TRADES_PER_TOPUP):
        if total_esc_bought >= target_esc_amount:
            break
        if wallet.balance >= WALLET_TOPUP_THRESHOLD_ESC + target_esc_amount:
            break

        if esc_reserve <= 0 or usdc_reserve <= 0:
            break

        current_price = usdc_reserve / esc_reserve
        if current_price <= 0:
            break

        usdc_in = dex_trade_size_usd
        new_usdc_reserve = usdc_reserve + usdc_in
        new_esc_reserve = k / new_usdc_reserve
        esc_out = esc_reserve - new_esc_reserve

        if esc_out <= 0:
            break

        # Update pool
        esc_reserve = new_esc_reserve
        usdc_reserve = new_usdc_reserve
        k = esc_reserve * usdc_reserve

        # Credit user
        user.esc_balance += esc_out
        wallet.balance += esc_out
        user.save(update_fields=["esc_balance"])
        wallet.save(update_fields=["balance"])

        total_esc_bought += esc_out
        total_usdc_spent += usdc_in

        sim_state["dex_topups_count"] = sim_state.get("dex_topups_count", 0) + 1
        sim_state["dex_topups_esc"] = sim_state.get("dex_topups_esc", Decimal("0.0")) + esc_out
        sim_state["dex_topups_usdc"] = sim_state.get("dex_topups_usdc", Decimal("0.0")) + usdc_in

    # Save updated pool back to sim_state for later topups
    sim_state["dex_amm_esc_reserve"] = esc_reserve
    sim_state["dex_amm_usdc_reserve"] = usdc_reserve
    sim_state["dex_amm_k"] = k


def _create_bookings_and_payments(
    services,
    users,
    treasury,
    sim_state,
    target_payments=1000,
    window_days=180,
    until_target=False,
):
    """
    Create bookings between neighbors and simulate payments.

    This uses the toy neighborhood price curve. The real AMM math
    is computed separately after this via `_run_amm_price_sim`.

    Extra behavior:
      - Track wallets that fall below the configured threshold
      - When a wallet hits that threshold, simulate a DEX buy to top it back up
        using a constant-product AMM pool living in sim_state.
    """
    if not services or len(users) < 2:
        print("⚠️ Not enough services/users to create bookings.")
        return

    now = timezone.now()
    bookings_created = 0
    payments_created = 0

    target_price = sim_state.get("target_price_usd", Decimal("0.0")) or Decimal("0.0")

    # Safety cap: allow more turns if we are running "until target"
    if until_target and target_payments < 1_000_000:
        max_iterations = max(target_payments * 20, 100000)
    else:
        max_iterations = target_payments * 5  # default cap

    with db_transaction.atomic():
        for _ in range(max_iterations):
            if payments_created >= target_payments and not until_target:
                break
            if until_target and sim_state.get("hit_target"):
                break

            s = random.choice(services)
            provider = s.user

            if len(users) == 1:
                continue
            client = provider
            safety_spin = 0
            while client.id == provider.id and safety_spin < 5:
                client = random.choice(users)
                safety_spin += 1
            if client.id == provider.id:
                continue

            provider_wallet = _get_or_create_wallet_for_user(provider)
            client_wallet = _get_or_create_wallet_for_user(client)

            # Random time within [-window_days, 0]
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

            b = Booking.objects.create(
                service=s,
                provider=provider,
                client=client,
                start_at=start_at,
                end_at=end_at,
                status=Booking.Status.COMPLETED,
                price_snapshot=s.price,
                currency="ESC",
                notes="Auto-generated booking for ESC neighborhood sim.",
            )
            bookings_created += 1

            amount = s.price.quantize(Decimal("0.0001"))

            # Ensure client has enough ESC
            price_usd = sim_state["price_usd"]
            _ensure_liquidity_for_payment(treasury, client, amount, price_usd, sim_state)

            if client.esc_balance < amount:
                continue

            # 1 percent burn
            burn_rate = Decimal("0.01")
            burn_amount = (amount * burn_rate).quantize(Decimal("0.0000"))
            net_to_provider = amount - burn_amount

            if net_to_provider <= 0:
                continue

            # Update sim_state aggregates BEFORE price recalculation
            sim_state["tx_count"] += 1
            sim_state["volume_esc"] += amount
            sim_state["burned_esc"] += burn_amount

            # Update internal reference price from cumulative volume
            _update_price_from_volume(sim_state)
            price_usd = sim_state["price_usd"]
            amount_usd = (net_to_provider * price_usd).quantize(Decimal("0.0000"))

            # Move balances (user)
            client.esc_balance -= amount
            provider.esc_balance += net_to_provider
            client.save(update_fields=["esc_balance"])
            provider.save(update_fields=["esc_balance"])

            # Move balances (WalletAccount)
            client_wallet.balance -= amount
            provider_wallet.balance += net_to_provider
            client_wallet.save(update_fields=["balance"])
            provider_wallet.save(update_fields=["balance"])

            # If the client wallet balance fell at or below the threshold from this payment,
            # record it and simulate AMM-based DEX buys to top them back up.
            if client_wallet.balance <= WALLET_TOPUP_THRESHOLD_ESC:
                sim_state["wallet_zero_events"] = sim_state.get("wallet_zero_events", 0) + 1
                _simulate_dex_topup_for_user(
                    client,
                    sim_state,
                    price_usd,
                    STARTER_PER_ACCOUNT_ESC,  # target ~50 ESC topup via multiple 5 USD buys
                )

            tx = Transaction.objects.create(
                sender=client,
                receiver=provider,
                amount=net_to_provider,
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

            # Low level ledger entry
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

            # Track when we first hit or cross the neighborhood target price
            if (
                target_price > 0
                and not sim_state.get("hit_target")
                and price_usd >= target_price
            ):
                sim_state["hit_target"] = True
                sim_state["hit_target_price_usd"] = price_usd
                sim_state["hit_target_tx"] = sim_state["tx_count"]
                sim_state["hit_target_volume_esc"] = sim_state["volume_esc"]
                sim_state["hit_target_burned_esc"] = sim_state["burned_esc"]
                sim_state["hit_target_onramp_esc"] = sim_state.get("onramp_esc", Decimal("0.0"))
                sim_state["hit_target_onramp_usd"] = sim_state.get("onramp_usd", Decimal("0.0"))

                print(
                    f"🎯 Target (neighborhood curve) reached: ${price_usd} ≥ ${target_price} "
                    f"after {sim_state['tx_count']} payments, "
                    f"volume={sim_state['volume_esc']} ESC."
                )

                if until_target:
                    continue

    print(f"✅ Created {bookings_created} bookings total.")
    print(f"✅ Created {payments_created} completed payments linked to bookings.")
    print(
        f"📈 Sim volume: {sim_state['volume_esc']} ESC across {sim_state['tx_count']} payments."
    )
    print(f"🔥 Total burned (1% fee): {sim_state['burned_esc']} ESC.")
    print(f"💵 Final neighborhood reference price: ${sim_state['price_usd']} per ESC.")

    if CIRCULATING_SLICE_ESC > 0:
        progress = sim_state["volume_esc"] / CIRCULATING_SLICE_ESC
        try:
            progress_float = float(progress)
        except Exception:
            progress_float = 0.0
        print(
            f"🔍 Volume vs early circulating slice: ~{progress_float:.2f}× "
            f"(slope={PRICE_VOLUME_SLOPE}, cap={PRICE_VOLUME_CAP})."
        )

    if "onramp_esc" in sim_state:
        print(
            f"🏦 On ramped (treasury off chain): {sim_state['onramp_esc']} ESC "
            f"(~${sim_state.get('onramp_usd', Decimal('0.0'))} USD simulated in)."
        )
    if "minted_esc" in sim_state:
        print(f"🪙 Protocol-minted during sim: {sim_state['minted_esc']} ESC.")

    if sim_state.get("wallet_zero_events", 0) > 0:
        print(
            f"🧮 Wallet threshold events: {sim_state['wallet_zero_events']} "
            f"wallets hit ≤ {WALLET_TOPUP_THRESHOLD_ESC} ESC and triggered DEX top ups."
        )
    if sim_state.get("dex_topups_count", 0) > 0:
        print(
            f"🪙 Simulated DEX top ups: {sim_state['dex_topups_count']} buys "
            f"→ {sim_state['dex_topups_esc']} ESC purchased for "
            f"≈ ${sim_state['dex_topups_usdc']} USDC."
        )

    target_price = sim_state.get("target_price_usd", Decimal("0.0")) or Decimal("0.0")
    if target_price > 0:
        if sim_state.get("hit_target"):
            vol_at_hit = sim_state.get("hit_target_volume_esc", Decimal("0.0"))
            tx_at_hit = sim_state.get("hit_target_tx", 0)
            try:
                multiple = float(vol_at_hit / CIRCULATING_SLICE_ESC) if CIRCULATING_SLICE_ESC > 0 else 0.0
            except Exception:
                multiple = 0.0
            print(
                f"🎯 Neighborhood curve summary: target ${target_price} reached at tx #{tx_at_hit}, "
                f"volume={vol_at_hit} ESC (~{multiple:.2f}× early circulating slice)."
            )
        else:
            print(
                f"⚠️ Neighborhood target price ${target_price} NOT reached within this sim "
                f"(final ${sim_state['price_usd']}))."
            )


# ================================================================
# 🔥 REAL AMM MATH (CONSTANT PRODUCT LP) FOR ESC/USDC
# ================================================================
def _run_amm_price_sim(
    lp_esc,
    lp_usdc,
    trade_size_usd,
    target_price,
    max_trades,
    circulating_esc,
    injection_specs,
    stdout,
    style,
    sim_state,
):
    """
    Simulate a constant product AMM (x*y=k) for ESC/USDC.

    - lp_esc / lp_usdc: initial reserves
    - trade_size_usd: USDC per buy
    - target_price: ESC price target (USDC/ESC)
    - max_trades: safety cap
    - circulating_esc: for implied market cap
    - injection_specs: list of strings "price,usdc,esc"
    """
    esc_reserve = Decimal(lp_esc)
    usdc_reserve = Decimal(lp_usdc)
    trade_size_usd = Decimal(trade_size_usd)
    target_price = Decimal(target_price)
    max_trades = int(max_trades)
    circulating_esc = Decimal(circulating_esc)

    if trade_size_usd <= 0:
        stdout.write(style.ERROR("AMM: trade_size_usd must be > 0"))
        return

    if target_price <= 0:
        stdout.write(style.ERROR("AMM: target_price must be > 0"))
        return

    # Parse injections
    injections = []
    for raw in injection_specs:
        try:
            price_str, usdc_str, esc_str = raw.split(",")
            inj = {
                "price_trigger": Decimal(price_str),
                "usdc": Decimal(usdc_str),
                "esc": Decimal(esc_str),
                "applied": False,
            }
            if inj["price_trigger"] <= 0:
                raise ValueError("price_trigger must be > 0")
            injections.append(inj)
        except Exception as e:
            stdout.write(
                style.ERROR(
                    f"AMM: Could not parse --amm-inject '{raw}'. "
                    f"Expected 'price,usdc,esc'. Error: {e}"
                )
            )

    injections.sort(key=lambda inj: inj["price_trigger"])

    k = esc_reserve * usdc_reserve
    initial_price = usdc_reserve / esc_reserve

    total_usdc_in = Decimal("0")
    total_esc_out = Decimal("0")
    trades = 0

    stdout.write("")
    stdout.write(style.WARNING("🔁 AMM ESC/USDC simulation (constant-product) starting..."))
    stdout.write(
        f"   → Initial pool: {esc_reserve} ESC vs {usdc_reserve} USDC "
        f"(price=${initial_price:.6f} / ESC)"
    )
    stdout.write(
        f"   → Target AMM price: ${target_price} / ESC, trade size={trade_size_usd} USDC per buy"
    )
    if injections:
        stdout.write("   → LP injections configured:")
        for inj in injections:
            stdout.write(
                f"      - when AMM price ≥ ${inj['price_trigger']} add "
                f"{inj['usdc']} USDC and {inj['esc']} ESC"
            )

    for i in range(1, max_trades + 1):
        current_price = usdc_reserve / esc_reserve

        # Apply LP injections when price triggers are hit
        for inj in injections:
            if not inj["applied"] and current_price >= inj["price_trigger"]:
                esc_reserve += inj["esc"]
                usdc_reserve += inj["usdc"]
                k = esc_reserve * usdc_reserve
                inj["applied"] = True
                stdout.write(
                    style.SUCCESS(
                        f"💧 LP injection at AMM trade #{i}: price=${current_price:.6f} "
                        f"→ added {inj['usdc']} USDC and {inj['esc']} ESC. "
                        f"New pool: {esc_reserve} ESC vs {usdc_reserve} USDC."
                    )
                )

        current_price = usdc_reserve / esc_reserve
        if current_price >= target_price:
            break

        # Simulate one buy: trader sends trade_size_usd USDC, receives ESC
        usdc_in = trade_size_usd
        new_usdc_reserve = usdc_reserve + usdc_in
        new_esc_reserve = k / new_usdc_reserve
        esc_out = esc_reserve - new_esc_reserve

        if esc_out <= 0:
            stdout.write(style.ERROR("AMM: esc_out <= 0, aborting."))
            break

        usdc_reserve = new_usdc_reserve
        esc_reserve = new_esc_reserve
        k = esc_reserve * usdc_reserve

        total_usdc_in += usdc_in
        total_esc_out += esc_out
        trades = i

    final_price = usdc_reserve / esc_reserve
    implied_market_cap = circulating_esc * final_price

    stdout.write("")
    stdout.write(style.SUCCESS("✅ AMM ESC/USDC simulation complete."))
    stdout.write(
        f"📊 AMM final pool: {esc_reserve:.6f} ESC vs {usdc_reserve:.6f} USDC "
        f"(price=${final_price:.6f} / ESC)"
    )
    stdout.write(f"   AMM trades executed: {trades}")
    stdout.write(f"   Total USDC into pool:   ${total_usdc_in:.2f}")
    stdout.write(f"   Total ESC out of pool:  {total_esc_out:.6f} ESC")
    stdout.write(
        f"   AMM implied market cap (circulating {circulating_esc} ESC): "
        f"≈ ${implied_market_cap:.2f}"
    )

    if final_price >= target_price:
        stdout.write(
            style.SUCCESS(
                f"🎯 AMM target price ${target_price} reached or exceeded "
                f"(final ${final_price:.6f})."
            )
        )
    else:
        stdout.write(
            style.WARNING(
                f"⚠️ AMM target price ${target_price} NOT reached within {max_trades} trades "
                f"(final ${final_price:.6f})."
            )
        )

    # Save into sim_state for introspection / snapshots
    sim_state["amm_initial_price_usd"] = initial_price
    sim_state["amm_final_price_usd"] = final_price
    sim_state["amm_trades"] = trades
    sim_state["amm_total_usdc_in"] = total_usdc_in
    sim_state["amm_total_esc_out"] = total_esc_out
    sim_state["amm_implied_market_cap_usd"] = implied_market_cap


class Command(BaseCommand):
    help = "Seed ESC neighborhood with fake users, avatars, services, bookings, and payments + neighborhood and AMM price sims."

    def add_arguments(self, parser):
        parser.add_argument(
            "--users",
            type=int,
            default=1000,
            help="Number of neighbor users to create (default: 1000).",
        )
        parser.add_argument(
            "--target-payments",
            type=int,
            default=1000,
            help="Approximate number of completed payments to simulate (default: 1000).",
        )
        parser.add_argument(
            "--window-days",
            type=int,
            default=180,
            help="Look-back window in days for simulated activity (default: 180 ≈ 6 months).",
        )
        # Neighborhood price curve controls (start price stays 0.01)
        parser.add_argument(
            "--price-slope",
            type=str,
            default=str(PRICE_VOLUME_SLOPE),
            help="Neighborhood price curve slope vs volume/circulating (default 6).",
        )
        parser.add_argument(
            "--price-cap",
            type=str,
            default=str(PRICE_VOLUME_CAP),
            help="Max volume/circ multiplier before price curve flattens (default 20).",
        )
        parser.add_argument(
            "--target-price",
            type=str,
            default="0",
            help="Target neighborhood reference price in USD (for example 1.00). 0 means no target.",
        )
        parser.add_argument(
            "--until-target",
            action="store_true",
            help="If set and target-price>0, keep simulating until neighborhood target price is reached (or safety cap).",
        )

        # Real AMM / LP simulation controls
        parser.add_argument(
            "--amm-trade-size-usd",
            type=str,
            default="5",
            help="USDC trade size per AMM buy for ESC (default 5).",
        )
        parser.add_argument(
            "--amm-target-price",
            type=str,
            default="1.00",
            help="AMM ESC price target in USD (default 1.00).",
        )
        parser.add_argument(
            "--amm-max-trades",
            type=int,
            default=200000,
            help="Max number of AMM trades to simulate (default 200000).",
        )
        parser.add_argument(
            "--amm-circulating-esc",
            type=str,
            default=str(CIRCULATING_SLICE_ESC),
            help="Circulating ESC used for AMM implied market cap (default early slice).",
        )
        parser.add_argument(
            "--amm-inject",
            dest="amm_inject",
            action="append",
            type=str,
            metavar="PRICE,USDC,ESC",
            default=[],
            help=(
                "Optional AMM LP injection in the form 'price,usdc,esc'. "
                "Example: --amm-inject \"0.20,500,50000\" "
                "(when AMM price ≥ 0.20, add 500 USDC and 50000 ESC). "
                "You can pass this flag multiple times."
            ),
        )

        # Hypothetical extra mint controls (valuation only)
        parser.add_argument(
            "--extra-mint-esc",
            type=str,
            default="0",
            help=(
                "Hypothetical extra ESC minted AFTER this sim (for example 9000000). "
                "Used only for valuation; does NOT change seeding or AMM math."
            ),
        )
        parser.add_argument(
            "--extra-mint-split",
            type=str,
            default="treasury",
            choices=["treasury", "founder", "split"],
            help=(
                "How to hypothetically allocate the extra-minted ESC: "
                "'treasury' (all to treasury), 'founder' (all to founder reserve), "
                "or 'split' (50/50). Default: treasury."
            ),
        )

        # CSV metrics export
        parser.add_argument(
            "--metrics-csv",
            type=str,
            default="",
            help=(
                "Optional path to a CSV file where summary metrics for this run "
                "will be appended as a single row."
            ),
        )

    def handle(self, *args, **options):
        global PRICE_VOLUME_SLOPE, PRICE_VOLUME_CAP

        count = options["users"]
        target_payments = options["target_payments"]
        window_days = options["window_days"]

        metrics_csv_path = options.get("metrics_csv") or ""

        # Neighborhood curve overrides
        PRICE_VOLUME_SLOPE = Decimal(options["price_slope"])
        PRICE_VOLUME_CAP = Decimal(options["price_cap"])

        target_price = Decimal(options["target_price"])
        until_target = bool(options.get("until_target"))

        self.stdout.write(self.style.WARNING("🚧 Seeding ESC neighborhood demo data..."))
        self.stdout.write(
            f"   → users={count}, target_payments≈{target_payments}, window_days={window_days}"
        )
        self.stdout.write(
            f"   → neighborhood curve: start_price={ESC_INITIAL_PRICE_USD}, "
            f"slope={PRICE_VOLUME_SLOPE}, cap={PRICE_VOLUME_CAP}"
        )
        if target_price > 0:
            self.stdout.write(
                f"   → neighborhood target price: ${target_price} "
                f"(until_target={'on' if until_target else 'off'})"
            )
        self.stdout.write(
            f"   → DEX top ups enabled: threshold={WALLET_TOPUP_THRESHOLD_ESC} ESC, "
            f"top up size={STARTER_PER_ACCOUNT_ESC} ESC per event, "
            f"AMM buy size from CLI --amm-trade-size-usd."
        )

        # Global sim state
        sim_state = {
            "initial_price_usd": ESC_INITIAL_PRICE_USD,
            "price_usd": ESC_INITIAL_PRICE_USD,
            "volume_esc": Decimal("0.0"),
            "tx_count": 0,
            "burned_esc": Decimal("0.0"),
            "onramp_esc": Decimal("0.0"),
            "onramp_usd": Decimal("0.0"),
            "minted_esc": Decimal("0.0"),
            "target_price_usd": target_price,
            "hit_target": False,
            "hit_target_price_usd": None,
            "hit_target_tx": None,
            "hit_target_volume_esc": None,
            "hit_target_burned_esc": None,
            "hit_target_onramp_esc": None,
            "hit_target_onramp_usd": None,
            # DEX + wallet drain analytics
            "wallet_zero_events": 0,
            "dex_topups_count": 0,
            "dex_topups_esc": Decimal("0.0"),
            "dex_topups_usdc": Decimal("0.0"),
        }

        # Initialize in-sim DEX AMM pool used for wallet topup buys (user behavior)
        try:
            dex_trade_size_usd = Decimal(options["amm_trade_size_usd"])
        except Exception:
            dex_trade_size_usd = Decimal("5")
        if dex_trade_size_usd <= 0:
            dex_trade_size_usd = Decimal("5")

        sim_state.update({
            "dex_amm_esc_reserve": LP_ESC,
            "dex_amm_usdc_reserve": LP_USDC,
            "dex_amm_k": LP_ESC * LP_USDC,
            "dex_trade_size_usd": dex_trade_size_usd,
        })

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
            until_target=until_target,
        )

        # Founder reserve value tracking (using theoretical reserve, ignoring mint)
        founder_initial_value = (FOUNDER_RESERVE_ESC * sim_state["initial_price_usd"]).quantize(
            Decimal("0.01")
        )
        founder_final_value = (FOUNDER_RESERVE_ESC * sim_state["price_usd"]).quantize(
            Decimal("0.01")
        )

        # Effective total supply if protocol minted during sim
        effective_total_supply = TOTAL_SUPPLY_ESC + sim_state.get("minted_esc", Decimal("0.0"))

        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS("✅ ESC neighborhood seeding complete."))
        self.stdout.write(
            f"🏦 Effective total supply (base + minted): {effective_total_supply} ESC "
            f"(base {TOTAL_SUPPLY_ESC} ESC + minted {sim_state.get('minted_esc', Decimal('0.0'))} ESC)."
        )
        self.stdout.write(
            f"👑 Founder reserve: {FOUNDER_RESERVE_ESC} ESC "
            f"(initial ${sim_state['initial_price_usd']} → ${sim_state['price_usd']} per ESC)"
        )
        self.stdout.write(
            f"   Value at start : ${founder_initial_value} USD\n"
            f"   Value after sim: ${founder_final_value} USD"
        )

        # Circulating / market cap stats (excluding treasury as "off market" holder)
        circ_ex_treasury = (
            User.objects.exclude(id=treasury.id)
            .aggregate(total=Sum("esc_balance"))["total"]
            or Decimal("0.0")
        )

        market_cap_initial = (CIRCULATING_SLICE_ESC * sim_state["initial_price_usd"]).quantize(
            Decimal("0.01")
        )
        market_cap_final = (circ_ex_treasury * sim_state["price_usd"]).quantize(
            Decimal("0.01")
        )

        self.stdout.write(
            f"💫 Circulating (ex treasury) after neighborhood sim: {circ_ex_treasury} ESC "
            f"→ implied neighborhood market cap ≈ ${market_cap_final}."
        )
        self.stdout.write(
            f"   For comparison, early circulating slice {CIRCULATING_SLICE_ESC} ESC "
            f"at start price gave ≈ ${market_cap_initial}."
        )

        if sim_state.get("minted_esc", Decimal("0.0")) > 0:
            self.stdout.write(
                self.style.WARNING(
                    f"🪙 Protocol minted {sim_state['minted_esc']} ESC during the sim "
                    "(Sarafu style flexible supply)."
                )
            )

        if sim_state.get("wallet_zero_events", 0) > 0:
            self.stdout.write(
                self.style.WARNING(
                    f"🧮 Wallet threshold events during neighborhood sim: "
                    f"{sim_state['wallet_zero_events']} wallets hit "
                    f"≤ {WALLET_TOPUP_THRESHOLD_ESC} ESC and triggered DEX top ups."
                )
            )
        if sim_state.get("dex_topups_count", 0) > 0:
            self.stdout.write(
                self.style.SUCCESS(
                    f"🪙 Simulated DEX top ups during neighborhood sim: "
                    f"{sim_state['dex_topups_count']} buys → "
                    f"{sim_state['dex_topups_esc']} ESC for ≈ ${sim_state['dex_topups_usdc']} USDC."
                )
            )

        if target_price > 0:
            if sim_state.get("hit_target"):
                vol_at_hit = sim_state.get("hit_target_volume_esc", Decimal("0.0"))
                tx_at_hit = sim_state.get("hit_target_tx", 0)
                try:
                    multiple = float(vol_at_hit / CIRCULATING_SLICE_ESC) if CIRCULATING_SLICE_ESC > 0 else 0.0
                except Exception:
                    multiple = 0.0
                self.stdout.write(
                    self.style.SUCCESS(
                        f"🎯 Neighborhood curve target ${target_price} reached at tx #{tx_at_hit}, "
                        f"volume={vol_at_hit} ESC (~{multiple:.2f}× early circulating slice)."
                    )
                )
            else:
                self.stdout.write(
                    self.style.WARNING(
                        f"⚠️ Neighborhood target price ${target_price} NOT reached in this run "
                        f"(final ${sim_state['price_usd']} per ESC)."
                    )
                )

        # Real AMM / LP standalone simulation
        amm_trade_size_usd = options["amm_trade_size_usd"]
        amm_target_price = options["amm_target_price"]
        amm_max_trades = options["amm_max_trades"]
        amm_circ_esc = options["amm_circulating_esc"] or str(CIRCULATING_SLICE_ESC)
        amm_inject_specs = options.get("amm_inject") or []

        _run_amm_price_sim(
            lp_esc=LP_ESC,
            lp_usdc=LP_USDC,
            trade_size_usd=amm_trade_size_usd,
            target_price=amm_target_price,
            max_trades=amm_max_trades,
            circulating_esc=amm_circ_esc,
            injection_specs=amm_inject_specs,
            stdout=self.stdout,
            style=self.style,
            sim_state=sim_state,
        )

        # Hypothetical future mint scenario
        extra_mint_raw = options.get("extra_mint_esc", "0") or "0"
        extra_mint_split = options.get("extra_mint_split", "treasury")
        try:
            extra_mint_esc = Decimal(extra_mint_raw)
        except Exception:
            extra_mint_esc = Decimal("0")

        price_now = sim_state["price_usd"]

        # Defaults if no extra mint
        hypothetical_treasury_balance = treasury.esc_balance
        hypothetical_founder_reserve = FOUNDER_RESERVE_ESC
        hypothetical_total_supply = effective_total_supply
        hypothetical_treasury_value_usd = (hypothetical_treasury_balance * price_now).quantize(
            Decimal("0.01")
        )
        hypothetical_founder_value_usd = (hypothetical_founder_reserve * price_now).quantize(
            Decimal("0.01")
        )

        if extra_mint_esc > 0:
            base_treasury_balance = treasury.esc_balance
            base_founder_reserve = FOUNDER_RESERVE_ESC

            extra_to_treasury = Decimal("0")
            extra_to_founder = Decimal("0")

            if extra_mint_split == "founder":
                extra_to_founder = extra_mint_esc
            elif extra_mint_split == "split":
                half = (extra_mint_esc / Decimal("2")).quantize(Decimal("0.0000"))
                extra_to_treasury = half
                extra_to_founder = extra_mint_esc - half
            else:
                extra_to_treasury = extra_mint_esc

            hypothetical_treasury_balance = base_treasury_balance + extra_to_treasury
            hypothetical_founder_reserve = base_founder_reserve + extra_to_founder
            hypothetical_total_supply = effective_total_supply + extra_mint_esc

            hypothetical_treasury_value_usd = (hypothetical_treasury_balance * price_now).quantize(
                Decimal("0.01")
            )
            hypothetical_founder_value_usd = (hypothetical_founder_reserve * price_now).quantize(
                Decimal("0.01")
            )

            self.stdout.write("")
            self.stdout.write(self.style.WARNING("🧪 Hypothetical extra-mint scenario"))
            self.stdout.write(
                f"   Extra mint (not in this DB run): {extra_mint_esc} ESC "
                f"(split='{extra_mint_split}')"
            )
            self.stdout.write(
                f"   Hypothetical total supply: {hypothetical_total_supply} ESC "
                f"(effective {effective_total_supply} + extra {extra_mint_esc})"
            )
            self.stdout.write(
                f"   Hypothetical treasury balance: {hypothetical_treasury_balance} ESC "
                f"→ ≈ ${hypothetical_treasury_value_usd} at price ${price_now} / ESC"
            )
            self.stdout.write(
                f"   Hypothetical founder reserve: {hypothetical_founder_reserve} ESC "
                f"→ ≈ ${hypothetical_founder_value_usd} at price ${price_now} / ESC"
            )

        # Optional: summary model write
        try:
            EscEconomySnapshot = apps.get_model("app", "EscEconomySnapshot")
        except LookupError:
            EscEconomySnapshot = None

        now = timezone.now()
        window_start = now - timedelta(days=window_days)
        window_end = now

        if EscEconomySnapshot:
            circ = (
                User.objects.aggregate(total=Sum("esc_balance"))["total"]
                or Decimal("0.0")
            )

            snapshot_kwargs = {
                "label": f"demo_{now:%Y%m%d_%H%M}",
                "total_supply_esc": TOTAL_SUPPLY_ESC,
                "founder_reserve_esc": FOUNDER_RESERVE_ESC,
                "circulating_slice_esc": CIRCULATING_SLICE_ESC,
                "lp_esc": LP_ESC,
                "lp_usdc": LP_USDC,
                "price_initial_usd": sim_state["initial_price_usd"],
                "price_final_usd": sim_state["price_usd"],
                "burned_esc": sim_state["burned_esc"],
                "volume_esc": sim_state["volume_esc"],
                "tx_count": sim_state["tx_count"],
                "onramp_esc": sim_state["onramp_esc"],
                "onramp_usd": sim_state["onramp_usd"],
                "circulating_supply_esc": circ,
                "holder_count": User.objects.filter(esc_balance__gt=0).count(),
                "window_start": window_start,
                "window_end": window_end,
                # AMM analytics
                "amm_initial_price_usd": sim_state.get("amm_initial_price_usd"),
                "amm_final_price_usd": sim_state.get("amm_final_price_usd"),
                "amm_trades": sim_state.get("amm_trades"),
                "amm_total_usdc_in": sim_state.get("amm_total_usdc_in"),
                "amm_total_esc_out": sim_state.get("amm_total_esc_out"),
                "amm_implied_market_cap_usd": sim_state.get("amm_implied_market_cap_usd"),
            }

            snapshot_field_names = [f.name for f in EscEconomySnapshot._meta.get_fields()]

            if "minted_esc" in snapshot_field_names:
                snapshot_kwargs["minted_esc"] = sim_state["minted_esc"]

            if "wallet_zero_events" in snapshot_field_names:
                snapshot_kwargs["wallet_zero_events"] = sim_state.get("wallet_zero_events", 0)
            if "dex_topups_count" in snapshot_field_names:
                snapshot_kwargs["dex_topups_count"] = sim_state.get("dex_topups_count", 0)
            if "dex_topups_esc" in snapshot_field_names:
                snapshot_kwargs["dex_topups_esc"] = sim_state.get("dex_topups_esc", Decimal("0.0"))
            if "dex_topups_usdc" in snapshot_field_names:
                snapshot_kwargs["dex_topups_usdc"] = sim_state.get("dex_topups_usdc", Decimal("0.0"))

            snapshot = EscEconomySnapshot.objects.create(**snapshot_kwargs)

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
                    "ℹ️ EscEconomySnapshot model not found. Skipping summary row. "
                    "Add it in app.models if you want persistent sim stats."
                )
            )

        # CSV export of metrics if requested
        if metrics_csv_path:
            label = f"demo_{now:%Y%m%d_%H%M}"
            fieldnames = [
                "label",
                "created_at",
                "users",
                "target_payments",
                "window_days",
                "price_slope",
                "price_cap",
                "neighborhood_target_price",
                "neighborhood_until_target",
                "initial_price_usd",
                "final_price_usd",
                "tx_count",
                "volume_esc",
                "burned_esc",
                "onramp_esc",
                "onramp_usd",
                "minted_esc",
                "effective_total_supply",
                "circ_ex_treasury_esc",
                "market_cap_initial_usd",
                "market_cap_final_usd",
                "wallet_zero_events",
                "dex_topups_count",
                "dex_topups_esc",
                "dex_topups_usdc",
                "amm_initial_price_usd",
                "amm_final_price_usd",
                "amm_trades",
                "amm_total_usdc_in",
                "amm_total_esc_out",
                "amm_implied_market_cap_usd",
                "extra_mint_esc",
                "extra_mint_split",
                "hypothetical_total_supply",
                "hypothetical_treasury_balance",
                "hypothetical_treasury_value_usd",
                "hypothetical_founder_reserve",
                "hypothetical_founder_value_usd",
            ]

            metrics_row = {
                "label": label,
                "created_at": now.isoformat(),
                "users": str(count),
                "target_payments": str(target_payments),
                "window_days": str(window_days),
                "price_slope": str(PRICE_VOLUME_SLOPE),
                "price_cap": str(PRICE_VOLUME_CAP),
                "neighborhood_target_price": str(target_price),
                "neighborhood_until_target": str(until_target),
                "initial_price_usd": str(sim_state["initial_price_usd"]),
                "final_price_usd": str(sim_state["price_usd"]),
                "tx_count": str(sim_state["tx_count"]),
                "volume_esc": str(sim_state["volume_esc"]),
                "burned_esc": str(sim_state["burned_esc"]),
                "onramp_esc": str(sim_state["onramp_esc"]),
                "onramp_usd": str(sim_state["onramp_usd"]),
                "minted_esc": str(sim_state.get("minted_esc", Decimal("0.0"))),
                "effective_total_supply": str(effective_total_supply),
                "circ_ex_treasury_esc": str(circ_ex_treasury),
                "market_cap_initial_usd": str(market_cap_initial),
                "market_cap_final_usd": str(market_cap_final),
                "wallet_zero_events": str(sim_state.get("wallet_zero_events", 0)),
                "dex_topups_count": str(sim_state.get("dex_topups_count", 0)),
                "dex_topups_esc": str(sim_state.get("dex_topups_esc", Decimal("0.0"))),
                "dex_topups_usdc": str(sim_state.get("dex_topups_usdc", Decimal("0.0"))),
                "amm_initial_price_usd": str(sim_state.get("amm_initial_price_usd", "")),
                "amm_final_price_usd": str(sim_state.get("amm_final_price_usd", "")),
                "amm_trades": str(sim_state.get("amm_trades", "")),
                "amm_total_usdc_in": str(sim_state.get("amm_total_usdc_in", "")),
                "amm_total_esc_out": str(sim_state.get("amm_total_esc_out", "")),
                "amm_implied_market_cap_usd": str(sim_state.get("amm_implied_market_cap_usd", "")),
                "extra_mint_esc": str(extra_mint_esc),
                "extra_mint_split": extra_mint_split,
                "hypothetical_total_supply": str(hypothetical_total_supply),
                "hypothetical_treasury_balance": str(hypothetical_treasury_balance),
                "hypothetical_treasury_value_usd": str(hypothetical_treasury_value_usd),
                "hypothetical_founder_reserve": str(hypothetical_founder_reserve),
                "hypothetical_founder_value_usd": str(hypothetical_founder_value_usd),
            }

            file_exists = os.path.exists(metrics_csv_path)
            with open(metrics_csv_path, "a", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                if not file_exists or os.stat(metrics_csv_path).st_size == 0:
                    writer.writeheader()
                writer.writerow(metrics_row)

            self.stdout.write(
                self.style.SUCCESS(
                    f"🧾 Metrics CSV row appended to {metrics_csv_path}"
                )
            )
