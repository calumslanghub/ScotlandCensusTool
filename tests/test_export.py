from __future__ import annotations

import gzip
import json
import re
from pathlib import Path

import geopandas as gpd
import pandas as pd
import pytest
import shapely
from shapely.geometry import box

from build.export import export_all, oversized, size_summary
from build.load import SCHEMA

WEST, EAST, EMPTY = "S12000001", "S12000002", "S12000003"
INDEX_FIELDS = ["code", "name", "level", "parent_code", "pop", "bbox"]


def layer(level: str, rows: list[tuple], extra: dict | None = None) -> gpd.GeoDataFrame:
    """rows: (code, parent_code, pop, geometry)."""
    df = pd.DataFrame({
        "code": [r[0] for r in rows], "name": [f"name {r[0]}" for r in rows], "level": level,
        "parent_code": [r[1] for r in rows], "pop": [r[2] for r in rows],
        "households": [None] * len(rows), "area_km2": [1.234567] * len(rows),
    }).astype({"code": "string", "name": "string", "parent_code": "string",
               "pop": "Int64", "households": "Int64"})
    for k, v in (extra or {}).items():
        df[k] = pd.array(v, dtype="string")
    return gpd.GeoDataFrame(df, geometry=[r[3] for r in rows], crs="EPSG:4326")


@pytest.fixture
def levels() -> dict[str, gpd.GeoDataFrame]:
    w, e = box(-4.0, 56.0, -3.5, 56.5), box(-3.5, 56.0, -3.0, 56.5)
    return {
        "la": layer("la", [(WEST, None, 30, w), (EAST, None, 40, e),
                           (EMPTY, None, 0, box(-2, 56, -1.9, 56.1))]),
        "locality": layer("locality", [("L1", WEST, 5, box(-3.9, 56.1, -3.8, 56.2))]),
        "oa": layer("oa", [("OA1", WEST, 10, box(-3.987654321, 56.0, -3.6, 56.3, ccw=False)),
                           ("OA2", WEST, None, box(-3.6, 56.0, -3.5, 56.3)),
                           ("OA3", EAST, 40, e)],
                    extra={"locality_code": ["L1", None, None]}),
    }


def make_cfg(out: Path, use_gzip: bool = True) -> dict:
    return {
        "assign": {"la_level": "la", "locality_level": "locality"},
        "levels": {lv: {"label": lv.upper()} for lv in ("la", "locality", "oa")},
        "export": {"out_dir": str(out), "gzip": use_gzip, "gzip_level": 9,
                   "manifest_file": "manifest.json", "metrics_file": "metrics.json",
                   "explorer_file": "explorer.json",
                   "coordinate_precision": 5, "max_file_mb": 5,
                   "la_file": "la.geojson",
                   "per_la_levels": ["locality", "oa"],
                   "per_la_path": "{level}/{la_code}.geojson",
                   "index_fields": INDEX_FIELDS,
                   "index_file": "index.json", "index_levels": ["la", "locality"],
                   "per_la_index_path": "index/{la_code}.json",
                   "per_la_index_levels": ["oa"]},
    }


@pytest.fixture
def out(tmp_path) -> Path:
    return tmp_path / "out"


@pytest.fixture
def cfg(out) -> dict:
    return make_cfg(out)


def read_text(path: Path) -> str:
    data = path.read_bytes()
    return (gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data).decode("utf-8")


def read(path: Path) -> dict:
    return json.loads(read_text(path))


def records(index: dict) -> dict[str, dict]:
    return {row[0]: dict(zip(index["fields"], row)) for row in index["rows"]}


def test_writes_only_gzipped_files(levels, cfg, out):
    files = export_all(levels, cfg)
    written = sorted(p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file())
    assert [n for n in written if not n.endswith(".gz")] == ["manifest.json"]
    assert written == sorted(files["file"])
    assert "la.geojson.gz" in written and "index.json.gz" in written
    for sub in ("locality", "oa", "index"):
        assert len(list((out / sub).glob("*.gz"))) == 3  # one per LA, incl. the empty one
    assert len(files) == 1 + 2 * 3 + 1 + 3 + 1  # la, per-LA x2, index, per-LA index, manifest


def test_gzip_is_deterministic(levels, cfg, out):
    export_all(levels, cfg)
    first = (out / "oa" / f"{WEST}.geojson.gz").read_bytes()
    export_all(levels, cfg)
    assert (out / "oa" / f"{WEST}.geojson.gz").read_bytes() == first


def test_plain_output_when_gzip_off(levels, out):
    export_all(levels, make_cfg(out, use_gzip=False))
    assert (out / "oa" / f"{WEST}.geojson").exists()
    assert not list(out.rglob("*.gz"))
    assert read(out / "manifest.json")["per_la"]["oa"] == "oa/{la_code}.geojson"


def test_json_is_minified(levels, cfg, out):
    export_all(levels, cfg)
    for name in (f"oa/{WEST}.geojson.gz", "index.json.gz", f"index/{WEST}.json.gz"):
        text = read_text(out / name)
        assert "\n" not in text
        assert dumps_compact(json.loads(text)) == text


def dumps_compact(obj) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def test_per_la_split_by_parent_code(levels, cfg, out):
    export_all(levels, cfg)
    west = read(out / "oa" / f"{WEST}.geojson.gz")
    assert [f["properties"]["code"] for f in west["features"]] == ["OA1", "OA2"]
    assert read(out / "oa" / f"{EMPTY}.geojson.gz") == {"type": "FeatureCollection", "features": []}


def test_properties_are_common_schema_plus_extras(levels, cfg, out):
    export_all(levels, cfg)
    props = read(out / "oa" / f"{WEST}.geojson.gz")["features"][0]["properties"]
    assert list(props) == [*SCHEMA, "locality_code"]
    assert props["area_km2"] == 1.2346
    assert props["households"] is None
    assert props["locality_code"] == "L1"


def test_geojson_is_rfc7946_with_5dp_coordinates(levels, cfg, out):
    export_all(levels, cfg)
    doc = read(out / "oa" / f"{WEST}.geojson.gz")
    assert "crs" not in doc
    text = read_text(out / "oa" / f"{WEST}.geojson.gz")
    coords = text.split('"geometry"', 1)[1]
    assert max(len(d) for d in re.findall(r"\.(\d+)", coords)) <= 5
    assert "-3.98765" in coords
    geom = shapely.geometry.shape(doc["features"][0]["geometry"])
    assert geom.exterior.is_ccw  # input ring was clockwise


def test_snapping_keeps_geometry_valid(levels, cfg, out):
    # A spike reaching to 0.000004 above the base edge: plain rounding to 5 dp
    # makes it touch the base, giving an invalid ring.
    spike = shapely.Polygon([(0, 0), (1, 0), (1, 1), (0.6, 1), (0.5, 0.000004), (0.4, 1), (0, 1)])
    assert spike.is_valid
    assert not shapely.transform(spike, lambda xy: xy.round(5)).is_valid
    levels["oa"].loc[0, "geometry"] = spike
    export_all(levels, cfg)
    geom = shapely.geometry.shape(read(out / "oa" / f"{WEST}.geojson.gz")["features"][0]["geometry"])
    assert geom.is_valid
    assert geom.area == pytest.approx(spike.area, rel=1e-3)


def test_numbers_printed_at_most_5dp():
    from build.export import shorten_numbers
    pattern = re.compile(r"-?\d+\.\d{6,}")
    text = '{"coordinates":[[-3.8475799999999998,56.152589999999996],[1.0,-0.00001]]}'
    assert shorten_numbers(text, pattern, 5) == '{"coordinates":[[-3.84758,56.15259],[1.0,-0.00001]]}'


def test_top_level_index_is_columnar_and_excludes_split_levels(levels, cfg, out):
    export_all(levels, cfg)
    index = read(out / "index.json.gz")
    assert index["fields"] == INDEX_FIELDS
    rows = records(index)
    assert set(rows) == {WEST, EAST, EMPTY, "L1"}
    assert rows[WEST]["parent_code"] is None
    assert rows["L1"] == {"code": "L1", "name": "name L1", "level": "locality",
                          "parent_code": WEST, "pop": 5, "bbox": [-3.9, 56.1, -3.8, 56.2]}


def test_per_la_index(levels, cfg, out):
    export_all(levels, cfg)
    west = records(read(out / "index" / f"{WEST}.json.gz"))
    assert set(west) == {"OA1", "OA2"}
    assert west["OA1"]["bbox"] == [-3.98765, 56.0, -3.6, 56.3]
    assert west["OA2"]["pop"] is None
    assert read(out / "index" / f"{EMPTY}.json.gz")["rows"] == []


def test_rerun_removes_stale_files_in_both_forms(levels, out):
    export_all(levels, make_cfg(out, use_gzip=False))
    stale = [out / "oa" / "S12999999.geojson.gz", out / "index" / "S12999999.json"]
    for p in stale:
        p.write_text("{}")
    unrelated = out / "notes.txt"
    unrelated.write_text("keep me")
    export_all(levels, make_cfg(out, use_gzip=True))
    assert not any(p.exists() for p in stale)
    assert not list(out.rglob("*.geojson"))
    assert [p.name for p in out.rglob("*.json")] == ["manifest.json"]
    assert unrelated.exists()


def test_size_report_uses_bytes_on_disk(levels, cfg):
    files = export_all(levels, cfg)
    gz = files[files["file"].str.endswith(".gz")]
    big = gz[gz["raw_bytes"] > 500]  # gzip header outweighs savings on tiny files
    assert len(big) and (big["bytes"] < big["raw_bytes"]).all()
    limit_mb = files["bytes"].max() / 1e6 - 1e-6  # only the biggest on-disk file is over
    assert len(oversized(files, limit_mb)) == 1
    summary = size_summary(files, limit_mb).set_index("level")
    assert summary["over_limit"].sum() == 1
    assert summary.loc["oa", "files"] == 3


def test_manifest_lists_served_paths(levels, cfg, out):
    export_all(levels, cfg, metrics={"metrics": []}, explorer={"categories": []})
    m = read(out / "manifest.json")
    assert m["la_file"] == "la.geojson.gz"
    assert m["per_la"] == {"locality": "locality/{la_code}.geojson.gz",
                           "oa": "oa/{la_code}.geojson.gz"}
    assert m["per_la_index"] == "index/{la_code}.json.gz"
    assert m["metrics_file"] == "metrics.json.gz"
    assert m["explorer_file"] == "explorer.json.gz"
    assert m["la_codes"] == sorted([WEST, EAST, EMPTY])
    assert m["levels"]["oa"] == {"label": "OA", "plural": "OAs"}
    for path in [m["la_file"], m["index_file"], m["metrics_file"], m["explorer_file"],
                 *(t.format(la_code=WEST) for t in [*m["per_la"].values(), m["per_la_index"]])]:
        assert (out / path).exists(), path


def test_publish_copies_out_dir(levels, cfg, tmp_path, monkeypatch):
    import build.export as export
    monkeypatch.setattr(export, "PROJECT_ROOT", tmp_path)
    cfg["export"]["publish_dir"] = str(tmp_path / "web" / "data")
    (tmp_path / "web" / "data").mkdir(parents=True)
    (tmp_path / "web" / "data" / "stale.txt").write_text("x")
    export_all(levels, cfg)
    published = tmp_path / "web" / "data"
    assert (published / "manifest.json").exists() and (published / "la.geojson.gz").exists()
    assert not (published / "stale.txt").exists()


def test_publish_refuses_dirs_outside_project_or_containing_out_dir(levels, cfg, tmp_path, monkeypatch):
    import build.export as export
    monkeypatch.setattr(export, "PROJECT_ROOT", tmp_path / "project")
    cfg["export"]["publish_dir"] = str(tmp_path / "elsewhere")
    with pytest.raises(ValueError):
        export_all(levels, cfg)


def test_national_levels_written_once_and_listed(levels, cfg, out):
    cfg["export"]["national_levels"] = ["oa"]
    cfg["export"]["national_path"] = "{level}.geojson"
    files = export_all(levels, cfg, metrics={"metrics": []}, explorer={"categories": []})
    m = read(out / "manifest.json")
    assert m["national"] == {"oa": "oa.geojson.gz"}
    fc = read(out / "oa.geojson.gz")
    assert len(fc["features"]) == len(levels["oa"])
    assert files[files["file"] == "oa.geojson.gz"]["features"].item() == len(levels["oa"])
    # a rerun without national_levels removes the national file
    cfg["export"]["national_levels"] = []
    export_all(levels, cfg, metrics={"metrics": []})
    assert not (out / "oa.geojson.gz").exists()


# --- Census table values: one file per dataset -----------------------------------------

def census_metrics() -> dict:
    return {"metrics": [{"id": "pop"}, {"id": "t__a", "dataset": "t"}, {"id": "t__b", "dataset": "t"},
                        {"id": "u__a", "dataset": "u"}],
            "values": {"la": {"codes": [WEST, EAST], "pop": [1, 2], "t__a": [3, 4], "t__b": [5, 6], "u__a": [7, None]},
                       "locality": {"codes": ["L1"], "pop": [9], "t__a": [1], "t__b": [2], "u__a": [3]}}}


def test_dataset_values_leave_metrics_json_for_one_file_per_dataset_and_level(levels, cfg, out):
    cfg["export"]["dataset_values_path"] = "values/{level}/{dataset}.json"
    files = export_all(levels, cfg, metrics=census_metrics())
    m = read(out / "metrics.json.gz")
    assert m["values"] == {"la": {"codes": [WEST, EAST], "pop": [1, 2]},
                           "locality": {"codes": ["L1"], "pop": [9]}}
    assert len(m["metrics"]) == 4                                   # definitions all stay
    assert read(out / "values/la/t.json.gz") == {"codes": [WEST, EAST], "t__a": [3, 4], "t__b": [5, 6]}
    assert read(out / "values/locality/u.json.gz") == {"codes": ["L1"], "u__a": [3]}
    assert read(out / "manifest.json")["dataset_values"] == "values/{level}/{dataset}.json.gz"
    assert (files["level"] == "dataset_values").sum() == 4          # 2 datasets x 2 levels


def test_metrics_json_keeps_dataset_values_without_a_dataset_path(levels, cfg, out):
    export_all(levels, cfg, metrics=census_metrics())
    assert read(out / "metrics.json.gz")["values"]["la"]["t__a"] == [3, 4]
    assert read(out / "manifest.json")["dataset_values"] is None


def test_oa_values_written_per_la_and_dataset_and_stale_ones_removed(levels, cfg, out):
    cfg["export"]["oa_values_path"] = "values/oa/{la_code}/{dataset}.json"
    cfg["census"] = {"oa_level": "oa"}
    oa_values = {WEST: {"t": {"codes": ["OA1", "OA2"], "t__a": [1, None]},
                        "u": {"codes": ["OA1", "OA2"], "u__a": [2, 3]}},
                 EAST: {"t": {"codes": ["OA3"], "t__a": [4]}, "u": {"codes": ["OA3"], "u__a": [5]}}}
    export_all(levels, cfg, oa_values=oa_values)
    assert read(out / f"values/oa/{WEST}/t.json.gz") == {"codes": ["OA1", "OA2"], "t__a": [1, None]}
    assert read(out / f"values/oa/{EAST}/u.json.gz") == {"codes": ["OA3"], "u__a": [5]}
    assert read(out / f"values/oa/{EMPTY}/u.json.gz") == {"codes": []}     # every LA has every file
    assert read(out / "manifest.json")["oa_values"] == "values/oa/{la_code}/{dataset}.json.gz"
    # the earlier layout (one file per LA) and a dropped dataset's files go on the next run
    stale = [out / "values/oa/S12999999.json.gz", out / f"values/oa/{WEST}/gone.json.gz"]
    for p in stale:
        p.write_text("{}")
    export_all(levels, cfg, oa_values=oa_values)
    assert not any(p.exists() for p in stale)
    assert (out / f"values/oa/{WEST}/t.json.gz").exists()


@pytest.mark.parametrize("key, path", [("dataset_values_path", "values/{level}.json"),
                                       ("oa_values_path", "values/oa/{la_code}.json")])
def test_value_paths_need_a_dataset_placeholder(key, path):
    from build.config import ConfigError, load_levels_config, validate_levels_config
    cfg = load_levels_config()
    cfg["export"][key] = path
    with pytest.raises(ConfigError, match=key):
        validate_levels_config(cfg)


# --- OA value files are announced to the front end ---------------------------------

def test_neighbour_lists_exported_as_arrays_and_listed_in_manifest(levels, cfg, out):
    oa = levels["oa"].copy()
    oa["neighbour_codes"] = pd.Series([["OA2"], ["OA1", "OA3"], []], index=oa.index, dtype=object)
    levels["oa"] = oa
    cfg["assign"]["neighbours"] = [{"level": "oa", "field": "neighbour_codes"}]
    export_all(levels, cfg)
    assert read(out / "manifest.json")["neighbours"] == {"oa": "neighbour_codes"}
    features = read(out / f"oa/{WEST}.geojson.gz")["features"]
    assert {f["properties"]["code"]: f["properties"]["neighbour_codes"] for f in features} == {
        "OA1": ["OA2"], "OA2": ["OA1", "OA3"]}


def test_manifest_announces_oa_values_and_level():
    from build.config import load_levels_config
    from build.export import build_manifest
    manifest = build_manifest(load_levels_config(), ["S1"])
    assert "{la_code}" in manifest["oa_values"] and "{dataset}" in manifest["oa_values"]
    assert "{level}" in manifest["dataset_values"] and "{dataset}" in manifest["dataset_values"]
    assert manifest["oa_level"] == "oa"


def test_manifest_lists_oa_group_fields():
    """The front end finds each OA's ward / data zone / locality through these fields."""
    from build.config import load_levels_config
    from build.export import build_manifest
    cfg = load_levels_config()
    assert build_manifest(cfg, ["S1"])["oa_groups"] == cfg["census"]["groups"]


def test_manifest_fails_when_oa_values_have_no_level():
    from build.config import ConfigError, load_levels_config
    from build.export import build_manifest
    cfg = load_levels_config()
    cfg["census"].pop("oa_level")
    with pytest.raises(ConfigError, match="oa_level"):
        build_manifest(cfg, ["S1"])


def test_published_manifest_has_oa_keys():
    from build.config import load_levels_config, resolve_path
    path = resolve_path(load_levels_config()["export"]["publish_dir"]) / "manifest.json"
    if not path.exists():
        pytest.skip("run `python -m build.run` first")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    assert manifest["oa_level"] == "oa" and "{la_code}" in manifest["oa_values"]
    assert "{dataset}" in manifest["oa_values"] and "{dataset}" in manifest["dataset_values"]
