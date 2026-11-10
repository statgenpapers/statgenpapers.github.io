"""Monthly pipeline: fetch the pool, dedupe, score, write the shortlist. Run: python -m pipeline --month YYYY-MM"""
from pathlib import Path

ROOT = Path(__file__).parent.parent
