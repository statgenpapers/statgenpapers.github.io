"""The monthly run: fetch the pool, dedupe, score, write the shortlist. Run: python -m monthly [--month YYYY-MM]"""
from pathlib import Path

ROOT = Path(__file__).parent.parent
