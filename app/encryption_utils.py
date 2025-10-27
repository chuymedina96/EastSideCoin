# encryption_util.py
import base64
import hmac
import os
from typing import Dict, Optional

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives import hashes, serialization
from django.conf import settings

# --- Key storage (same as yours) ---
PRIVATE_KEY_PATH = settings.BASE_DIR / "private_key.pem"
PUBLIC_KEY_PATH = settings.BASE_DIR / "public_key.pem"

RSA_KEY_SIZE = 2048
AES_KEY_SIZE = 32   # 256-bit
AES_IV_SIZE = 16    # 128-bit block size for AES-CBC

# ---------- helpers ----------
def b64e(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")

def b64d(s: str) -> bytes:
    # normalize potential whitespace/newlines
    return base64.b64decode("".join(s.split()))

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

# ---------- RSA keypair management ----------
def generate_rsa_keys():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=RSA_KEY_SIZE)
    public_key = private_key.public_key()

    with open(PRIVATE_KEY_PATH, "wb") as f:
        f.write(private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ))

    with open(PUBLIC_KEY_PATH, "wb") as f:
        f.write(public_key.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ))

    return private_key, public_key

def load_private_key():
    with open(PRIVATE_KEY_PATH, "rb") as f:
        return serialization.load_pem_private_key(f.read(), password=None)

def load_public_key():
    with open(PUBLIC_KEY_PATH, "rb") as f:
        return serialization.load_pem_public_key(f.read())

# ---------- AES-CBC + HMAC-SHA256 (Encrypt-then-MAC) ----------
# Mirrors your RN implementation: MAC over (iv || ciphertext) with the same key.
def encrypt_aes_etm(plaintext: str) -> Dict[str, str]:
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
        # constant-time compare
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

# ---------- RSA-OAEP (SHA-256 + MGF1-SHA256) ----------
# IMPORTANT: matches the RN forge params (md=SHA256, mgf1=SHA256)
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
    Decrypt base64 ciphertext with server private key and return base64 of raw bytes.
    NOTE: Do NOT .decode('utf-8') here; the result is random bytes (AES key).
    """
    if private_key is None:
        private_key = load_private_key()
    enc = b64d(encrypted_b64)
    raw = private_key.decrypt(enc, _OAEP)
    return b64e(raw)

# --- Optional compatibility wrappers (if you reference old names elsewhere) ---
encryptAES = encrypt_aes_etm
decryptAES = decrypt_aes_etm
encryptRSA = rsa_encrypt_b64
decryptRSA = rsa_decrypt_to_b64

# ---------- Initial key generation on cold start ----------
if not os.path.exists(PRIVATE_KEY_PATH) or not os.path.exists(PUBLIC_KEY_PATH):
    print("🔑 Generating New RSA Key Pair...")
    generate_rsa_keys()
