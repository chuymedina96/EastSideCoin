# encryption_util.py
import base64
import hmac
import os
import re
from typing import Dict, Optional, Tuple

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives import hashes, serialization
from django.conf import settings

# --- Key storage (server RSA used only if/when the server needs to decrypt) ---
PRIVATE_KEY_PATH = settings.BASE_DIR / "private_key.pem"
PUBLIC_KEY_PATH = settings.BASE_DIR / "public_key.pem"

RSA_KEY_SIZE = 2048
AES_KEY_SIZE = 32   # 256-bit
AES_IV_SIZE = 16    # 128-bit block size for AES-CBC

# =============================================================================
# Base64 helpers (tolerant: whitespace, URL-safe, padding)
# =============================================================================
_B64_WS = re.compile(r"\s+")

def _b64_fix(s: str) -> str:
    s = _B64_WS.sub("", s).replace("-", "+").replace("_", "/")
    pad = len(s) % 4
    if pad:
        s += "=" * (4 - pad)
    return s

def b64e(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")

def b64e_urlsafe_nopad(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")

def b64d(s: str) -> bytes:
    return base64.b64decode(_b64_fix(s))

# =============================================================================
# PKCS#7 padding
# =============================================================================
def pkcs7_pad(data: bytes, block_size: int = 16) -> bytes:
    pad_len = block_size - (len(data) % block_size)
    return data + bytes([pad_len]) * pad_len

def pkcs7_unpad(padded: bytes, block_size: int = 16) -> bytes:
    if not padded:
        raise ValueError("Invalid padding: empty input")
    pad_len = padded[-1]
    if pad_len < 1 or pad_len > block_size or len(padded) < pad_len:
        raise ValueError("Invalid padding length")
    if padded[-pad_len:] != bytes([pad_len]) * pad_len:
        raise ValueError("Invalid PKCS#7 padding")
    return padded[:-pad_len]

# =============================================================================
# RSA keypair management (server-side)
# =============================================================================
def generate_rsa_keys() -> Tuple[rsa.RSAPrivateKey, rsa.RSAPublicKey]:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=RSA_KEY_SIZE)
    public_key = private_key.public_key()

    # Ensure directory exists
    PRIVATE_KEY_PATH.parent.mkdir(parents=True, exist_ok=True)

    with open(PRIVATE_KEY_PATH, "wb") as f:
        f.write(private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ))
    try:
        os.chmod(PRIVATE_KEY_PATH, 0o600)
    except Exception:
        pass

    with open(PUBLIC_KEY_PATH, "wb") as f:
        f.write(public_key.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ))
    try:
        os.chmod(PUBLIC_KEY_PATH, 0o644)
    except Exception:
        pass

    return private_key, public_key

def load_private_key():
    with open(PRIVATE_KEY_PATH, "rb") as f:
        return serialization.load_pem_private_key(f.read(), password=None)

def load_public_key():
    with open(PUBLIC_KEY_PATH, "rb") as f:
        return serialization.load_pem_public_key(f.read())

# =============================================================================
# AES-CBC + HMAC-SHA256 (Encrypt-then-MAC)
# MAC over (iv || ciphertext). RN client mirrors this.
# =============================================================================
def encrypt_aes_etm(plaintext: str) -> Dict[str, str]:
    """
    Returns base64 fields:
    - ciphertext_b64
    - iv_b64
    - key_b64        (raw AES key, base64)
    - mac_b64
    """
    key = os.urandom(AES_KEY_SIZE)           # 32 bytes
    iv  = os.urandom(AES_IV_SIZE)            # 16 bytes

    cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
    encryptor = cipher.encryptor()
    ct = encryptor.update(pkcs7_pad(plaintext.encode("utf-8"))) + encryptor.finalize()

    mac = hmac.new(key, iv + ct, digestmod="sha256").digest()

    return {
        "ciphertext_b64": b64e(ct),
        "iv_b64": b64e(iv),
        "key_b64": b64e(key),
        "mac_b64": b64e(mac),
    }

def decrypt_aes_etm(ciphertext_b64: str, iv_b64: str, mac_b64: str, key_b64: str) -> Optional[str]:
    try:
        key = b64d(key_b64)
        iv  = b64d(iv_b64)
        ct  = b64d(ciphertext_b64)
        mac_expected = b64d(mac_b64)

        mac_computed = hmac.new(key, iv + ct, digestmod="sha256").digest()
        if not hmac.compare_digest(mac_computed, mac_expected):
            print("⚠️ AES MAC validation failed")
            return None

        cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
        decryptor = cipher.decryptor()
        padded = decryptor.update(ct) + decryptor.finalize()
        pt = pkcs7_unpad(padded).decode("utf-8")
        return pt
    except Exception as e:
        print("❌ AES Decryption Failed:", e)
        return None

# =============================================================================
# RSA-OAEP (SHA-256 + MGF1-SHA256) — matches RN side
# =============================================================================
_OAEP = padding.OAEP(
    mgf=padding.MGF1(algorithm=hashes.SHA256()),
    algorithm=hashes.SHA256(),
    label=None,
)

def rsa_encrypt_b64(data_b64: str, public_key_pem: str) -> str:
    """
    Encrypt a base64 payload (e.g., AES key) with a PEM public key.
    Returns base64 ciphertext. Mirrors RN encryptRSA(bundle.keyB64, pubkey).
    """
    pub = serialization.load_pem_public_key(public_key_pem.encode("utf-8"))
    raw = b64d(data_b64)
    enc = pub.encrypt(raw, _OAEP)
    return b64e(enc)

def rsa_decrypt_to_b64(encrypted_b64: str, private_key=None) -> str:
    """
    Decrypt base64 ciphertext with the server private key and return base64 of raw bytes.
    NOTE: Do NOT .decode('utf-8') here; the result is random bytes (AES key).
    """
    if private_key is None:
        private_key = load_private_key()
    enc = b64d(encrypted_b64)
    raw = private_key.decrypt(enc, _OAEP)
    return b64e(raw)

# =============================================================================
# Optional: helpers to shape WS/API payloads exactly like the RN client expects
# =============================================================================
def build_ws_payload_for_relay(plaintext: str, sender_public_key_pem: str, receiver_public_key_pem: str) -> Dict[str, str]:
    """
    For server-side relays (no server decryption): encrypt once with AES, wrap key for both parties.
    Returns dict with RN field names:
      encrypted_message, iv, mac, encrypted_key_for_sender, encrypted_key_for_receiver
    """
    bundle = encrypt_aes_etm(plaintext)
    enc_for_receiver = rsa_encrypt_b64(bundle["key_b64"], receiver_public_key_pem)
    enc_for_sender   = rsa_encrypt_b64(bundle["key_b64"], sender_public_key_pem)
    return {
        "encrypted_message": bundle["ciphertext_b64"],
        "iv": bundle["iv_b64"],
        "mac": bundle["mac_b64"],
        "encrypted_key_for_receiver": enc_for_receiver,
        "encrypted_key_for_sender": enc_for_sender,
    }

def server_debug_decrypt_if_addressed_to_server(payload: Dict[str, str]) -> Optional[str]:
    """
    Debug helper: If a message was mistakenly addressed to the server (i.e., the RSA wrap
    is with the server public key), try to unwrap and decrypt to confirm correctness.
    Expects RN field names (encrypted_message, iv, mac, encrypted_key_for_*).
    Returns plaintext or None.
    """
    try:
        # Pick any wrap present
        wrap = payload.get("encrypted_key_for_me") \
            or payload.get("encrypted_key_for_receiver") \
            or payload.get("encrypted_key_for_sender") \
            or payload.get("encrypted_key")
        if not wrap:
            return None

        key_b64 = rsa_decrypt_to_b64(wrap)  # uses server private key
        return decrypt_aes_etm(
            ciphertext_b64=payload["encrypted_message"],
            iv_b64=payload["iv"],
            mac_b64=payload["mac"],
            key_b64=key_b64,
        )
    except Exception as e:
        print("server_debug_decrypt_if_addressed_to_server error:", e)
        return None

# --- Optional compatibility exports (if your code imports these names) ---
encryptAES = encrypt_aes_etm
decryptAES = decrypt_aes_etm
encryptRSA = rsa_encrypt_b64
decryptRSA = rsa_decrypt_to_b64

# =============================================================================
# Initial key generation on cold start (server RSA)
# =============================================================================
if not os.path.exists(PRIVATE_KEY_PATH) or not os.path.exists(PUBLIC_KEY_PATH):
    print("🔑 Generating New RSA Key Pair...")
    generate_rsa_keys()
