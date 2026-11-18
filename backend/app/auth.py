"""Login and permissions.

Passwords are stored as salted scrypt hashes, so even someone who reads the database can't
see them. After login the browser gets a JWT: a signed token saying "user 3, valid until X".
It sends the token on every request and we check the signature instead of a password.
"""
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlmodel import Session

from .db import get_session
from .models import User

# Anyone with this key can create valid tokens. Set a long random SECRET_KEY in production
# (the Docker image refuses to start without one).
SECRET_KEY = os.getenv("SECRET_KEY") or "dev-only-secret-change-me"
if os.getenv("REQUIRE_SECRET_KEY") and SECRET_KEY == "dev-only-secret-change-me":
    raise RuntimeError("Set the SECRET_KEY environment variable to a long random string")
ALGORITHM = "HS256"
TOKEN_HOURS = 12


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    _, salt_hex, digest_hex = stored.split("$")
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1)
    return hmac.compare_digest(digest.hex(), digest_hex)  # constant-time compare


def create_token(user: User) -> str:
    expires = datetime.now(timezone.utc) + timedelta(hours=TOKEN_HOURS)
    return jwt.encode({"sub": str(user.id), "exp": expires}, SECRET_KEY, algorithm=ALGORITHM)


# Reads the "Authorization: Bearer <token>" header. tokenUrl makes the Authorize button in /docs work.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def get_current_user(token: str = Depends(oauth2_scheme), session: Session = Depends(get_session)) -> User:
    not_logged_in = HTTPException(status.HTTP_401_UNAUTHORIZED, "Not logged in or session expired",
                                  headers={"WWW-Authenticate": "Bearer"})
    try:
        user_id = int(jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])["sub"])
    except (jwt.InvalidTokenError, KeyError, ValueError):
        raise not_logged_in
    user = session.get(User, user_id)
    if not user or not user.is_active:
        raise not_logged_in
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only admins can do this")
    return user
