from __future__ import annotations

import copy
import logging
import shutil
from pathlib import Path

import geopandas as gpd
import pytest
import shapely
from shapely.geometry import Polygon

from build import simplify
from build.config import ConfigError, validate_levels_config
from build.simplify import mapshaper_command, resolve_engine, simplify_all

SOURCE_CRS = "EPSG:27700"
X0, Y0 = 300000, 700000


def wiggly_pair() -> gpd.GeoDataFrame:
    """Two polygons sharing an edge with 1 m wiggles every 10 m (EPSG:27700)."""
    shared = [(X0 + 1000 + (1 if i % 2 else 0), Y0 + i * 10) for i in range(101)]
    west = Polygon([(X0, Y0), *shared, (X0, Y0 + 1000)])
    east = Polygon([(X0 + 2000, Y0), (X0 + 2000, Y0 + 1000), *reversed(shared)])
    gdf = gpd.GeoDataFrame({"code": ["W", "E"]}, geometry=[west, east], crs=SOURCE_CRS)
    return gdf.to_crs("EPSG:4326")


def cfg(engine: str = "shapely", tol: float = 5) -> dict:
    return {
        "source_crs": SOURCE_CRS, "output_crs": "EPSG:4326",
        "simplify": {"engine": engine, "mapshaper_package": "mapshaper@0.6",
                     "mapshaper_bin": "mapshaper-xl"},
        "export": {"coordinate_precision": 5},
        "levels": {"zone": {"path": "x", "simplify_m": tol, "fields": {
            "code": "c", "name": "n", "pop": None, "households": None,
            "parent_code": None, "area_km2": None}}},
    }


def run(engine: str, tol: float = 5) -> gpd.GeoDataFrame:
    return simplify_all({"zone": wiggly_pair()}, cfg(engine, tol))["zone"]


def test_shapely_engine_reduces_vertices_and_keeps_shared_edge():
    before, after = wiggly_pair(), run("shapely")
    assert shapely.get_num_coordinates(after.geometry.values).sum() < \
        shapely.get_num_coordinates(before.geometry.values).sum() / 2
    metric = after.to_crs(SOURCE_CRS).geometry
    assert metric.iloc[0].intersection(metric.iloc[1]).area == pytest.approx(0, abs=1e-3)
    assert metric.union_all().area == pytest.approx(2000 * 1000, rel=1e-3)  # no gap opened
    assert shapely.coverage_is_valid(metric.values)


def test_zero_tolerance_leaves_geometry_unchanged():
    before, after = wiggly_pair(), run("shapely", tol=0)
    assert after.geometry.geom_equals(before.geometry).all()


def test_attributes_and_crs_preserved():
    after = run("shapely")
    assert after["code"].tolist() == ["W", "E"]
    assert after.crs.to_epsg() == 4326


def test_falls_back_to_shapely_with_warning_when_npx_missing(monkeypatch, caplog):
    monkeypatch.setattr(simplify.shutil, "which", lambda name: None)
    with caplog.at_level(logging.WARNING):
        engine, npx = resolve_engine(cfg("mapshaper")["simplify"])
    assert (engine, npx) == ("shapely", None)
    assert "npx (Node.js) not found" in caplog.text


def test_mapshaper_command():
    cmd = mapshaper_command("npx", cfg("mapshaper")["simplify"], Path("in.json"),
                            Path("out.json"), 20, 5)
    assert cmd[:5] == ["npx", "--yes", "-p", "mapshaper@0.6", "mapshaper-xl"]
    assert "interval=20" in cmd and "keep-shapes" in cmd
    assert "precision=0.00001" in cmd


@pytest.mark.skipif(shutil.which("npx") is None, reason="Node.js/npx not installed")
def test_mapshaper_engine_keeps_shared_edge():
    metric = run("mapshaper").to_crs(SOURCE_CRS).geometry
    assert metric.iloc[0].intersection(metric.iloc[1]).area == pytest.approx(0, abs=1)
    assert metric.union_all().area == pytest.approx(2000 * 1000, rel=1e-3)


def test_config_requires_tolerance_and_known_engine():
    c = copy.deepcopy(cfg())
    del c["levels"]["zone"]["simplify_m"]
    with pytest.raises(ConfigError):
        validate_levels_config(c)
    c = copy.deepcopy(cfg())
    c["simplify"]["engine"] = "magic"
    with pytest.raises(ConfigError):
        validate_levels_config(c)
