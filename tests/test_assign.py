"""Unit tests for build/assign.py on small synthetic layers (EPSG:27700 metres)."""
from __future__ import annotations

import copy

import geopandas as gpd
import pandas as pd
import pytest
from shapely.geometry import Polygon, box

from build.assign import (MATCHED, MISSING_COUNCIL, MULTIPLE_MATCH, NO_MATCH, UNKNOWN_COUNCIL,
                          assign, assign_area_fields, join_largest_overlap, join_points,
                          localities_per_la, representative_points)
from build.config import ConfigError, validate_levels_config
from build.load import SCHEMA

CRS = "EPSG:27700"
WEST, EAST = "S12000001", "S12000002"


def layer(level: str, rows: list[dict]) -> gpd.GeoDataFrame:
    base = {"name": None, "level": level, "parent_code": None, "pop": 1, "households": 1,
            "area_km2": 1.0}
    df = pd.DataFrame([{**base, **{k: v for k, v in r.items() if k != "geometry"}} for r in rows])
    df["name"] = df["name"].fillna(df["code"])
    df = df.astype({"code": "string", "name": "string", "parent_code": "string",
                    "pop": "Int64", "households": "Int64"})
    return gpd.GeoDataFrame(df[list(SCHEMA)], geometry=[r["geometry"] for r in rows], crs=CRS)


@pytest.fixture
def levels() -> dict[str, gpd.GeoDataFrame]:
    """Two LAs side by side: west x 0-10, east x 10-20, each built from two OAs."""
    oa = layer("oa", [
        {"code": "OA1", "parent_code": WEST, "pop": 10, "geometry": box(0, 0, 10, 5)},
        {"code": "OA2", "parent_code": WEST, "pop": 20, "geometry": box(0, 5, 10, 10)},
        {"code": "OA3", "parent_code": EAST, "pop": 30, "geometry": box(10, 0, 20, 5)},
        {"code": "OA4", "parent_code": EAST, "pop": 40, "geometry": box(10, 5, 20, 10)},
    ])
    la = layer("la", [
        {"code": WEST, "name": "West", "geometry": box(0, 0, 10, 10)},
        {"code": EAST, "name": "East", "geometry": box(10, 0, 20, 10)},
    ])
    locality = layer("locality", [
        # mostly west: representative point falls in west
        {"code": "L_STRADDLE", "geometry": box(2, 6, 12, 8)},
        {"code": "L_EAST", "geometry": box(14, 1, 16, 3)},
        {"code": "L_OFFSHORE", "geometry": box(50, 50, 51, 51)},
    ])
    dz = layer("dz", [{"code": "DZ1", "geometry": box(0, 0, 10, 10)}])
    postcode = layer("postcode", [
        {"code": "PC_IN", "parent_code": EAST, "geometry": box(14.5, 1.5, 15.5, 2.5)},
        {"code": "PC_OUT", "parent_code": EAST, "geometry": box(18, 8, 19, 9)},
        {"code": "PC_BADCOUNCIL", "parent_code": "S12999999", "geometry": box(1, 1, 2, 2)},
        {"code": "PC_NOCOUNCIL", "parent_code": None, "geometry": box(3, 1, 4, 2)},
    ])
    return {"la": la, "dz": dz, "oa": oa, "postcode": postcode, "locality": locality}


def make_cfg(la_geometry: str = "dissolve_oa") -> dict:
    def lv(parent_col: str | None, join: bool = False) -> dict:
        spec = {"path": "x", "fields": {"code": "c", "name": "n", "pop": None, "households": None,
                                        "parent_code": parent_col, "area_km2": None}}
        if join:
            spec["parent_join"] = "representative_point"
        return spec
    return {
        "source_crs": CRS, "output_crs": CRS,
        "assign": {"la_level": "la", "la_geometry": la_geometry, "dissolve_level": "oa",
                   "locality_level": "locality", "locality_field": "locality_code",
                   "locality_targets": ["oa", "postcode"]},
        "levels": {"la": lv(None), "dz": lv(None, join=True), "oa": lv("council"),
                   "postcode": lv("council"), "locality": lv(None, join=True)},
    }


def statuses(result, level: str, field: str = "parent_code") -> dict[str, str]:
    r = result.report
    r = r[(r["level"] == level) & (r["field"] == field)]
    return dict(zip(r["code"], r["status"]))


def parents(result, level: str) -> dict:
    gdf = result.levels[level]
    return dict(zip(gdf["code"], gdf["parent_code"].astype(object).where(gdf["parent_code"].notna(), None)))


@pytest.mark.parametrize("la_geometry", ["dissolve_oa", "file"])
def test_locality_parent_by_representative_point(levels, la_geometry):
    result = assign(levels, make_cfg(la_geometry))
    assert parents(result, "locality") == {"L_STRADDLE": WEST, "L_EAST": EAST, "L_OFFSHORE": None}
    assert statuses(result, "locality") == {"L_STRADDLE": MATCHED, "L_EAST": MATCHED,
                                            "L_OFFSHORE": NO_MATCH}


def test_representative_point_not_centroid():
    # A C-shape whose centroid lies in the hole, outside the polygon itself.
    c_shape = gpd.GeoDataFrame(geometry=[box(0, 0, 10, 10).difference(box(2, 2, 10, 8))], crs=CRS)
    assert not c_shape.centroid.iloc[0].within(c_shape.geometry.iloc[0])
    assert representative_points(c_shape).iloc[0].within(c_shape.geometry.iloc[0])


def test_dz_parent_by_representative_point(levels):
    result = assign(levels, make_cfg())
    assert parents(result, "dz") == {"DZ1": WEST}


def test_council_levels_keep_source_value_and_report_bad_codes(levels):
    result = assign(levels, make_cfg())
    assert parents(result, "postcode")["PC_BADCOUNCIL"] == "S12999999"
    assert statuses(result, "postcode") == {"PC_IN": MATCHED, "PC_OUT": MATCHED,
                                            "PC_BADCOUNCIL": UNKNOWN_COUNCIL,
                                            "PC_NOCOUNCIL": MISSING_COUNCIL}
    assert set(result.failures()["code"]) == {"L_OFFSHORE", "PC_BADCOUNCIL", "PC_NOCOUNCIL"}


def test_locality_code_null_when_outside_any_locality(levels):
    result = assign(levels, make_cfg())
    pc = result.levels["postcode"].set_index("code")["locality_code"]
    assert pc["PC_IN"] == "L_EAST"
    assert pd.isna(pc["PC_OUT"])
    assert statuses(result, "postcode", "locality_code")["PC_OUT"] == NO_MATCH


def test_dissolve_oa_builds_la_table(levels):
    la = assign(levels, make_cfg()).levels["la"].set_index("code")
    assert la.loc[WEST, "name"] == "West"  # name taken from LA file
    assert la.loc[WEST, "pop"] == 30
    assert la.loc[EAST, "pop"] == 70
    assert la.loc[WEST].geometry.equals(box(0, 0, 10, 10))
    assert list(la.reset_index().columns) == [*SCHEMA, "geometry"]


def test_inputs_not_modified(levels):
    before = {k: v.copy() for k, v in levels.items()}
    assign(levels, make_cfg())
    for k in levels:
        pd.testing.assert_frame_equal(levels[k], before[k])


def test_overlapping_polygons_report_multiple_match():
    pts = layer("x", [{"code": "P", "geometry": box(4, 4, 6, 6)}])
    polys = layer("la", [{"code": "A", "geometry": box(0, 0, 10, 10)},
                         {"code": "B", "geometry": box(0, 0, 10, 10)}])
    code, status = join_points(pts, polys)
    assert pd.isna(code.iloc[0]) and status.iloc[0] == MULTIPLE_MATCH


def test_invalid_geometry_still_gets_a_point():
    bowtie = Polygon([(0, 0), (10, 10), (10, 0), (0, 10)])
    pts = layer("x", [{"code": "P", "geometry": bowtie}])
    code, status = join_points(pts, layer("la", [{"code": "A", "geometry": box(-1, -1, 11, 11)}]))
    assert code.iloc[0] == "A" and status.iloc[0] == MATCHED


def test_localities_per_la_includes_empty_las(levels):
    table = localities_per_la(assign(levels, make_cfg()), make_cfg()).set_index("code")
    assert table.loc[WEST, "localities"] == 1
    assert table.loc[EAST, "localities"] == 1


def test_config_rejects_unknown_la_geometry():
    cfg = copy.deepcopy(make_cfg())
    cfg["assign"]["la_geometry"] = "guess"
    with pytest.raises(ConfigError):
        validate_levels_config(cfg)


# --- lookup fields, point fields, derived levels (electoral wards) ---------------------

def ward_cfg(tmp_path) -> dict:
    """OA1, OA2 -> ward W1 (west); OA3 -> W2 (east); OA4 -> W_SPLIT, shared with a west OA."""
    hierarchy = tmp_path / "oa_to_higher.csv"
    hierarchy.write_text("﻿OA2022,EW2022\nOA1,W1\nOA2,W1\nOA3,W2\nOA4,W_SPLIT\nOA5,W_SPLIT\n",
                         encoding="utf-8")
    names = tmp_path / "wards.csv"
    names.write_text("ElectoralWard2022Code,ElectoralWard2022Name\nW1,Ward One\nW2,Ward Two\n",
                     encoding="utf-8")
    check = tmp_path / "pc_to_oa.csv"
    check.write_text("Postcode,OutputArea2022Code\nPC_IN,OA3\nPC_OUT,OA3\n", encoding="utf-8")
    cfg = make_cfg()
    cfg["assign"]["lookup_fields"] = [{"level": "oa", "path": str(hierarchy), "key": "OA2022",
                                       "fields": {"ward_code": "EW2022"}}]
    cfg["assign"]["point_fields"] = [{"level": "postcode", "from": "oa", "link_field": "oa_code",
                                      "fields": ["ward_code"],
                                      "check": {"path": str(check), "key": "Postcode",
                                                "value": "OutputArea2022Code"}}]
    cfg["levels"]["ew"] = {"derived": {"from": "oa", "group_field": "ward_code",
                                       "names": {"path": str(names), "code": "ElectoralWard2022Code",
                                                 "name": "ElectoralWard2022Name"}}}
    return cfg


@pytest.fixture
def ward_levels(levels):
    """Add OA5 (west) so W_SPLIT has two OAs in different LAs; one OA has no ward."""
    extra = layer("oa", [{"code": "OA5", "parent_code": WEST, "pop": 5, "geometry": box(0, 10, 10, 12)},
                         {"code": "OA_NOWARD", "parent_code": EAST, "pop": 1, "geometry": box(10, 10, 20, 12)}])
    return {**levels, "oa": pd.concat([levels["oa"], extra], ignore_index=True)}


def test_lookup_fields_join_by_code(ward_levels, tmp_path):
    result = assign(ward_levels, ward_cfg(tmp_path))
    oa = result.levels["oa"].set_index("code")["ward_code"]
    assert oa["OA1"] == "W1" and oa["OA3"] == "W2" and pd.isna(oa["OA_NOWARD"])
    assert statuses(result, "oa", "ward_code")["OA_NOWARD"] == NO_MATCH


def test_point_fields_link_postcodes_to_oas_and_copy_ward(ward_levels, tmp_path, caplog):
    caplog.set_level("INFO")
    result = assign(ward_levels, ward_cfg(tmp_path))
    pc = result.levels["postcode"].set_index("code")
    assert pc.loc["PC_IN", "oa_code"] == "OA3" and pc.loc["PC_IN", "ward_code"] == "W2"
    assert pc.loc["PC_OUT", "oa_code"] == "OA4" and pc.loc["PC_OUT", "ward_code"] == "W_SPLIT"
    assert "1 of 2 agree" in caplog.text  # PC_OUT disagrees with the check file


def test_derived_level_dissolves_names_and_takes_majority_parent(ward_levels, tmp_path):
    result = assign(ward_levels, ward_cfg(tmp_path))
    ew = result.levels["ew"].set_index("code")
    assert list(ew.index) == ["W1", "W2", "W_SPLIT"]
    assert ew.loc["W1", "name"] == "Ward One" and ew.loc["W_SPLIT", "name"] == "W_SPLIT"
    assert ew.loc["W1", "pop"] == 30 and ew.loc["W1", "area_km2"] == 2.0
    assert ew.loc["W1", "geometry"].equals(box(0, 0, 10, 10))
    assert ew.loc["W1", "parent_code"] == WEST and ew.loc["W2", "parent_code"] == EAST
    assert ew.loc["W_SPLIT", "parent_code"] == WEST  # tie (1 west, 1 east) -> lowest code
    assert list(result.levels["ew"].columns) == [*SCHEMA, "geometry"]


def test_config_rejects_derived_group_field_not_assigned(tmp_path):
    cfg = ward_cfg(tmp_path)
    cfg["levels"]["ew"]["derived"]["group_field"] = "ward"
    with pytest.raises(ConfigError, match="group_field 'ward'"):
        validate_levels_config(cfg)


# --- neighbour lists -------------------------------------------------------------------

def test_neighbour_lists_touching_and_isolated():
    from build.assign import assign_neighbours
    wards = layer("ew", [
        {"code": "W1", "geometry": box(0, 0, 10, 10)},
        {"code": "W2", "geometry": box(10, 0, 20, 10)},
        {"code": "W3", "geometry": box(20, 0, 30, 10)},
        {"code": "W4", "geometry": box(20, 10, 30, 20)},   # touches W3 by an edge, W2 by a corner
        {"code": "ISLAND", "geometry": box(100, 100, 110, 110)},
    ])
    levels = {"ew": wards}
    assign_neighbours(levels, {"neighbours": [{"level": "ew", "field": "neighbour_codes"}]})
    got = dict(zip(levels["ew"]["code"], levels["ew"]["neighbour_codes"]))
    assert got == {"W1": ["W2"], "W2": ["W1", "W3", "W4"], "W3": ["W2", "W4"],
                   "W4": ["W2", "W3"], "ISLAND": []}
    assert "neighbour_codes" not in wards.columns   # input not modified


def test_assign_adds_neighbours_after_deriving(levels):
    cfg = make_cfg()
    cfg["assign"]["neighbours"] = [{"level": "oa", "field": "neighbour_codes"}]
    result = assign(levels, cfg)
    got = dict(zip(result.levels["oa"]["code"], result.levels["oa"]["neighbour_codes"]))
    assert got["OA1"] == ["OA2", "OA3", "OA4"]   # OA4 by a corner


@pytest.mark.parametrize("rule, message", [
    ({"level": "ward", "field": "n"}, r"unknown levels: \['ward'\]"),
    ({"level": "oa"}, r"assign\.neighbours entries need level and field"),
])
def test_invalid_neighbours_config(rule, message):
    cfg = make_cfg()
    cfg["assign"]["neighbours"] = [rule]
    with pytest.raises(ConfigError, match=message):
        validate_levels_config(cfg)


# --- largest-overlap links (OA -> community council) ---------------------------

def test_join_largest_overlap_picks_the_biggest_share_not_the_point():
    oa = layer("oa", [
        {"code": "OA1", "geometry": box(0, 0, 10, 10)},     # 60% in A, 40% in B
        {"code": "OA2", "geometry": box(10, 0, 20, 10)},    # 50/50: lowest code wins
        {"code": "OA3", "geometry": box(50, 50, 51, 51)},   # in nothing
        {"code": "OA4", "geometry": box(0, 0, 10, 10)},     # three-way split: plurality
    ])
    cc = layer("cc", [
        {"code": "B", "geometry": box(6, 0, 15, 10)},
        {"code": "A", "geometry": box(-5, 0, 6, 10)},
        {"code": "C", "geometry": box(15, 0, 30, 10)},
    ])
    code, status, share = join_largest_overlap(oa, cc, CRS)
    assert code.tolist()[:2] == ["A", "B"] and pd.isna(code.iloc[2]) and code.iloc[3] == "A"
    assert status.tolist() == [MATCHED, MATCHED, NO_MATCH, MATCHED]
    assert share.iloc[0] == pytest.approx(0.6)


def test_area_fields_limit_to_parents_and_sum_counts(levels):
    levels["cc"] = layer("cc", [{"code": "CC_A", "pop": None, "households": None, "geometry": box(0, 0, 10, 7)},
                                {"code": "CC_EMPTY", "pop": None, "households": None, "geometry": box(0, 9, 3, 10)}])
    rule = {"level": "oa", "from": "cc", "link_field": "cc_code", "parents": [WEST], "counts": ["pop"]}
    reports = assign_area_fields(levels, {"area_fields": [rule]}, CRS)
    oa = levels["oa"].set_index("code")["cc_code"]
    assert oa["OA1"] == "CC_A" and oa["OA2"] == "CC_A"   # OA2: 40% in CC_A beats 6% in CC_EMPTY
    assert oa[["OA3", "OA4"]].isna().all()                # east is out of scope
    pops = levels["cc"].set_index("code")["pop"]
    assert pops["CC_A"] == 30 and pd.isna(pops["CC_EMPTY"])
    assert set(reports[0]["code"]) == {"OA1", "OA2"}
