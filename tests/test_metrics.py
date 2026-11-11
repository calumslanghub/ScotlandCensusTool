from __future__ import annotations

import copy

import pandas as pd
import pytest

from build.config import ConfigError
from build.metrics import build_metrics, load_metrics_config, validate_metrics_config

CFG = {
    "levels": ["la", "locality"], "national_level": "la", "classes": 5,
    "default_metric": "pop", "default_classification": "quantile",
    "metrics": [
        {"id": "pop", "label": "Population", "numerator": "pop", "scheme": "Blues"},
        {"id": "density", "label": "Density", "numerator": "pop", "denominator": "area_km2",
         "decimals": 1, "scheme": "Purples"},
        {"id": "pph", "label": "People per household", "numerator": "pop",
         "denominator": "households", "decimals": 2, "scheme": "Oranges"},
    ],
}


def frame(codes, pop, households, area) -> pd.DataFrame:
    return pd.DataFrame({"code": codes, "pop": pd.array(pop, dtype="Int64"),
                         "households": pd.array(households, dtype="Int64"), "area_km2": area})


@pytest.fixture
def levels():
    return {
        "la": frame(["A", "B"], [100, 300], [40, 100], [10.0, 0.0]),
        "locality": frame(["L1", "L2"], [50, None], [None, None], [2.0, 4.0]),
    }


def test_values_and_availability(levels):
    out = build_metrics(levels, CFG)
    by_id = {m["id"]: m for m in out["metrics"]}
    assert by_id["pop"]["levels"] == ["la", "locality"]
    assert by_id["pph"]["levels"] == ["la"]  # no households at locality level
    assert "pph" not in out["values"]["locality"]
    assert out["values"]["la"] == {"codes": ["A", "B"], "pop": [100, 300],
                                   "density": [10.0, None], "pph": [2.5, 3.0]}
    assert out["values"]["locality"]["pop"] == [50, None]


def test_national_is_ratio_of_sums(levels):
    by_id = {m["id"]: m for m in build_metrics(levels, CFG)["metrics"]}
    assert by_id["pop"]["national"] == 400
    assert by_id["pph"]["national"] == round(400 / 140, 2)
    assert by_id["density"]["national"] == 40.0


def test_repo_config_is_valid():
    cfg = load_metrics_config()
    assert cfg["default_metric"] in [m["id"] for m in cfg["metrics"]]


def test_rejects_unknown_default():
    cfg = copy.deepcopy(CFG)
    cfg["default_metric"] = "nope"
    with pytest.raises(ConfigError):
        validate_metrics_config(cfg)
