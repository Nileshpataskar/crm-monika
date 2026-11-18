"""Create a user from the terminal (needed once, to make the first admin):

    python -m app.create_user admin "Sagar Gaikwad" --role admin
"""
import argparse
from getpass import getpass

from sqlmodel import Session, select

from .auth import hash_password
from .db import create_tables, engine
from .models import User

parser = argparse.ArgumentParser()
parser.add_argument("username")
parser.add_argument("full_name")
parser.add_argument("--role", choices=["admin", "viewer"], default="viewer")
args = parser.parse_args()
args.username = args.username.strip().lower()

password = getpass("Password: ")
if len(password) < 8:
    raise SystemExit("Password must be at least 8 characters")
if password != getpass("Repeat password: "):
    raise SystemExit("Passwords don't match")

create_tables()
with Session(engine) as session:
    if session.exec(select(User).where(User.username == args.username)).first():
        raise SystemExit(f"User {args.username!r} already exists")
    session.add(User(username=args.username, full_name=args.full_name, role=args.role,
                     password_hash=hash_password(password)))
    session.commit()
print(f"Created {args.role} {args.username!r}")
