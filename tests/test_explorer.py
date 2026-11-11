from __future__ import annotations

import copy
import gzip
import json
from pathlib import Path

import pandas as pd
import pytest
import yaml

import build.explorer as explorer_mod
import build.run as run_mod
from build.census import CensusMetrics, load_datasets, metric_defs, with_dataset_metrics
from build.config import ConfigError, load_levels_config, resolve_path
from build.explorer import (load_explorer_config, reference_gaps, validate_explorer_config,
                            visible_config)
from build.metrics import build_metrics, load_metrics_config

DATASETS = load_datasets()
METRICS_CFG = with_dataset_metrics(load_metrics_config(), DATASETS)
LEVELS_CFG = load_levels_config()
LA_LEVEL = "la"


@pytest.fixture
def raw_yaml() -> dict:
    """config/explorer.yaml as written (dataset indicators use the dataset's local ids)."""
    with open(explorer_mod.EXPLORER_PATH, encoding="utf-8") as f:
        return yaml.safe_load(f)


@pytest.fixture
def raw_cfg(raw_yaml) -> dict:
    """The same config with dataset indicators expanded to metric ids, as the build sees it."""
    return visible_config(raw_yaml, DATASETS)


def fake_census(levels: dict[str, pd.DataFrame]) -> CensusMetrics:
    """A value for every dataset metric at every level, so charts can be checked without CSVs."""
    ids = [d["id"] for ds in DATASETS.values() if ds.get("status") == "ready" for d in metric_defs(ds)]
    census = CensusMetrics(levels=list(levels), oa=pd.DataFrame({i: [] for i in ids}))
    census.values = {lv: {i: [1.0] * len(df) for i in ids} for lv, df in levels.items()}
    census.national = {i: 1.0 for i in ids}
    return census


def indicator(cfg: dict, ind_id: str) -> dict:
    return next(i for c in cfg["categories"] for i in c["indicators"] if i["id"] == ind_id)


def write_yaml(path: Path, cfg: dict) -> Path:
    path.write_text(yaml.safe_dump(cfg, allow_unicode=True), encoding="utf-8")
    return path


def small_levels() -> dict[str, pd.DataFrame]:
    la = pd.DataFrame({"code": ["A", "B", "C"], "parent_code": [None] * 3,
                       "pop": pd.array([5000, 600000, 90000], dtype="Int64"),
                       "households": pd.array([2000, 290000, 40000], dtype="Int64"),
                       "area_km2": [3000.0, 175.0, 900.0]})
    loc = pd.DataFrame({"code": ["L1", "L2", "L3"], "parent_code": ["A", "B", "B"],
                        "pop": pd.array([800, 550000, 12], dtype="Int64"),
                        "households": pd.array([None, None, None], dtype="Int64"),
                        "area_km2": [2.5, 150.0, 0.01]})
    ew = pd.DataFrame({"code": ["W1", "W2"], "parent_code": ["A", "C"],
                       "pop": pd.array([5000, 90000], dtype="Int64"),
                       "households": pd.array([2000, 40000], dtype="Int64"), "area_km2": [3000.0, 900.0]})
    dz = pd.DataFrame({"code": ["D1"], "parent_code": ["B"], "pop": pd.array([700], dtype="Int64"),
                       "households": pd.array([300], dtype="Int64"), "area_km2": [0.2]})
    cc = pd.DataFrame({"code": ["CC1", "CC2"], "parent_code": ["A", "A"],
                       "pop": pd.array([1200, None], dtype="Int64"),   # CC2 holds no output area
                       "households": pd.array([500, None], dtype="Int64"), "area_km2": [80.0, 2.0]})
    return {"la": la, "ew": ew, "locality": loc, "dz": dz, "cc": cc}


# --- the repo config ---------------------------------------------------------

def test_repo_config_is_valid():
    cfg = load_explorer_config(METRICS_CFG, levels_cfg=LEVELS_CFG)
    assert cfg["categories"], "at least one visible category"
    ids = [i["id"] for c in cfg["categories"] for i in c["indicators"]]
    assert {"age", "marital", "religion", "passports", "gaelic", "language", "general_health",
            "disability", "conditions", "accommodation", "tenure", "household_size", "occupancy",
            "qualifications", "economic_activity", "cars"} <= set(ids)
    assert [c["label"] for c in cfg["categories"]] == [
        "Demographics", "Households", "Identity", "Language", "Health", "Housing", "Education",
        "Employment", "Transport"]


def test_every_ready_dataset_has_an_indicator():
    """A table that is built but shown nowhere would only cost download size."""
    cfg = load_explorer_config(METRICS_CFG, levels_cfg=LEVELS_CFG)
    shown = {m.split("__")[0] for c in cfg["categories"] for i in c["indicators"] for m in [i["metric"]]}
    ready = {k for k, d in DATASETS.items() if d.get("status") == "ready"}
    assert ready - shown == set()


def test_breakdown_panels_cover_every_split_of_their_dataset():
    """Each `group` a dataset splits its categories by (age, sex) has a breakdown panel listing
    every category that has that split, so no built split is unreachable."""
    cfg = load_explorer_config(METRICS_CFG, levels_cfg=LEVELS_CFG)
    for c in cfg["categories"]:
        for ind in c["indicators"]:
            ds = DATASETS.get(ind["metric"].split("__")[0])
            if not ds:
                continue
            for group in {cat["group"] for cat in ds["categories"] if cat.get("group")}:
                parents = {f"{ds['id']}__{cat['parent']}" for cat in ds["categories"] if cat.get("group") == group}
                listed = {s for p in ind["panels"] if p.get("group") == group for s in p["series"]}
                assert parents == listed, (ind["id"], group)


def test_dataset_indicators_hidden_until_ready(tmp_path):
    cfg = load_explorer_config(METRICS_CFG, datasets_dir=tmp_path, levels_cfg=LEVELS_CFG)  # no dataset files
    shown = [i for c in cfg["categories"] for i in c["indicators"]]
    assert not any("dataset" in i for i in shown)
    assert "industry_census" in cfg["hidden_indicators"]


def test_draft_dataset_indicators_stay_hidden():
    """UV608 is a draft (its download is truncated), so its indicator is not shown."""
    cfg = load_explorer_config(METRICS_CFG, levels_cfg=LEVELS_CFG)
    assert cfg["hidden_indicators"] == ["ns_sec_hrp"]
    assert "ns_sec_hrp" not in [i["id"] for c in cfg["categories"] for i in c["indicators"]]


def test_dataset_indicator_expands_local_ids():
    cfg = load_explorer_config(METRICS_CFG, levels_cfg=LEVELS_CFG)
    ind = indicator(cfg, "marital")
    assert ind["metric"] == "uv104_marital_status__married"
    assert ind["panels"][0]["series"][0] == "uv104_marital_status__never_married"
    assert ind["metric"] in ind["map"]["options"]
    assert ind["map"]["scheme"] == "Purples"          # defaults to the dataset's scheme
    mean = indicator(cfg, "age")
    assert mean["metric"] == "uv103_age__mean_age" and mean["map"]["options"][0] == mean["metric"]


def test_age_breakdown_panel_keeps_its_group():
    cfg = load_explorer_config(METRICS_CFG, levels_cfg=LEVELS_CFG)
    ind = indicator(cfg, "travel_work")
    by_age = next(p for p in ind["panels"] if p.get("group") == "age")
    assert by_age["type"] == "breakdown" and "uv701_travel_to_work__driving" in by_age["series"]
    assert "uv701_travel_to_work__driving_a16_24" in ind["map"]["options"]   # mappable from the pie


def test_unknown_panel_group_names_indicator_and_dataset(raw_yaml):
    next(p for p in indicator(raw_yaml, "commute_distance")["panels"] if p.get("group"))["group"] = "sex"
    with pytest.raises(ConfigError, match=r"indicator 'commute_distance'.*group 'sex'.*uv703_distance_to_work"):
        visible_config(raw_yaml, DATASETS)


def test_unknown_headline_names_indicator_and_dataset(raw_yaml):
    indicator(raw_yaml, "marital")["headline"] = "nope"
    with pytest.raises(ConfigError, match=r"indicator 'marital'.*'nope'.*uv104_marital_status"):
        visible_config(raw_yaml, DATASETS)


# --- validation failures name the indicator ---------------------------------

def test_bad_metric_id_fails_with_indicator_id(raw_yaml, tmp_path):
    indicator(raw_yaml, "density")["metric"] = "densityy"
    path = write_yaml(tmp_path / "explorer.yaml", raw_yaml)
    with pytest.raises(ConfigError, match=r"indicator 'density'.*'densityy'.*metrics\.yaml"):
        load_explorer_config(METRICS_CFG, path=path, levels_cfg=LEVELS_CFG)


def test_bad_metric_id_fails_the_build_before_loading_data(raw_yaml, tmp_path, monkeypatch):
    indicator(raw_yaml, "density")["metric"] = "no_such_metric"
    monkeypatch.setattr(explorer_mod, "EXPLORER_PATH", write_yaml(tmp_path / "e.yaml", raw_yaml))

    def must_not_load(*_a, **_k):
        raise AssertionError("build loaded data before validating explorer.yaml")

    monkeypatch.setattr(run_mod, "load_all", must_not_load)
    with pytest.raises(ConfigError, match="indicator 'density'.*'no_such_metric'"):
        run_mod.run_build(load_levels_config())


@pytest.mark.parametrize("ind_id, mutate, message", [
    ("tenure", lambda i: i["panels"][0]["series"].append("ten_council"),
     r"indicator 'tenure'.*series 'ten_council'"),
    ("household_size", lambda i: i["map"].update(scheme="Rainbow"),
     r"indicator 'household_size'.*scheme 'Rainbow'"),
    ("qualifications", lambda i: i["panels"][0].update(reference_lines=["national", "region"]),
     r"indicator 'qualifications'.*reference_lines \['region'\]"),
    ("conditions", lambda i: i["panels"][-1].update(mark="line"), r"indicator 'conditions'.*mark 'line'"),
    ("population", lambda i: i["panels"][0].update(scale="log"), r"indicator 'population'.*log"),
    ("qualifications", lambda i: i["panels"][0].update(type="pie"), r"indicator 'qualifications'.*type 'pie'"),
    ("accommodation", lambda i: i["map"]["options"].append("uv402_accommodation__hut"),
     r"indicator 'accommodation'.*map option 'uv402_accommodation__hut'"),
    ("travel_work", lambda i: i["panels"][0].update(group="age"),
     r"indicator 'travel_work'.*only a breakdown panel can pick a category group"),
])
def test_invalid_indicator_names_it(raw_cfg, ind_id, mutate, message):
    mutate(indicator(raw_cfg, ind_id))
    with pytest.raises(ConfigError, match=message):
        validate_explorer_config(raw_cfg, METRICS_CFG, LEVELS_CFG)


def test_unknown_summary_card_fails(raw_cfg):
    raw_cfg["summary_cards"] = ["pop", "nope"]
    with pytest.raises(ConfigError, match="summary_cards.*nope"):
        validate_explorer_config(raw_cfg, METRICS_CFG, LEVELS_CFG)


# --- compare / baseline / selector keys ----------------------------------------

def test_repo_compare_and_baseline_are_valid(raw_cfg):
    validate_explorer_config(raw_cfg, METRICS_CFG, LEVELS_CFG)
    assert {"oa", "dz"} <= set(raw_cfg["baseline"]["levels"])


def test_repo_drill_mode_shows_neighbouring_wards(raw_cfg):
    assert mode(raw_cfg, "drill")["path"][2] == {"level": "oa", "link": "ward_code", "neighbours": True}
    assert {"level": "ew", "field": "neighbour_codes"} in LEVELS_CFG["assign"]["neighbours"]


def test_repo_basemap_is_valid(raw_cfg):
    b = raw_cfg["basemap"]
    assert b["tiles"] and b["label_tiles"] and set(b["fill_opacity"]) == {"oa", "postcode"}


@pytest.mark.parametrize("key, value, message", [
    ("tiles", [], r"basemap\.tiles must be a non-empty list"),
    ("tiles", ["http://a.example/{z}/{x}/{y}.png"], r"basemap\.tiles.*https"),
    ("label_tiles", ["https://a.example/{z}/{x}.png"], r"basemap\.label_tiles"),
    ("attribution", "", r"basemap\.attribution is required"),
    ("tile_size", 0, r"basemap\.tile_size must be a positive integer"),
    ("fill_opacity", {"oa": 1.5}, r"basemap\.fill_opacity\.oa must be a number 0\.\.1"),
    ("fill_opacity", {"ward": 0.5}, r"basemap\.fill_opacity: unknown levels \['ward'\]"),
    ("context_opacity", -0.1, r"basemap\.context_opacity must be a number 0\.\.1"),
    ("style", "dark", r"basemap: unknown keys \['style'\]"),
])
def test_invalid_basemap(raw_cfg, key, value, message):
    raw_cfg["basemap"][key] = value
    with pytest.raises(ConfigError, match=message):
        validate_explorer_config(raw_cfg, METRICS_CFG, LEVELS_CFG)


@pytest.mark.parametrize("block, value, message", [
    ("compare", {"max_items": 5, "same_level_only": True}, r"compare\.max_items.*2\.\.4"),
    ("compare", {"max_items": 1, "same_level_only": True}, r"compare\.max_items"),
    ("compare", {"max_items": "4"}, r"compare\.max_items"),
    ("compare", {"max_items": 3, "same_level_only": False}, r"same_level_only"),
    ("compare", {"max_items": 3, "colours": []}, r"compare: unknown keys \['colours'\]"),
    ("baseline", {"modes": [], "scheme": "diverging", "levels": ["la"]}, r"baseline\.modes"),
    ("baseline", {"modes": ["ratio"], "scheme": "diverging", "levels": ["la"]}, r"baseline\.modes.*'ratio'"),
    ("baseline", {"modes": ["relative"], "scheme": "Blues", "levels": ["la"]}, r"baseline\.scheme.*'Blues'"),
    ("baseline", {"modes": ["relative"], "scheme": "diverging", "levels": ["la", "ward"]},
     r"baseline\.levels.*\['ward'\]"),
    ("baseline", {"modes": ["relative"], "scheme": "diverging", "levels": ["la"], "colour": "x"},
     r"baseline: unknown keys \['colour'\]"),
    ("baseline", {"modes": ["relative"], "scheme": "diverging", "levels": ["la"],
                  "min_denominator": {"field": "area_km2", "value": 5}}, r"min_denominator\.field"),
    ("baseline", {"modes": ["relative"], "scheme": "diverging", "levels": ["la"],
                  "min_denominator": {"field": "pop", "value": -1}}, r"min_denominator\.value"),
    ("baseline", {"modes": ["relative"], "scheme": "diverging", "levels": ["la"],
                  "min_denominator": 50}, r"min_denominator needs \{field, value\}"),
])
def test_invalid_compare_or_baseline(raw_cfg, block, value, message):
    raw_cfg[block] = value
    with pytest.raises(ConfigError, match=message):
        validate_explorer_config(raw_cfg, METRICS_CFG, LEVELS_CFG)


def test_repo_query_is_valid(raw_cfg):
    q = raw_cfg["query"]
    assert set(q["needs_scope"]) <= set(q["levels"]) and "oa" in q["levels"]


QUERY = {"levels": ["la", "ew", "oa"], "scopes": ["la", "ew"], "needs_scope": ["oa"],
         "preset_band": 25, "max_criteria": 6, "scheme": "Purples"}


@pytest.mark.parametrize("key, value, message", [
    ("levels", ["la", "ward"], r"query\.levels.*\['ward'\]"),
    ("levels", [], r"query\.levels"),
    ("scopes", ["parish"], r"query\.scopes.*\['parish'\]"),
    ("needs_scope", ["dz"], r"query\.needs_scope.*\['dz'\]"),
    ("preset_band", 0, r"query\.preset_band.*1\.\.50"),
    ("preset_band", 60, r"query\.preset_band"),
    ("max_criteria", 1, r"query\.max_criteria.*2\.\.8"),
    ("max_criteria", True, r"query\.max_criteria"),
    ("scheme", "Rainbow", r"query\.scheme.*'Rainbow'"),
    ("colour", "x", r"query: unknown keys \['colour'\]"),
])
def test_invalid_query(raw_cfg, key, value, message):
    raw_cfg["query"] = {**QUERY, key: value}
    with pytest.raises(ConfigError, match=message):
        validate_explorer_config(raw_cfg, METRICS_CFG, LEVELS_CFG)


CLUSTER = {"enabled": True, "k_max": 10, "restarts": 4, "max_iter": 100, "seed": 2022, "min_pop": 50,
           "silhouette_sample": 2000, "max_work": 2.0e10, "min_cores": 4, "min_memory_gb": 4}


def test_repo_cluster_is_valid(raw_cfg):
    assert raw_cfg["cluster"]["enabled"] is True and raw_cfg["cluster"]["k_max"] <= 10


@pytest.mark.parametrize("key, value, message", [
    ("enabled", "yes", r"cluster\.enabled must be true or false"),
    ("k_max", 11, r"cluster\.k_max.*2\.\.10"),
    ("k_max", 1, r"cluster\.k_max"),
    ("restarts", 0, r"cluster\.restarts must be a positive integer"),
    ("max_iter", 2.5, r"cluster\.max_iter"),
    ("seed", -1, r"cluster\.seed"),
    ("min_pop", -5, r"cluster\.min_pop must be a number >= 0"),
    ("max_work", "big", r"cluster\.max_work"),
    ("min_memory_gb", True, r"cluster\.min_memory_gb"),
    ("colours", [], r"cluster: unknown keys \['colours'\]"),
])
def test_invalid_cluster(raw_cfg, key, value, message):
    raw_cfg["cluster"] = {**CLUSTER, key: value}
    with pytest.raises(ConfigError, match=message):
        validate_explorer_config(raw_cfg, METRICS_CFG, LEVELS_CFG)


def test_cluster_needs_the_query_block(raw_cfg):
    del raw_cfg["query"]
    raw_cfg["cluster"] = CLUSTER
    with pytest.raises(ConfigError, match=r"cluster: needs the query block"):
        validate_explorer_config(raw_cfg, METRICS_CFG, LEVELS_CFG)
    validate_explorer_config({**raw_cfg, "cluster": {**CLUSTER, "enabled": False}}, METRICS_CFG, LEVELS_CFG)


def test_query_block_reaches_explorer_json():
    cfg = load_explorer_config(METRICS_CFG, levels_cfg=LEVELS_CFG)
    assert cfg["query"]["levels"][0] == "la"


def test_baseline_oa_level_needs_levels_config(raw_cfg):
    """oa is a geography level but not a metrics level: it is valid only against levels.yaml."""
    with pytest.raises(ConfigError, match=r"baseline\.levels.*\['oa'\]"):
        validate_explorer_config(raw_cfg, METRICS_CFG)


def test_selector_must_be_category(raw_cfg):
    indicator(raw_cfg, "age")["map"]["selector"] = "dropdown"
    with pytest.raises(ConfigError, match=r"indicator 'age'.*map\.selector"):
        validate_explorer_config(raw_cfg, METRICS_CFG, LEVELS_CFG)


def test_selector_needs_a_series_panel(raw_cfg):
    indicator(raw_cfg, "population")["map"]["selector"] = "category"
    with pytest.raises(ConfigError, match=r"indicator 'population'.*selector needs a profile or composition"):
        validate_explorer_config(raw_cfg, METRICS_CFG, LEVELS_CFG)


def test_composition_series_must_be_metrics(raw_cfg):
    indicator(raw_cfg, "language")["panels"][0]["series"].append("ind_mining")
    with pytest.raises(ConfigError, match=r"indicator 'language'.*series 'ind_mining'"):
        validate_explorer_config(raw_cfg, METRICS_CFG, LEVELS_CFG)


def test_breakdown_panel_is_a_series_panel(raw_cfg):
    indicator(raw_cfg, "accommodation")["panels"][1].pop("series")
    with pytest.raises(ConfigError, match=r"indicator 'accommodation'.*breakdown panel needs series"):
        validate_explorer_config(raw_cfg, METRICS_CFG, LEVELS_CFG)


# --- reference values exist in metrics.json ---------------------------------

def test_reference_values_exist_for_built_metrics():
    explorer = load_explorer_config(METRICS_CFG, levels_cfg=LEVELS_CFG)
    levels = small_levels()
    metrics = build_metrics(levels, METRICS_CFG, fake_census(levels))
    assert reference_gaps(explorer, metrics, LA_LEVEL) == []


def test_reference_gaps_are_reported():
    explorer = load_explorer_config(METRICS_CFG, levels_cfg=LEVELS_CFG)
    levels = small_levels()
    broken = copy.deepcopy(build_metrics(levels, METRICS_CFG, fake_census(levels)))
    next(m for m in broken["metrics"] if m["id"] == "uv103_age__mean_age")["national"] = None
    broken["values"]["la"]["uv501_qualifications__none"][1] = None
    del broken["values"]["locality"]["uv405_cars__mean_cars"]
    gaps = "\n".join(reference_gaps(explorer, broken, LA_LEVEL))
    assert "'uv103_age__mean_age'" in gaps and "no national value" in gaps
    assert "'uv501_qualifications__none'" in gaps and "1 council areas have no value" in gaps
    assert "'uv405_cars__mean_cars'" in gaps and "level 'locality'" in gaps


def published_file(manifest_key: str) -> Path | None:
    out_dir = resolve_path(load_levels_config()["export"]["out_dir"])
    manifest = out_dir / "manifest.json"
    if not manifest.exists():
        return None
    name = json.loads(manifest.read_text(encoding="utf-8")).get(manifest_key)
    return out_dir / name if name and (out_dir / name).exists() else None


def read_json(path: Path) -> dict:
    data = path.read_bytes()
    return json.loads(gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data)


def published_metrics(metrics_path: Path) -> dict:
    """metrics.json with the per-dataset value files (manifest `dataset_values`) merged back in."""
    metrics = read_json(metrics_path)
    out_dir = metrics_path.parent
    template = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8")).get("dataset_values")
    datasets = {m["dataset"] for m in metrics["metrics"] if m.get("dataset")} if template else set()
    for dataset in datasets:
        for level, cols in metrics["values"].items():
            path = out_dir / template.format(level=level, dataset=dataset)
            if path.exists():
                cols.update({k: v for k, v in read_json(path).items() if k != "codes"})
    return metrics


def test_published_metrics_file_holds_no_dataset_values():
    metrics_path = published_file("metrics_file")
    if not metrics_path:
        pytest.skip("run `python -m build.run` first")
    metrics = read_json(metrics_path)
    in_datasets = {m["id"] for m in metrics["metrics"] if m.get("dataset")}
    assert in_datasets
    assert not any(in_datasets & set(cols) for cols in metrics["values"].values())
    assert "pop" in metrics["values"]["la"] and metrics["values"]["la"]["codes"]


def test_every_ranked_chart_reference_value_is_in_published_metrics():
    metrics_path, explorer_path = published_file("metrics_file"), published_file("explorer_file")
    if not (metrics_path and explorer_path):
        pytest.skip("run `python -m build.run` first")
    explorer, metrics = read_json(explorer_path), published_metrics(metrics_path)
    ranked = [(i, p) for c in explorer["categories"] for i in c["indicators"]
              for p in i["panels"] if p["type"] == "ranked"]
    assert ranked
    assert reference_gaps(explorer, metrics, LA_LEVEL) == []
    meta = {m["id"]: m for m in metrics["metrics"]}
    for ind, panel in ranked:
        if "national" in panel["reference_lines"]:
            assert meta[ind["metric"]]["national"] is not None, ind["id"]
        if "la" in panel["reference_lines"]:
            assert None not in metrics["values"]["la"][ind["metric"]], ind["id"]


# --- map modes (drill paths) and overlays -------------------------------------------------

def mode(cfg: dict, mode_id: str) -> dict:
    return next(m for m in cfg["map_modes"] if m["id"] == mode_id)


def test_repo_map_modes(raw_cfg):
    validate_explorer_config(raw_cfg, METRICS_CFG, LEVELS_CFG)
    assert [s["level"] for s in mode(raw_cfg, "drill")["path"]] == ["la", "ew", "oa", "postcode"]
    assert [s["level"] for s in mode(raw_cfg, "localities")["path"]] == ["la", "locality", "oa", "postcode"]
    assert [s["level"] for s in mode(raw_cfg, "dz")["path"]] == ["dz"]


@pytest.mark.parametrize("mutate, message", [
    (lambda c: mode(c, "drill")["path"][2].update(link="locality"), r"'drill'.*'oa' cannot link on 'locality'"),
    (lambda c: mode(c, "drill")["path"][0].update(level="oa"), r"'drill'.*first step must be a national level"),
    (lambda c: mode(c, "dz")["path"][0].update(link="parent_code"), r"'dz'.*first step"),
    (lambda c: mode(c, "drill")["path"].append({"level": "dz", "link": "parent_code"}),
     r"'drill'.*'dz' has no per-LA file"),
    (lambda c: mode(c, "drill")["path"].insert(2, {"level": "locality", "link": "parent_code"}),
     r"'drill'.*'locality' links on parent_code, so the step before must be 'la'"),
    (lambda c: mode(c, "localities").update(overlays=["hatching"]), r"'localities'.*unknown overlays \['hatching'\]"),
    (lambda c: c["map_modes"].append({"id": "drill", "label": "Again", "path": [{"level": "la"}]}),
     r"unique id.*drill"),
    (lambda c: c["overlays"]["outside_localities"].update(field="ward"), r"overlay 'outside_localities'.*no field 'ward'"),
    (lambda c: c["overlays"]["outside_localities"].pop("at"), r"overlay 'outside_localities'.*missing \['at'\]"),
    (lambda c: mode(c, "localities")["path"][2].update(neighbours=True),
     r"'localities'.*'oa' shows neighbours, but 'locality' has no neighbour list"),
    (lambda c: mode(c, "drill")["path"][1].update(near=True), r"step: unknown keys \['near'\]"),
])
def test_invalid_map_modes_and_overlays(raw_cfg, mutate, message):
    mutate(raw_cfg)
    with pytest.raises(ConfigError, match=message):
        validate_explorer_config(raw_cfg, METRICS_CFG, LEVELS_CFG)
