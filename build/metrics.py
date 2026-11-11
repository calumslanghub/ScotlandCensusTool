"""Build the metrics file the front end shades the map with (config/metrics.yaml).

Output (columnar per level):
  {"note", "synthetic_note", "classes", "default_metric", "default_classification",
   "metrics": [{"id", "label", "short", "unit", "decimals", "scheme", "source",
                "share_group", "levels", "national"}],
   "values": {<level>: {"codes": [...], <metric id>: [...], ...}}}

Census metrics appear under a level only when every source column they need has at
least one value at that level; otherwise the level is omitted from their `levels`.
Synthetic metrics (build/synthetic.py) are illustrative and cover every level.
"""
from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import Any

import pandas as pd
import yaml

from build import census as census_mod
from build import synthetic
from build.config import KNOWN_RAMPS, PROJECT_ROOT, ConfigError

log = logging.getLogger(__name__)

METRICS_PATH = PROJECT_ROOT / "config" / "metrics.yaml"
CLASSIFICATIONS = ("quantile", "jenks")
SOURCES = ("census", "synthetic", "dataset")   # dataset: expanded from config/datasets (build/census.py)
SYNTHETIC_PARAMS = ("base", "urban", "spread")
NOTE = ("Census metrics are derived from Census 2022 boundary-file attributes. Metrics with "
        "source 'synthetic' are illustrative values, not Census figures.")


def load_metrics_config(path: Path = METRICS_PATH) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    validate_metrics_config(cfg)
    return cfg


def validate_metrics_config(cfg: dict[str, Any]) -> None:
    ids = [m["id"] for m in cfg["metrics"]]
    if len(ids) != len(set(ids)):
        raise ConfigError("metric ids must be unique")
    if cfg["default_metric"] not in ids:
        raise ConfigError(f"default_metric '{cfg['default_metric']}' is not a metric id")
    if cfg["default_classification"] not in CLASSIFICATIONS:
        raise ConfigError(f"default_classification must be one of {CLASSIFICATIONS}")
    for m in cfg["metrics"]:
        validate_metric(m)
    if any(synthetic.is_synthetic(m) for m in cfg["metrics"]):
        validate_synthetic_block(cfg.get("synthetic"))


def validate_metric(m: dict[str, Any]) -> None:
    source = m.get("source", "census")
    if source not in SOURCES:
        raise ConfigError(f"metric {m.get('id')}: source must be one of {SOURCES}")
    needs = {"synthetic": "synthetic", "census": "numerator"}.get(source)
    required = ("id", "label", "scheme", *([needs] if needs else []))
    missing = [k for k in required if k not in m]
    if missing:
        raise ConfigError(f"metric {m.get('id')}: missing {missing}")
    if m["scheme"] not in KNOWN_RAMPS:
        raise ConfigError(f"metric {m['id']}: unknown scheme '{m['scheme']}' "
                          f"(known: {', '.join(KNOWN_RAMPS)})")
    if source == "synthetic":
        absent = [k for k in SYNTHETIC_PARAMS if k not in m["synthetic"]]
        if absent:
            raise ConfigError(f"metric {m['id']}: synthetic needs {absent}")
    if m.get("share_group") and (source != "synthetic" or m.get("unit") != synthetic.PERCENT):
        raise ConfigError(f"metric {m['id']}: share_group needs source: synthetic and unit: %")


def validate_synthetic_block(syn: dict[str, Any] | None) -> None:
    if not syn:
        raise ConfigError("synthetic metrics need a top-level `synthetic` block")
    missing = [k for k in ("seed", "density", "weight") if k not in syn]
    if missing or not {"numerator", "denominator"} <= set(syn.get("density", {})):
        raise ConfigError("synthetic needs seed, weight and density: {numerator, denominator}")


def source_columns(metric: dict[str, Any]) -> list[str]:
    return [c for c in (metric["numerator"], metric.get("denominator")) if c]


def available(metric: dict[str, Any], gdf: pd.DataFrame) -> bool:
    return all(c in gdf.columns and gdf[c].notna().any() for c in source_columns(metric))


def metric_values(metric: dict[str, Any], df: pd.DataFrame) -> pd.Series:
    value = df[metric["numerator"]].astype("Float64")
    if metric.get("denominator"):
        den = df[metric["denominator"]].astype("Float64")
        value = value / den.where(den > 0)
    return (value * metric.get("scale", 1)).round(metric.get("decimals", 0))


def national_value(metric: dict[str, Any], df: pd.DataFrame) -> float | None:
    num = df[metric["numerator"]].astype("Float64").sum()
    if metric.get("denominator"):
        den = df[metric["denominator"]].astype("Float64").sum()
        num = num / den if den else math.nan
    value = float(num) * metric.get("scale", 1)
    if math.isnan(value):
        return None
    return rounded(value, metric.get("decimals", 0))


def rounded(value: float | None, decimals: int) -> float | int | None:
    if value is None:
        return None
    return int(round(value)) if decimals == 0 else round(value, decimals)


def to_json_list(values: pd.Series) -> list:
    return [None if pd.isna(v) else (int(v) if float(v).is_integer() else float(v))
            for v in values]


def metric_meta(m: dict[str, Any], have: list[str], national: float | None) -> dict[str, Any]:
    """Census metrics also carry their formula, so the front end can compute them from
    feature properties at levels metrics.json does not cover (e.g. loaded OAs)."""
    formula = ({"numerator": m["numerator"], "denominator": m.get("denominator"),
                "scale": m.get("scale", 1)} if m.get("source", "census") == "census" else {})
    dataset = {k: m[k] for k in ("dataset", "parent", "group") if m.get(k)}
    return {"id": m["id"], "label": m["label"], "short": m.get("short", m["label"]),
            "unit": m.get("unit", ""), "decimals": m.get("decimals", 0), "scheme": m["scheme"],
            "source": m.get("source", "census"), "share_group": m.get("share_group"),
            "levels": have, "national": national, **formula, **dataset}


def dataset_levels(m: dict[str, Any], census: census_mod.CensusMetrics | None) -> list[str]:
    """Levels a dataset metric has values at: metrics.json levels, plus `oa` (per-LA files)."""
    if census is None:
        return []
    have = [lv for lv in census.levels if m["id"] in census.values[lv]]
    return [*have, "oa"] if m["id"] in census.oa.columns else have


def build_metrics(levels: dict[str, pd.DataFrame], cfg: dict[str, Any],
                  census: census_mod.CensusMetrics | None = None) -> dict[str, Any]:
    national_df = levels[cfg["national_level"]]
    has_synthetic = any(synthetic.is_synthetic(m) for m in cfg["metrics"])
    syn = synthetic.level_values(levels, cfg) if has_synthetic else {}
    syn_national = (synthetic.national_values(syn[cfg["national_level"]], national_df, cfg)
                    if has_synthetic else {})

    metrics, values = [], {lv: {"codes": levels[lv]["code"].tolist()} for lv in cfg["levels"]}
    for m in cfg["metrics"]:
        if m.get("source") == census_mod.SOURCE:
            have = dataset_levels(m, census)
            for lv in (lv for lv in have if lv != "oa"):
                values[lv][m["id"]] = census.values[lv][m["id"]]
            national = rounded(census.national.get(m["id"]), m.get("decimals", 0)) if census else None
        elif synthetic.is_synthetic(m):
            have = list(cfg["levels"])
            for lv in have:
                values[lv][m["id"]] = to_json_list(syn[lv][m["id"]])
            national = rounded(syn_national[m["id"]], m.get("decimals", 0))
        else:
            have = [lv for lv in cfg["levels"] if available(m, levels[lv])]
            for lv in have:
                values[lv][m["id"]] = to_json_list(metric_values(m, levels[lv]))
            national = national_value(m, national_df) if available(m, national_df) else None
        metrics.append(metric_meta(m, have, national))
        log.info("metric %s (%s): levels %s", m["id"], m.get("source", "census"), have)
    return {"note": NOTE, "synthetic_note": cfg.get("synthetic", {}).get("note"),
            "classes": cfg["classes"], "default_metric": cfg["default_metric"],
            "default_classification": cfg["default_classification"],
            "datasets": census.datasets if census else {},
            "metrics": metrics, "values": values}
