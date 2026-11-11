from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from build import synthetic
from build.config import ConfigError
from build.metrics import build_metrics, load_metrics_config, validate_metrics_config

CFG = load_metrics_config()


def levels() -> dict[str, pd.DataFrame]:
    la = pd.DataFrame({"code": ["S1", "S2", "S3", "S4"], "parent_code": [None] * 4,
                       "pop": pd.array([20000, 630000, 95000, 150000], dtype="Int64"),
                       "households": pd.array([9000, 300000, 41000, 68000], dtype="Int64"),
                       "area_km2": [6000.0, 175.0, 1100.0, 60.0]})
    loc = pd.DataFrame({"code": ["L1", "L2", "L3", "L4", "L5"],
                        "parent_code": ["S1", "S2", "S2", "S4", None],
                        "pop": pd.array([600, 590000, 15, None, 300], dtype="Int64"),
                        "households": pd.array([None] * 5, dtype="Int64"),
                        "area_km2": [1.2, 160.0, 0.02, 3.0, 1.0]})
    ew = pd.DataFrame({"code": ["W1", "W2", "W3"], "parent_code": ["S1", "S2", "S4"],
                       "pop": pd.array([20000, 9000, 70000], dtype="Int64"),
                       "households": pd.array([9000, 4000, 30000], dtype="Int64"),
                       "area_km2": [6000.0, 4.0, 40.0]})
    dz = pd.DataFrame({"code": ["D1", "D2"], "parent_code": ["S2", "S3"],
                       "pop": pd.array([800, 650], dtype="Int64"),
                       "households": pd.array([350, 300], dtype="Int64"),
                       "area_km2": [0.3, 12.0]})
    cc = pd.DataFrame({"code": ["C1", "C2"], "parent_code": ["S1", "S1"],
                       "pop": pd.array([1200, None], dtype="Int64"),
                       "households": pd.array([500, None], dtype="Int64"),
                       "area_km2": [80.0, 2.0]})
    return {"la": la, "ew": ew, "locality": loc, "dz": dz, "cc": cc}


def groups() -> dict[str, list[str]]:
    return {g: [m["id"] for m in ms] for g, ms in synthetic.share_groups(CFG["metrics"]).items()}


def test_repo_config_has_share_groups():
    assert set(groups()) >= {"travel_to_work"}   # the only table without a Census CSV yet


@pytest.mark.parametrize("level", ["la", "ew", "locality", "dz", "cc"])
def test_shares_sum_to_100_in_every_area(level):
    out = build_metrics(levels(), CFG)
    values = out["values"][level]
    for group, ids in groups().items():
        rows = list(zip(*(values[i] for i in ids)))
        for code, row in zip(values["codes"], rows):
            if None in row:  # areas with no parent council area get no synthetic values
                assert all(v is None for v in row), (group, code)
                continue
            assert sum(row) == pytest.approx(100, abs=1e-9), (group, code, row)


def test_national_shares_sum_to_100():
    meta = {m["id"]: m for m in build_metrics(levels(), CFG)["metrics"]}
    for group, ids in groups().items():
        assert sum(meta[i]["national"] for i in ids) == pytest.approx(100, abs=1e-9), group


def test_values_are_stable_and_order_independent():
    a = build_metrics(levels(), CFG)
    shuffled = {k: v.iloc[::-1].reset_index(drop=True) for k, v in levels().items()}
    b = build_metrics(shuffled, CFG)
    assert a == build_metrics(levels(), CFG)
    for lv in ("la", "ew", "locality", "dz"):
        for mid in ("tw_car", "tw_pt", "tw_cycle"):
            got_a = dict(zip(a["values"][lv]["codes"], a["values"][lv][mid]))
            got_b = dict(zip(b["values"][lv]["codes"], b["values"][lv][mid]))
            assert got_a == got_b, (lv, mid)


def test_urban_effect_follows_density():
    """The densest council area (S2, a city) travels to work by car less than the most rural."""
    la = build_metrics(levels(), CFG)["values"]["la"]
    by_code = dict(zip(la["codes"], la["tw_car"]))
    assert by_code["S2"] < by_code["S1"]


def test_percentages_stay_in_range_and_metadata_is_marked():
    out = build_metrics(levels(), CFG)
    for m in out["metrics"]:
        if m["source"] != "synthetic":
            continue
        assert m["levels"] == CFG["levels"]
        if m["unit"] == "%":
            for lv in CFG["levels"]:
                vals = [v for v in out["values"][lv][m["id"]] if v is not None]
                assert all(0 <= v <= 100 for v in vals), m["id"]
    real = {m["id"]: m["source"] for m in out["metrics"]}
    assert real["pop"] == real["density"] == "census"
    assert out["synthetic_note"]


def test_round_shares_keeps_sum_exact():
    shares = np.array([[33.333333, 33.333333, 33.333334], [10.04, 20.04, 69.92], [np.nan, 50, 50]])
    out = synthetic.round_shares(shares, 1)
    assert out[0].sum() == pytest.approx(100) and out[1].sum() == pytest.approx(100)
    assert np.isnan(out[2]).all()


def test_noise_is_deterministic_standard_normal():
    draws = np.array([synthetic.noise(1, "m", f"c{i}") for i in range(4000)])
    assert synthetic.noise(1, "m", "c0") == draws[0]
    assert abs(draws.mean()) < 0.06 and abs(draws.std() - 1) < 0.06


def test_share_group_requires_percent_unit():
    cfg = {**CFG, "metrics": [*CFG["metrics"],
                              {"id": "x", "label": "X", "unit": "people", "scheme": "Blues",
                               "source": "synthetic", "share_group": "age",
                               "synthetic": {"base": 1, "urban": 0, "spread": 1}}]}
    with pytest.raises(ConfigError, match="share_group"):
        validate_metrics_config(cfg)


def test_synthetic_metric_needs_params():
    cfg = {**CFG, "metrics": [*CFG["metrics"], {"id": "y", "label": "Y", "scheme": "Blues",
                                                "source": "synthetic", "synthetic": {"base": 1}}]}
    with pytest.raises(ConfigError, match="synthetic needs"):
        validate_metrics_config(cfg)
