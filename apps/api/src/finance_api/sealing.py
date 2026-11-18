"""Secrets at rest (I8): a Plaid access token or a paper-account key is stored sealed."""

from cryptography.fernet import Fernet


class SecretBox:
    def __init__(self, key: str) -> None:
        """key is a Fernet key. The deployment takes it from Secret Manager."""
        self._fernet = Fernet(key)

    def seal(self, secret: str) -> bytes:
        return self._fernet.encrypt(secret.encode())

    def open(self, sealed: bytes) -> str:
        return self._fernet.decrypt(sealed).decode()
