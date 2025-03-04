import base64
import os
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives import serialization
from django.conf import settings

# ✅ Load RSA private key from environment (or secure storage)
PRIVATE_KEY_PATH = settings.BASE_DIR / "private_key.pem"
PUBLIC_KEY_PATH = settings.BASE_DIR / "public_key.pem"

# ✅ RSA Key Size
RSA_KEY_SIZE = 2048

# ✅ AES Configuration
AES_KEY_SIZE = 32  # 256-bit key
AES_IV_SIZE = 16  # 128-bit IV
AES_ITERATIONS = 100000  # Strengthens PBKDF2 key derivation


# ✅ Generate New RSA Key Pair (for initial setup)
def generate_rsa_keys():
    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=RSA_KEY_SIZE
    )
    public_key = private_key.public_key()

    # ✅ Store Private Key Securely
    with open(PRIVATE_KEY_PATH, "wb") as f:
        f.write(private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        ))

    # ✅ Store Public Key
    with open(PUBLIC_KEY_PATH, "wb") as f:
        f.write(public_key.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo
        ))

    return private_key, public_key


# ✅ Load RSA Private Key
def load_private_key():
    with open(PRIVATE_KEY_PATH, "rb") as f:
        return serialization.load_pem_private_key(f.read(), password=None)


# ✅ Load RSA Public Key
def load_public_key():
    with open(PUBLIC_KEY_PATH, "rb") as f:
        return serialization.load_pem_public_key(f.read())


# ✅ AES Encryption
def encryptAES(plaintext):
    salt = os.urandom(16)
    key = os.urandom(AES_KEY_SIZE)

    # ✅ Generate IV
    iv = os.urandom(AES_IV_SIZE)

    # ✅ Encrypt message
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
    encryptor = cipher.encryptor()
    padded_plaintext = plaintext + (AES_IV_SIZE - len(plaintext) % AES_IV_SIZE) * chr(AES_IV_SIZE - len(plaintext) % AES_IV_SIZE)
    ciphertext = encryptor.update(padded_plaintext.encode()) + encryptor.finalize()

    return {
        "encrypted_text": base64.b64encode(ciphertext).decode(),
        "iv": base64.b64encode(iv).decode(),
        "key": base64.b64encode(key).decode()
    }


# ✅ AES Decryption
def decryptAES(encrypted_text, iv, key):
    try:
        iv = base64.b64decode(iv)
        key = base64.b64decode(key)
        encrypted_text = base64.b64decode(encrypted_text)

        cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
        decryptor = cipher.decryptor()
        decrypted_padded = decryptor.update(encrypted_text) + decryptor.finalize()

        # ✅ Remove padding
        padding_length = decrypted_padded[-1]
        decrypted_text = decrypted_padded[:-padding_length].decode()

        return decrypted_text

    except Exception as e:
        print("❌ AES Decryption Failed:", e)
        return None


# ✅ RSA Encryption (Used in React Native)
def encryptRSA(plaintext, public_key_pem):
    public_key = serialization.load_pem_public_key(public_key_pem.encode())

    encrypted = public_key.encrypt(
        plaintext.encode(),
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None
        )
    )

    return base64.b64encode(encrypted).decode()


# ✅ RSA Decryption (Used in Django WebSocket)
def decryptRSA(encrypted_text, private_key=None):
    if private_key is None:
        private_key = load_private_key()

    encrypted_text = base64.b64decode(encrypted_text)

    decrypted = private_key.decrypt(
        encrypted_text,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None
        )
    )

    return decrypted.decode()


# ✅ Initial Key Generation (Run Once)
if not os.path.exists(PRIVATE_KEY_PATH) or not os.path.exists(PUBLIC_KEY_PATH):
    print("🔑 Generating New RSA Key Pair...")
    generate_rsa_keys()
