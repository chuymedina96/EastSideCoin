# EastSide Coin (ESC) – Neighborhood Currency & Local Economy Platform
A full-stack, hyperlocal digital currency ecosystem designed for real Chicago neighborhoods — combining payments, services, messaging, and live local infrastructure data into one unified platform.

--------------------------------------------------------------------------------
🚨 **OPEN-SOURCE NOTICE**  
This project is **NOT fully open-source yet**.  
The repository is viewable, but several economic models, security primitives, and networking components are still under restricted license.

You MAY:
- Clone and run locally  
- Study the architecture  
- Modify for learning or experimentation  

You may NOT:
- Redistribute a fork  
- Use production code in commercial systems  
- Publish derivatives of the economic models or simulation engines  

--------------------------------------------------------------------------------
# 📂 PROJECT STRUCTURE

```
/
├── app/                        # Core Django app: users, wallet, chat, services, bookings, ESC economy, AIS
│   ├── management/
│   │   └── commands/
│   │       ├── seed_esc_demo.py      # FULL ESC seeding + 1,800-line economy simulation
│   │       ├── seed_bridges.py       # Seeds Calumet River bridge metadata
│   │       └── run_ais_watch.py      # Live AIS → Bridge lift prediction worker
│   │
├── backend/                    # Django project (settings, URLs, ASGI, Channels)
├── mobile/                     # React Native (Expo) mobile app
│   └── ...
│
├── manage.py
├── Procfile
├── requirements.txt
├── runtime.txt
├── .env.example
└── README.md
```

--------------------------------------------------------------------------------
# 🌎 WHAT IS EASTSIDE COIN?

EastSide Coin (ESC) is a **neighborhood-scale digital currency and services marketplace** built for the East Side / South Deering community.

The platform combines:

### 🪙 Local Digital Currency
- Wallets  
- LEDGER-BASED transactions  
- Airdrops  
- Treasury controls  
- AMM price curve simulation  

### 🧱 Real Neighborhood Services
- Local business listings  
- Resident skill listings  
- Booking system (pending → confirmed → completed)  

### 🔐 Fully Encrypted Messaging
- RSA-OAEP public key registry  
- AES-256-GCM message bodies  
- WebSocket real-time E2EE chat  

### 🌉 Live Infrastructure Monitoring
Real-time AIS (ship tracking) data used to predict:
- 92nd Street Bridge lifts  
- 95th  
- 100th  
- 106th  

### 📊 Economic Simulation Engine
A **1,800+ line management command** models:
- ESC supply  
- Trading flows  
- AMM liquidity  
- Slippage  
- Treasury injections  
- Zero-wallet refill patterns  
- Holder distribution  
- Price curves  
- Snapshot analytics  

This powers a living neighborhood economy.

--------------------------------------------------------------------------------
# ⚙️ TECH STACK

### Backend
- Python 3  
- Django 5  
- Django Channels (WebSockets)  
- Django REST Framework  
- SimpleJWT  
- AISStream  
- SQLite / PostgreSQL  

### Mobile
- React Native (Expo)
- AES-256-GCM encryption
- RSA-OAEP keypair handling
- Persistent secure storage
- WebSocket encrypted chat
- React Navigation

--------------------------------------------------------------------------------
# 🚀 LOCAL DEVELOPMENT SETUP

## 1. Clone the repository
```
git clone https://github.com/yourusername/eastside-coin.git
cd eastside-coin
```

--------------------------------------------------------------------------------
# 2. BACKEND SETUP (Django)

## Create virtual environment
```
python3 -m venv venv
source venv/bin/activate
```

## Install dependencies
```
pip install -r requirements.txt
```

## Create `.env`
```
cp .env.example .env
```

Fill with values such as:
```
SECRET_KEY=your_secret_key
DEBUG=True
AISSTREAM_API_KEY=your_key
USE_S3_MEDIA=0   # local file storage
```

## Run migrations
```
python manage.py migrate
```

## Create a superuser (optional)
```
python manage.py createsuperuser
```

## Start backend server
```
python manage.py runserver 0.0.0.0:8000
```

Backend API is now available at:
```
http://YOUR_LOCAL_IP:8000
```

--------------------------------------------------------------------------------
# ⭐ DATABASE SEEDING & SIMULATION (IMPORTANT)

ESC provides **built-in full seeding logic** and does NOT require the user to write their own seeds.

You MUST run the following commands in order:

---

# 1️⃣ Seed the bridge metadata
```
python manage.py seed_bridges
```
This populates:
- 92nd bridge  
- 95th bridge  
- 100th bridge  
- 106th bridge  

Used by the AIS system.

---

# 2️⃣ Run the complete ESC economy seeding + simulation
```
python manage.py seed_esc_demo
```

This **1,800+ line script** handles:

### ✔ Creation of:
- Demo users  
- WalletAccounts  
- Initial ESC distribution  
- Service listings  
- Bookings  
- Chat threads  
- Transaction skeletons  

### ✔ Full AMM simulation with parameters:
- LP_USDC_INITIAL  
- LP_ESC_INITIAL  
- NUM_SIM_TRADES  
- NUM_ZERO_WALLET_REFILLS  
- TREASURY_INJECTION_AMOUNT  
- TRADE_VOLUME_VARIANCE  
- HOLDER_DISTRIBUTION_MODE  

### ✔ Neighborhood economic behavior:
- Buy pressure  
- Sell pressure  
- Slippage  
- Price curve progression  
- Airdrop events  
- Randomized service booking flows  

### ✔ Writes a final `EscEconomySnapshot`
Used for charts, analytics, and dashboards in-app.

---

# 3️⃣ (Optional) Configure Simulation Parameters
Inside:
```
app/management/commands/seed_esc_demo.py
```

You may tune variables such as:
```
LP_ESC_INITIAL
LP_USDC_INITIAL
TRADES_PER_USER
AMM_FEE_PERCENT
TREASURY_REFILL_THRESHOLDS
ZERO_WALLET_REFILL_ESC
```

All parameters are documented in the top of the file.

--------------------------------------------------------------------------------
# 🌉 LIVE AIS → BRIDGE LIFT WATCHER

To stream real-time positions of ships entering the Calumet River:

```
python manage.py run_ais_watch
```

This connects to AISStream and updates `BridgeStatus` in real-time.

It detects:
- Vessel heading  
- Distance to bridges  
- ETA predictions  
- Upbound/downbound movement  
- Whether a bridge is likely to lift  

The mobile app reads these updates on the Home screen.

--------------------------------------------------------------------------------
# 3. MOBILE APP SETUP (React Native / Expo)

Navigate to mobile project:
```
cd mobile
```

Install dependencies:
```
npm install
```

Update API and WebSocket URLs in:
```
mobile/utils/api.js
mobile/config.js
```

Example:
```
export const API_URL = "http://YOUR_LOCAL_IP:8000";
export const WS_URL  = "ws://YOUR_LOCAL_IP:8000/ws";
```

Start Expo:
```
npx expo start
```

Open on device or simulator.

--------------------------------------------------------------------------------
# 🔐 SECURITY ARCHITECTURE

## Encryption
- Client generates RSA-2048 keypair
- Public key uploaded to Django
- Django NEVER handles private keys
- Messages encrypted using AES-256-GCM
- AES key is wrapped using RSA-OAEP
- Ciphertext + wrapped key stored in DB

## WebSockets
- Authenticated via JWT query param
- One socket per conversation
- Messages decrypted only on-device

--------------------------------------------------------------------------------
# 📡 BACKEND SERVICES

### AIS Worker
Real-time ship tracking + bridge predictions.

### Booking Engine
Lifecycle:
pending → confirmed → completed / cancelled

### Service Marketplace
Listings, categories, pricing.

### Wallet System
- Ledger-based  
- Audit trail  
- Transaction linking  
- Treasury behavior  

### AMM Price Engine
Simulates ESC ↔ USDC pricing using:
```
x * y = k
```

--------------------------------------------------------------------------------
# 🧪 TESTING

Run all tests:
```
python manage.py test
```

Test AIS connectivity:
```
python manage.py test_ais
```

--------------------------------------------------------------------------------
# 🛠 DEPLOYMENT (Heroku / Railway Ready)

Included:
- `Procfile`
- `runtime.txt`
- `requirements.txt`

Production requires:
- Postgres  
- Redis (for WebSockets)  
- S3 media storage  
- Worker dyno for AIS  

--------------------------------------------------------------------------------
# 🤝 CONTRIBUTING

Pull requests are not yet open.

However:
- Discussions  
- Architecture feedback  
- Issue reports  

…are welcome.

--------------------------------------------------------------------------------
# 📜 LICENSE

License will be added upon open-source release.  
Until then: **ALL RIGHTS RESERVED.**

--------------------------------------------------------------------------------
# 🗺 FUTURE ROADMAP

- Group chats (encrypted)  
- Neighborhood DAO governance  
- Full public dashboards  
- On/off ramps (bank transfers)  
- More bridge + infrastructure integrations  
- Machine-learning economic forecasting  
- Multiple neighborhood support  

--------------------------------------------------------------------------------
# ✨ THANK YOU

EastSide Coin is built for real communities — for neighbors, by neighbors.  
This platform blends code, economics, encryption, and Chicago’s working-class character into something powerful.

