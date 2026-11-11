"""Read each geography level from its source file into the common schema.

Common schema: code, name, level, parent_code, pop, households, area_km2, geometry.
All source column names come from config/levels.yaml.

Sources are in `source_crs`, except a level with its own `crs` (e.g. a GeoJSON in EPSG:4326):
it is checked against that and reprojected to `source_crs` on read, so areas are in metres.
Z coordinates are dropped. `code_prefix` makes codes unique when the source's are bare numbers.
"""
from __future__ import annotations

import logging
from typing import Any

import geopandas as gpd
import pandas as pd
import pyogrio
import shapely

from build.config import is_derived, load_levels_config, resolve_path

log = logging.getLogger(__name__)

SCHEMA = ("code", "name", "level", "parent_code", "pop", "households", "area_km2")


class SourceError(ValueError):
    pass


def mapped_columns(spec: dict[str, Any]) -> list[str]:
    """Distinct source columns referenced by a level's field mapping."""
    cols = [c for c in spec["fields"].values() if c]
    return list(dict.fromkeys(cols))


def validate_columns(level: str, available: list[str], spec: dict[str, Any]) -> None:
    missing = [c for c in mapped_columns(spec) if c not in available]
    if missing:
        raise SourceError(
            f"{level}: expected columns {missing} not in source; available: {available}"
        )


def read_source(level: str, spec: dict[str, Any], source_crs: str) -> gpd.GeoDataFrame:
    """Read the raw source (in its own CRS) with only the mapped columns."""
    path = resolve_path(spec["path"])
    info = pyogrio.read_info(path)
    validate_columns(level, list(info["fields"]), spec)
    gdf = pyogrio.read_dataframe(path, columns=mapped_columns(spec))
    expected = spec.get("crs", source_crs)
    if gdf.crs is None or not gdf.crs.equals(expected):
        raise SourceError(f"{level}: CRS is {gdf.crs}, expected {expected}")
    if shapely.has_z(gdf.geometry.values).any():
        gdf = gdf.set_geometry(shapely.force_2d(gdf.geometry.values), crs=gdf.crs)
    if expected != source_crs:
        gdf = gdf.to_crs(source_crs)
        log.info("%s: reprojected %s -> %s on read", level, expected, source_crs)
    log.info("%s: read %d features from %s (%.1f MB)",
             level, len(gdf), path.name, path.stat().st_size / 1e6)
    return gdf


def _column_or_na(src: gpd.GeoDataFrame, col: str | None, dtype: str) -> pd.Series:
    if not col:
        return pd.Series(pd.NA, index=src.index, dtype=dtype)
    return src[col].astype(dtype)


def _area_km2(src: gpd.GeoDataFrame, spec: dict[str, Any]) -> pd.Series:
    col = spec["fields"]["area_km2"]
    if not col:
        return src.geometry.area / 1e6  # source CRS is metres
    return src[col].astype("float64") * float(spec.get("area_scale", 1.0))


def to_common_schema(level: str, src: gpd.GeoDataFrame, spec: dict[str, Any]) -> gpd.GeoDataFrame:
    """Map source columns to the common schema; geometry stays in source CRS."""
    f = spec["fields"]
    out = pd.DataFrame({
        "code": spec.get("code_prefix", "") + src[f["code"]].astype("string").str.strip(),
        "name": src[f["name"]].astype("string").str.strip(),
        "level": level,
        "parent_code": _column_or_na(src, f["parent_code"], "string"),
        "pop": _column_or_na(src, f["pop"], "Int64"),
        "households": _column_or_na(src, f["households"], "Int64"),
        "area_km2": _area_km2(src, spec),
    }, index=src.index)
    return gpd.GeoDataFrame(out, geometry=src.geometry, crs=src.crs)


def load_level(level: str, cfg: dict[str, Any] | None = None) -> gpd.GeoDataFrame:
    """Read one level, map to the common schema, reproject to the output CRS."""
    cfg = cfg or load_levels_config()
    spec = cfg["levels"][level]
    src = read_source(level, spec, cfg["source_crs"])
    gdf = to_common_schema(level, src, spec).to_crs(cfg["output_crs"])
    log.info("%s: %d features in common schema, %s", level, len(gdf), cfg["output_crs"])
    return gdf


def load_all(cfg: dict[str, Any] | None = None) -> dict[str, gpd.GeoDataFrame]:
    """Every file-backed level. Derived levels are built later, by build/assign.py."""
    cfg = cfg or load_levels_config()
    return {level: load_level(level, cfg) for level, spec in cfg["levels"].items()
            if not is_derived(spec)}
