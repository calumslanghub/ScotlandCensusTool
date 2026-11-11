from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import pytest
from shapely.geometry import Polygon, box

from build.config import ConfigError, load_levels_config, validate_levels_config
from build.load import SCHEMA, SourceError, load_level
from build.run import geometry_stats

SOURCE_CRS = "EPSG:27700"


def _write_source(tmp_path: Path, crs: str = SOURCE_CRS) -> Path:
    gdf = gpd.GeoDataFrame(
        {
            "zcode": ["Z1", "Z2"],
            "zname": ["One", "Two"],
            "people": [10, 20],
            "hh": [4, 8],
            "la": ["S12000033", "S12000034"],
        },
        geometry=[box(300000, 700000, 301000, 701000), box(301000, 700000, 303000, 701000)],
        crs=crs,
    )
    path = tmp_path / "zones.gpkg"
    gdf.to_file(path)
    return path


def _cfg(path: Path, **field_overrides) -> dict:
    fields = {"code": "zcode", "name": "zname", "pop": "people", "households": "hh",
              "parent_code": "la", "area_km2": None}
    fields.update(field_overrides)
    return {"source_crs": SOURCE_CRS, "output_crs": "EPSG:4326",
            "levels": {"zone": {"path": str(path), "fields": fields}}}


def test_load_level_returns_common_schema_in_4326(tmp_path):
    gdf = load_level("zone", _cfg(_write_source(tmp_path)))
    assert list(gdf.columns) == [*SCHEMA, "geometry"]
    assert gdf.crs.to_epsg() == 4326
    assert gdf["level"].unique().tolist() == ["zone"]
    assert gdf["parent_code"].tolist() == ["S12000033", "S12000034"]
    assert gdf["pop"].tolist() == [10, 20]


def test_area_computed_from_source_geometry_when_unmapped(tmp_path):
    gdf = load_level("zone", _cfg(_write_source(tmp_path)))
    assert gdf["area_km2"].tolist() == pytest.approx([1.0, 2.0])


def test_unmapped_fields_are_null(tmp_path):
    gdf = load_level("zone", _cfg(_write_source(tmp_path), households=None, parent_code=None))
    assert gdf["households"].isna().all()
    assert gdf["parent_code"].isna().all()


def test_missing_column_raises(tmp_path):
    with pytest.raises(SourceError, match="nope"):
        load_level("zone", _cfg(_write_source(tmp_path), pop="nope"))


def test_wrong_crs_raises(tmp_path):
    with pytest.raises(SourceError, match="expected EPSG:27700"):
        load_level("zone", _cfg(_write_source(tmp_path, crs="EPSG:3857")))


def test_config_requires_code_and_name(tmp_path):
    with pytest.raises(ConfigError):
        validate_levels_config(_cfg(tmp_path / "x.gpkg", name=None))


def test_repo_config_is_valid_and_paths_exist():
    from build.config import resolve_path
    cfg = load_levels_config()
    for spec in cfg["levels"].values():
        path = spec["derived"]["names"]["path"] if "derived" in spec else spec["path"]
        assert resolve_path(path).exists()
    for rule in [*cfg["assign"]["lookup_fields"], *cfg["assign"]["point_fields"]]:
        assert "check" not in rule or resolve_path(rule["check"]["path"]).exists()
        assert "path" not in rule or resolve_path(rule["path"]).exists()


def test_geometry_stats_counts_empty_and_invalid():
    bowtie = Polygon([(0, 0), (1, 1), (1, 0), (0, 1)])
    gdf = gpd.GeoDataFrame(geometry=[box(0, 0, 1, 1), bowtie, Polygon(), None])
    assert geometry_stats(gdf) == {"null_empty": 2, "invalid": 1}


def test_level_crs_is_reprojected_to_source_crs_with_code_prefix(tmp_path):
    """A source in its own CRS (community councils: 4326 GeoJSON) is checked against `crs`,
    reprojected on read (area in metres) and its z coordinates are dropped."""
    gdf = gpd.read_file(_write_source(tmp_path)).to_crs("EPSG:4326")
    gdf["geometry"] = gdf.geometry.force_3d(0)
    path = tmp_path / "zones.geojson"
    gdf.to_file(path, driver="GeoJSON")
    cfg = _cfg(path, area_km2=None)
    cfg["levels"]["zone"].update(crs="EPSG:4326", code_prefix="X")
    out = load_level("zone", cfg)
    assert out["code"].tolist() == ["XZ1", "XZ2"]
    assert out["area_km2"].round(3).tolist() == [1.0, 2.0]
    assert not out.geometry.has_z.any()
    cfg["levels"]["zone"]["crs"] = SOURCE_CRS
    with pytest.raises(SourceError, match="expected EPSG:27700"):
        load_level("zone", cfg)
