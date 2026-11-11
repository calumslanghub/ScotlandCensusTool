"""Illustrative (synthetic) metric values for metrics with `source: synthetic`.

These are NOT Census figures. They exist so the explorer can be laid out before the
Census tables are wired in, and the front end badges them "Illustrative data".

Values are stable: each area's noise is a hash of (seed, metric id, area code), so a
rebuild gives identical numbers and adding an area never shifts the others.

  national_level (council areas)
      v = base + urban * u + spread * noise
  every other level (localities), from the parent council area's raw value
      v = parent + urban * (u - u_parent) * LOWER_URBAN_DAMPING
            + spread * LOWER_SPREAD * (1 + SMALL_AREA / sqrt(max(size, SMALL_AREA))) * noise

u is an urban index from log10(people per km²), clipped to URBAN_CLIP. Percentages are
clipped to PCT_CLIP. Metrics sharing a `share_group` are rescaled so each area's group
sums to 100, then rounded by largest remainder so the published values still sum to
exactly 100.
"""
from __future__ import annotations

import hashlib
import logging
import math
from typing import Any

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

URBAN_CLIP = (-1.2, 1.3)
URBAN_CENTRE_LOG10 = 2.0       # 100 people per km² is "neither urban nor rural"
URBAN_SCALE_LOG10 = 1.2
MIN_AREA_KM2 = 0.05
LOWER_URBAN_DAMPING = 0.6
LOWER_SPREAD = 0.9
SMALL_AREA = 30                # people: noise grows for areas smaller than this
PCT_CLIP = (0.3, 99.5)
PERCENT = "%"


def is_synthetic(metric: dict[str, Any]) -> bool:
    return metric.get("source") == "synthetic"


def noise(seed: int, metric_id: str, code: str) -> float:
    """A standard normal draw that depends only on (seed, metric id, area code)."""
    digest = hashlib.sha256(f"{seed}|{metric_id}|{code}".encode()).digest()
    u1 = (int.from_bytes(digest[:8], "big") + 1) / (2 ** 64 + 1)
    u2 = int.from_bytes(digest[8:16], "big") / 2 ** 64
    return math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)


def numbers(df: pd.DataFrame, column: str) -> np.ndarray:
    return df[column].astype("Float64").to_numpy(dtype=float, na_value=np.nan)


def urban_index(df: pd.DataFrame, density: dict[str, str]) -> np.ndarray:
    num = numbers(df, density["numerator"])
    den = np.maximum(numbers(df, density["denominator"]), MIN_AREA_KM2)
    dens = np.nan_to_num(num / den, nan=1.0)
    u = (np.log10(np.maximum(dens, 1.0)) - URBAN_CENTRE_LOG10) / URBAN_SCALE_LOG10
    return np.clip(u, *URBAN_CLIP)


def noise_for(seed: int, metric_id: str, codes: pd.Series) -> np.ndarray:
    return np.array([noise(seed, metric_id, str(c)) for c in codes])


def clip_percent(metric: dict[str, Any], values: np.ndarray) -> np.ndarray:
    return np.clip(values, *PCT_CLIP) if metric.get("unit") == PERCENT else values


def top_raw(metric: dict[str, Any], df: pd.DataFrame, u: np.ndarray, seed: int) -> np.ndarray:
    p = metric["synthetic"]
    return p["base"] + p["urban"] * u + p["spread"] * noise_for(seed, metric["id"], df["code"])


def lower_raw(metric: dict[str, Any], df: pd.DataFrame, u: np.ndarray, parent_raw: np.ndarray,
              parent_u: np.ndarray, size: np.ndarray, seed: int) -> np.ndarray:
    p = metric["synthetic"]
    sd = p["spread"] * LOWER_SPREAD * (1 + SMALL_AREA / np.sqrt(np.maximum(np.nan_to_num(size), SMALL_AREA)))
    return (parent_raw + p["urban"] * (u - parent_u) * LOWER_URBAN_DAMPING
            + sd * noise_for(seed, metric["id"], df["code"]))


def round_shares(shares: np.ndarray, decimals: int) -> np.ndarray:
    """Round each row (summing to 100) so the rounded row still sums to exactly 100.

    Largest remainder: floor every value to `decimals`, then hand the missing units
    to the values with the largest remainders. Rows containing NaN stay NaN.
    """
    unit = 10 ** decimals
    scaled = shares * unit
    out = np.full_like(shares, np.nan)
    ok = ~np.isnan(scaled).any(axis=1)
    floors = np.floor(scaled[ok])
    missing = np.rint(100 * unit - floors.sum(axis=1)).astype(int)
    order = np.argsort(-(scaled[ok] - floors), axis=1, kind="stable")
    for row, k in enumerate(missing):
        floors[row, order[row, :k]] += 1
    out[ok] = floors / unit
    return out


def share_groups(metrics: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for m in metrics:
        if m.get("share_group"):
            groups.setdefault(m["share_group"], []).append(m)
    return groups


def finish(raw: dict[str, np.ndarray], metrics: list[dict[str, Any]]) -> dict[str, np.ndarray]:
    """Clip, rescale share groups to 100, and round to each metric's decimals."""
    out = {m["id"]: np.round(clip_percent(m, raw[m["id"]]), m.get("decimals", 0))
           for m in metrics if not m.get("share_group")}
    for members in share_groups(metrics).values():
        block = np.column_stack([clip_percent(m, raw[m["id"]]) for m in members])
        shares = block / block.sum(axis=1, keepdims=True) * 100
        rounded = round_shares(shares, max(m.get("decimals", 0) for m in members))
        for j, m in enumerate(members):
            out[m["id"]] = rounded[:, j]
    return out


def level_values(levels: dict[str, pd.DataFrame], cfg: dict[str, Any]
                 ) -> dict[str, dict[str, pd.Series]]:
    """{level: {metric id: values aligned to levels[level]}} for every synthetic metric."""
    metrics = [m for m in cfg["metrics"] if is_synthetic(m)]
    syn, top = cfg["synthetic"], cfg["national_level"]
    seed, density, size_col = syn["seed"], syn["density"], syn["weight"]

    top_df = levels[top]
    top_u = urban_index(top_df, density)
    raw_top = {m["id"]: top_raw(m, top_df, top_u, seed) for m in metrics}
    out = {top: series(finish(raw_top, metrics), top_df)}

    position = pd.Series(np.arange(len(top_df)), index=top_df["code"].to_numpy())
    for lv in [lv for lv in cfg["levels"] if lv != top]:
        df = levels[lv]
        idx = position.reindex(df["parent_code"].to_numpy()).to_numpy(dtype=float)
        has_parent = ~np.isnan(idx)
        take = lambda a: np.where(has_parent, a[np.nan_to_num(idx).astype(int)], np.nan)  # noqa: E731
        u = urban_index(df, density)
        raw = {m["id"]: lower_raw(m, df, u, take(raw_top[m["id"]]), take(top_u),
                                  numbers(df, size_col), seed) for m in metrics}
        out[lv] = series(finish(raw, metrics), df)
        if (~has_parent).any():
            log.warning("synthetic: %d %s rows have no parent in %s and get no values",
                        int((~has_parent).sum()), lv, top)
    log.info("synthetic: %d illustrative metrics for levels %s", len(metrics), list(out))
    return out


def series(values: dict[str, np.ndarray], df: pd.DataFrame) -> dict[str, pd.Series]:
    return {k: pd.Series(v, index=df.index, dtype="Float64") for k, v in values.items()}


def national_values(top_values: dict[str, pd.Series], top_df: pd.DataFrame,
                    cfg: dict[str, Any]) -> dict[str, float | None]:
    """Weighted mean of the national_level values; share groups still sum to 100."""
    metrics = [m for m in cfg["metrics"] if is_synthetic(m)]
    w = numbers(top_df, cfg["synthetic"]["weight"])

    def mean(m: dict[str, Any]) -> float:
        v = top_values[m["id"]].to_numpy(dtype=float, na_value=np.nan)
        ok = ~np.isnan(v) & ~np.isnan(w)
        return float(np.average(v[ok], weights=w[ok])) if ok.any() else np.nan

    # Weighted means of shares already sum to 100; finish() only rounds them.
    done = finish({m["id"]: np.array([mean(m)]) for m in metrics}, metrics)
    return {k: (None if np.isnan(v[0]) else float(v[0])) for k, v in done.items()}
