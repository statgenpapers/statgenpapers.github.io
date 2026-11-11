"""How training weighs months, shared by dev/train.py and dev/rollforward.py.

A model for month M is fitted on the 12 months before M, each weighted 0.5 ** (age / 6): last month 0.89, a year
back 0.25. The leak-free backtest of 2026-01..10 (data from 2025-01) chose it over equal weights, other half-lives
and plain windows; it also lets the weights follow the lab's taste, month by month.
"""
import numpy as np

WINDOW, HALF_LIFE = 12, 6  # months

index = lambda months: np.array([int(m[:4]) * 12 + int(m[5:7]) for m in months])


def rows_and_weights(month, before):
    """For a model of month `before` ("2026-11"): which pool rows it trains on, and their sample weights."""
    age = index([before])[0] - index(month)
    rows = (age >= 1) & (age <= WINDOW)
    return rows, 0.5 ** (age[rows] / HALF_LIFE)
