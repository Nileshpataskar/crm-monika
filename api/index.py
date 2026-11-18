"""Vercel runs this file as a serverless function. vercel.json sends every /api/... request here,
and FastAPI handles it exactly like it does locally."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.main import app  # noqa: E402,F401  (Vercel looks for a variable called `app`)
