import random
import uuid
from datetime import timedelta
from decimal import Decimal
from collections import defaultdict

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

fake = Faker("en_US")

# ================================================================
# ESC TOKENOMICS + LP / PRICE SIM CONSTANTS
# ================================================================

TOTAL_SUPPLY_ESC = Decimal("1000000")      # 1,000,000 ESC (theoretical base supply)
FOUNDER_RESERVE_ESC = Decimal("400000")    # long-term founder / movement reserve

# For phase 1 we conceptually want:
#  - 50,000 ESC in the LP (vs USDC)
#  - 100,000 ESC available for starter airdrops (1000×100 ESC)
#  → 150,000 ESC early circulating slice (LP + airdrops)
LP_ESC = Decimal("50000")                  # LP side
STARTER_ACCOUNTS = 1000
STARTER_PER_ACCOUNT_ESC = Decimal("100")
STARTER_ALLOCATION_ESC = STARTER_PER_ACCOUNT_ESC * STARTER_ACCOUNTS  # 100,000 ESC

CIRCULATING_SLICE_ESC = LP_ESC + STARTER_ALLOCATION_ESC  # 150,000 ESC

# Treasury supply (before we park the starter pool there for distribution)
TREASURY_SUPPLY_ESC = TOTAL_SUPPLY_ESC - FOUNDER_RESERVE_ESC - CIRCULATING_SLICE_ESC
# = 1,000,000 - 400,000 - 150,000 = 450,000 ESC

# For the DB sim, the treasury wallet actually holds:
#  - Treasury supply (450,000 ESC)
#  - Plus the starter airdrop pool (100,000 ESC) which will be streamed out
TREASURY_WALLET_INITIAL_ESC = TREASURY_SUPPLY_ESC + STARTER_ALLOCATION_ESC  # 550,000 ESC

# LP: 50,000 ESC vs 500 USDC ⇒ $0.01 / ESC
# 🔒 Start price is locked to 0.01 in this script (no CLI override).
ESC_INITIAL_PRICE_USD = Decimal("0.01")
LP_USDC = Decimal("500")

# Dynamic Sarafu-style behavior: allow protocol minting when treasury is tight.
ALLOW_TREASURY_MINT = True
TREASURY_MINT_BUFFER_MULTIPLIER = Decimal("1.5")  # mint a bit more than "needed" for cushion

# ================================================================
# 📈 Price curve tuning
# ================================================================
# price = base * (1 + SLOPE * min(volume / circulating_slice, CAP))
#
# With these defaults:
#   base = 0.01
#   SLOPE = 6
#   CAP   = 20
#
# → factor_max = 1 + 6 * 20 = 121
# → max_price ≈ 0.01 * 121 = $1.21
#
# So as you crank trades, you can *actually* see the sim push toward and past $1.
# If you want even crazier upside, bump CAP or SLOPE.
PRICE_VOLUME_SLOPE = Decimal("6")
PRICE_VOLUME_CAP = Decimal("20")

# To avoid hammering randomuser.me on huge seeds
MAX_AVATAR_SEED_USERS = 2000      # only attempt avatars for the first N users
AVATAR_TIMEOUT_SECONDS = 8

print("🔢 ESC tokenomics (sim context)")
print(f"  Total supply (base)        : {TOTAL_SUPPLY_ESC} ESC")
print(f"  Founder reserve            : {FOUNDER_RESERVE_ESC} ESC")
print(f"  Early circulating slice    : {CIRCULATING_SLICE_ESC} ESC")
print(f"    ↳ LP ESC side            : {LP_ESC} ESC vs {LP_USDC} USDC → ${ESC_INITIAL_PRICE_USD} / ESC")
print(f"    ↳ Starter pool           : {STARTER_ALLOCATION_ESC} ESC "
      f"({STARTER_PER_ACCOUNT_ESC} ESC × {STARTER_ACCOUNTS} wallets)")
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
    don't crash just because avatars flaked.
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

    Conceptual breakdown (on-chain story):
      - Founder reserve:           400,000 ESC   (off-market; not a DB wallet)
      - LP ESC side:                50,000 ESC   (in AMM vs 500 USDC)
      - Treasury supply:           450,000 ESC   (protocol / DAO)
      - Starter airdrop pool:     100,000 ESC    (subset of circulating, held by treasury for now)

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

      - Target: 100 ESC to up to 1000 wallets = 100,000 ESC
      - Uses ESC_INITIAL_PRICE_USD for USD context
      - Stops once STARTER_ALLOCATION_ESC is exhausted
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
    Toy price curve for the sim:

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
    from the treasury if needed (with optional Sarafu-style mint).
    """
    needed = amount - client.esc_balance
    if needed <= 0:
        return

    treasury_wallet = _get_or_create_wallet_for_user(
        treasury, initial_balance=TREASURY_WALLET_INITIAL_ESC
    )
    client_wallet = _get_or_create_wallet_for_user(client)

    # If the treasury doesn't have enough, optionally mint more
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
    until_target=False,
):
    """
    Create bookings between neighbors and simulate payments.

    If `until_target=True` and sim_state["target_price_usd"] > 0,
    we keep going until the target price is hit, or until we exhaust
    the safety cap based on `target_payments`.
    """
    if not services or len(users) < 2:
        print("⚠️ Not enough services/users to create bookings.")
        return

    now = timezone.now()
    bookings_created = 0
    payments_created = 0

    target_price = sim_state.get("target_price_usd", Decimal("0.0")) or Decimal("0.0")

    # Safety cap: allow more turns if we're running "until target"
    if until_target and target_payments < 1_000_000:
        # If you pass small target_payments with until_target, we still bump the iterations.
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

            # 1% burn
            burn_rate = Decimal("0.01")
            burn_amount = (amount * burn_rate).quantize(Decimal("0.0000"))
            net_to_provider = amount - burn_amount

            if net_to_provider <= 0:
                continue

            # Update sim_state aggregates BEFORE price recalculation
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

            # Low-level ledger entry
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

            # 🎯 Track when we first hit or cross the target price
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
                    f"🎯 Target price reached: ${price_usd} ≥ ${target_price} "
                    f"after {sim_state['tx_count']} payments, "
                    f"volume={sim_state['volume_esc']} ESC."
                )

                if until_target:
                    # We'll break on the next loop check
                    continue

    print(f"✅ Created {bookings_created} bookings total.")
    print(f"✅ Created {payments_created} completed payments linked to bookings.")
    print(
        f"📈 Sim volume: {sim_state['volume_esc']} ESC across {sim_state['tx_count']} payments."
    )
    print(f"🔥 Total burned (1% fee): {sim_state['burned_esc']} ESC.")
    print(f"💵 Final simulated price: ${sim_state['price_usd']} per ESC.")

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
            f"🏦 On-ramped: {sim_state['onramp_esc']} ESC "
            f"(~${sim_state.get('onramp_usd', Decimal('0.0'))} USD simulated in)."
        )
    if "minted_esc" in sim_state:
        print(f"🪙 Protocol-minted during sim: {sim_state['minted_esc']} ESC.")

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
                f"🎯 Summary: target ${target_price} reached at tx #{tx_at_hit}, "
                f"volume={vol_at_hit} ESC (~{multiple:.2f}× early circulating slice)."
            )
        else:
            print(
                f"⚠️ Target price ${target_price} NOT reached within this sim "
                f"(final ${sim_state['price_usd']}))."
            )


class Command(BaseCommand):
    help = "Seed ESC neighborhood with fake users, avatars, services, bookings, and payments + price sim."

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
        # 🔹 Curve + target controls (start price is locked to 0.01)
        parser.add_argument(
            "--price-slope",
            type=str,
            default=str(PRICE_VOLUME_SLOPE),
            help="Price curve slope vs volume/circulating (default 6).",
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
            help="Target ESC price in USD for analysis (e.g. 1.00). 0 means no target.",
        )
        parser.add_argument(
            "--until-target",
            action="store_true",
            help="If set and target-price>0, keep simulating until target price is reached (or safety cap).",
        )

    def handle(self, *args, **options):
        global PRICE_VOLUME_SLOPE, PRICE_VOLUME_CAP

        count = options["users"]
        target_payments = options["target_payments"]
        window_days = options["window_days"]

        # 🔹 Override curve constants from CLI (start price stays hard-coded at 0.01)
        PRICE_VOLUME_SLOPE = Decimal(options["price_slope"])
        PRICE_VOLUME_CAP = Decimal(options["price_cap"])

        target_price = Decimal(options["target_price"])
        until_target = bool(options.get("until_target"))

        self.stdout.write(self.style.WARNING("🚧 Seeding ESC neighborhood demo data..."))
        self.stdout.write(
            f"   → users={count}, target_payments≈{target_payments}, window_days={window_days}"
        )
        self.stdout.write(
            f"   → curve: start_price={ESC_INITIAL_PRICE_USD}, "
            f"slope={PRICE_VOLUME_SLOPE}, cap={PRICE_VOLUME_CAP}"
        )
        if target_price > 0:
            self.stdout.write(
                f"   → target price: ${target_price} "
                f"(until_target={'on' if until_target else 'off'})"
            )

        # global sim state
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

        # Circulating / market cap stats (excluding treasury as "off-market" holder)
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
            f"💫 Circulating (ex-treasury) after sim: {circ_ex_treasury} ESC "
            f"→ implied market cap ≈ ${market_cap_final}."
        )
        self.stdout.write(
            f"   For comparison, early circulating slice {CIRCULATING_SLICE_ESC} ESC "
            f"at start price gave ≈ ${market_cap_initial}."
        )

        if sim_state.get("minted_esc", Decimal("0.0")) > 0:
            self.stdout.write(
                self.style.WARNING(
                    f"🪙 Protocol minted {sim_state['minted_esc']} ESC during the sim "
                    "(Sarafu-style flexible supply)."
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
                        f"🎯 Target ${target_price} reached at tx #{tx_at_hit}, "
                        f"volume={vol_at_hit} ESC (~{multiple:.2f}× early circulating slice)."
                    )
                )
            else:
                self.stdout.write(
                    self.style.WARNING(
                        f"⚠️ Target price ${target_price} NOT reached in this run "
                        f"(final ${sim_state['price_usd']} per ESC)."
                    )
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
            }

            # Only include minted_esc if the model actually has that field
            if "minted_esc" in [f.name for f in EscEconomySnapshot._meta.get_fields()]:
                snapshot_kwargs["minted_esc"] = sim_state["minted_esc"]

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
                    "ℹ️ EscEconomySnapshot model not found – skipping summary row. "
                    "Add it in app.models if you want persistent sim stats."
                )
            )
