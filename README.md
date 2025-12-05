# EastSide Coin (ESC) – Neighborhood Currency Platform
A hyperlocal digital economy built for real communities.

--------------------------------------------------------------------------------

🚨 PROJECT STATUS & OPEN-SOURCE NOTICE  
This project is NOT fully open-source yet.  
The codebase is under active development. Core components such as encryption logic, wallet mechanics, simulation engines, and networking services are NOT licensed for public reuse at this time.  
You may clone or run locally for learning purposes only.

If you want to set up your own instance, you must configure:  
- Your own Django backend  
- Your own React Native (Expo) mobile app  
- Your own `.env` secrets  
- Your own RSA keypair generation and key wrapping  
- Your own database seeds and ESC economy simulation

--------------------------------------------------------------------------------

# 📂 PROJECT STRUCTURE

```
/
├── app/                  # Django app: users, wallet, bookings, services, chat, AIS, snapshots
├── backend/              # Django project: settings, ASGI config, URL routing
├── mobile/               # React Native (Expo) application
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

EastSide Coin is a **neighborhood digital currency and service marketplace**, designed to strengthen local communities by enabling:

- Peer-to-peer payments  
- A local service economy  
- Secure end-to-end encrypted chat  
- Real-time bridge lift predictions via AIS  
- Wallet balances, transaction history, and pricing  
- Hyperlocal liquidity and tokenomics simulations  

The platform blends **Django**, **React Native**, **WebSockets**, **AES + RSA encryption**, and a full economic simulation/AMM model.

--------------------------------------------------------------------------------

# ⚙️ CORE SYSTEMS

## 1. Django Backend (API + WebSockets)
Included inside `backend/` and `app/`.

### Features:
- Custom User model (email login, avatars, onboarding profile)
- Device RSA public key registry
- AES/RSA hybrid encrypted messaging
- WalletAccount + ledger modeling
- ESC transactions (payment, airdrop, treasury, etc.)
- Service listings + categories
- Bookings system (pending/confirmed/rejected/cancelled/completed)
- Conversations + message history endpoints
- AIS worker for real-time bridge predictions (Calumet River)
- Economy simulation engine
- ESC price modeling + AMM constant-product pool
- Snapshot storage in `EscEconomySnapshot`
- JWT authentication
- Local or S3 media storage

--------------------------------------------------------------------------------

## 2. React Native Mobile App (Expo)
Located at `mobile/`.

### Features:
- JWT login, registration, logout
- RSA keypair generation on-device
- AES-encrypted chat messages over WebSocket
- Per-user key storage with AsyncStorage (namespaced)
- Message hydration + caching
- Wallet balance + transactions
- Real-time Bridge Lift Watch
- Marketplace + service details
- Booking creation, updates, and status changes
- Auto-logout + refresh flow
- Smooth navigation with secure key bootstrapping

--------------------------------------------------------------------------------

## 3. ESC ECONOMY SIMULATION

Simulation includes:
- Randomized user trades
- On-chain/off-chain pricing through AMM curve
- Treasury injections
- Airdrops
- Zero-wallet refill analytics
- Price shifts over time
- Volume, tx count, slippage
- Circulating supply + holder diversity metrics

The result is written as an `EscEconomySnapshot`, used by the app for analytics and dashboards.

--------------------------------------------------------------------------------

# 🧱 TECH STACK

### Backend
- Python 3  
- Django 5  
- Django REST Framework  
- Django Channels  
- SimpleJWT  
- WebSockets  
- SQLite/PostgreSQL  
- AISStream WebSocket integration  

### Mobile
- React Native (Expo)  
- RSA-OAEP  
- AES-256-GCM  
- Secure key storage  
- Realtime WebSockets  

--------------------------------------------------------------------------------

# 🚀 LOCAL DEVELOPMENT SETUP

## 1. Clone the repo
```
git clone https://github.com/yourusername/eastside-coin.git
cd eastside-coin
```

--------------------------------------------------------------------------------

## 2. BACKEND SETUP

### Create a virtual environment:
```
python3 -m venv venv
source venv/bin/activate
```

### Install backend dependencies:
```
pip install -r requirements.txt
```

### Create your `.env`:
```
cp .env.example .env
```

Fill out:
- SECRET_KEY  
- DEBUG=True  
- AISSTREAM_API_KEY  
- Optional S3 storage credentials  

### Run migrations:
```
python manage.py migrate
```

### Create superuser (optional):
```
python manage.py createsuperuser
```

### Start backend server:
```
python manage.py runserver 0.0.0.0:8000
```

Backend available at:  
**http://YOUR_LOCAL_IP:8000**

--------------------------------------------------------------------------------

## 3. RUN THE ESC ECONOMY SIMULATION

```
python manage.py run_sim
```

Simulation seeds:
- Users  
- WalletAccounts  
- Services  
- Bookings  
- Economy activity  
- AMM liquidity pool  
- Final snapshot  

--------------------------------------------------------------------------------

## 4. MOBILE SETUP (React Native / Expo)

### Install dependencies:
```
cd mobile
npm install
```

### Update API + WS URL:
Edit `mobile/utils/api.js` or `mobile/config.js`:

```
export const API_URL = "http://YOUR_LOCAL_IP:8000";
export const WS_URL  = "ws://YOUR_LOCAL_IP:8000/ws";
```

### Start Expo:
```
npx expo start
```

Open on:
- iOS simulator  
- Android emulator  
- Physical device (same WiFi)

--------------------------------------------------------------------------------

# 🛠 DEPLOYMENT NOTES

This repo contains:
- `Procfile` for Heroku / Railway  
- `runtime.txt`  
- `requirements.txt`  

Production requires:
- PostgreSQL  
- Redis (Channels backend)  
- S3/Spaces for media  
- A worker dyno for AIS tasks  

--------------------------------------------------------------------------------

# 🔐 SECURITY ARCHITECTURE

### Messaging Security
- AES-256-GCM for message bodies  
- Per-message random IV  
- Server stores ONLY ciphertext + wrapped AES key  
- RSA-OAEP public-key wrapping  
- Private keys NEVER leave client devices  

### Wallet Security
- Ledger-based accounting  
- Immutable transaction history  
- Booking-to-transaction linking  

### API Auth
- JWT access + refresh  
- Token rotation support  
- Auto-logout protections  
- CSRF/CORS configured for mobile + local dev  

--------------------------------------------------------------------------------

# 📡 AIS WORKER – BRIDGE LIFT PREDICTION

Uses AISStream WebSocket feed.

Continuously:
- Reads vessel lat/lon  
- Determines speed + heading  
- Calculates distance to neighborhood bridges  
- Predicts upcoming lifts  
- Updates `BridgeStatus` model  

Bridges covered:
- 92nd  
- 95th  
- 100th  
- 106th  

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

# 🤝 CONTRIBUTING

The repo is not fully open-source yet.  
However:
- Issues  
- Feature suggestions  
- Architecture discussions  

…are welcome.

--------------------------------------------------------------------------------

# 📜 LICENSE

License will be added when full open-source rollout begins.  
Until then: **All rights reserved.**

--------------------------------------------------------------------------------

# 🗺 ROADMAP

- Group encrypted chats  
- Secure file attachments  
- DAO governance  
- On/off-ramps (ACH)  
- Multi-neighborhood support  
- Public dashboards  
- Analytics + ML forecasting  

--------------------------------------------------------------------------------

# ✨ ACKNOWLEDGMENTS

This project is dedicated to the East Side / South Deering community and the broader movement for neighborhood self-determination.  
Building a digital economy from the ground up requires vision, engineering, and community — ESC is built with all three.
