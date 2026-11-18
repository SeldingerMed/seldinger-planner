"""How far the proposed views are from the true view. NumPy only."""

from __future__ import annotations

import numpy as np

from . import frames, views

WITHIN_DEG = 15.0


def measure(scores, offsets, turns, true_views) -> dict[str, np.ndarray]:
    """Per frame: angle from the truth of the first proposal and of the best.

    ``true_views`` holds (primary, secondary, turn) in degrees per frame.
    Also returns the rank of the best proposal and the error of its turn.
    """
    count = len(true_views)
    first, best, rank, turn = (np.zeros(count) for _ in range(4))
    for index in range(count):
        found = views.proposals(scores[index], offsets[index], turns[index])
        apart = np.array(
            [
                views.separation_deg(
                    item["primary_deg"],
                    item["secondary_deg"],
                    true_views[index][0],
                    true_views[index][1],
                )
                for item in found
            ]
        )
        nearest = int(apart.argmin())
        first[index], best[index], rank[index] = apart[0], apart[nearest], nearest
        turn[index] = abs(found[nearest]["turn_deg"] - true_views[index][2])
    return {"first_deg": first, "best_deg": best, "best_rank": rank, "best_turn_error_deg": turn}


def summary(measured: dict[str, np.ndarray], modes=None) -> dict:
    """Shares within ``WITHIN_DEG`` and medians, overall and per filling mode."""

    def of(chosen) -> dict:
        first, best = measured["first_deg"][chosen], measured["best_deg"][chosen]
        return {
            "frames": len(first),
            "first_within": round(float((first <= WITHIN_DEG).mean()), 4),
            "best_within": round(float((best <= WITHIN_DEG).mean()), 4),
            "first_median_deg": round(float(np.median(first)), 2),
            "best_median_deg": round(float(np.median(best)), 2),
            "best_turn_error_median_deg": round(
                float(np.median(measured["best_turn_error_deg"][chosen])), 2
            ),
        }

    result = {"within_deg": WITHIN_DEG, "all": of(np.ones(len(measured["first_deg"]), dtype=bool))}
    if modes is not None:
        # Kept apart from "all": one of the filling modes is itself named "all".
        result["by_mode"] = {
            name: of(modes == index)
            for index, name in enumerate(frames.MODES)
            if (modes == index).any()
        }
    return result
