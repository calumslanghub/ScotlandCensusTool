"""Topology-preserving simplification of each level.

Each level is simplified as a whole (not per LA), so edges shared by neighbouring
features are simplified once and stay shared: no gaps or slivers between them.
The tolerance is the level's `simplify_m`, in metres.

Engines (config `simplify.engine`):
  mapshaper  `npx -p <package> <bin> in.json -simplify interval=<m> keep-shapes`.
             mapshaper builds a topology across features; with lat/long input the
             interval is in metres. If npx is not on PATH, warn and use shapely.
  shapely    shapely.coverage_simplify in source_crs (metres). Preserves shared
             edges for clean coverages; features are never dropped.
"""
from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

import geopandas as gpd
import pyogrio
import shapely

from build.geometry import valid_polygons, vertex_count

log = logging.getLogger(__name__)


class SimplifyError(RuntimeError):
    pass


def resolve_engine(simplify_cfg: dict[str, Any]) -> tuple[str, str | None]:
    """Return (engine, npx path). Falls back to shapely if mapshaper can't run."""
    if simplify_cfg["engine"] != "mapshaper":
        return "shapely", None
    npx = shutil.which("npx")
    if npx is None:
        log.warning("npx (Node.js) not found on PATH: mapshaper unavailable, "
                    "falling back to shapely.coverage_simplify")
        return "shapely", None
    return "mapshaper", npx


def mapshaper_command(npx: str, simplify_cfg: dict[str, Any], src: Path, dst: Path,
                      tolerance_m: float, precision: int) -> list[str]:
    return [npx, "--yes", "-p", simplify_cfg["mapshaper_package"], simplify_cfg["mapshaper_bin"],
            str(src), "-simplify", f"interval={tolerance_m}", "keep-shapes",
            "-o", str(dst), "format=geojson", f"precision={10 ** -precision:.{precision}f}"]


def simplify_mapshaper(gdf: gpd.GeoDataFrame, tolerance_m: float, npx: str,
                       simplify_cfg: dict[str, Any], precision: int) -> gpd.GeoSeries:
    """Run mapshaper on code + geometry; return simplified geometry aligned to gdf."""
    with tempfile.TemporaryDirectory(prefix="simplify_") as tmp:
        src, dst = Path(tmp) / "in.json", Path(tmp) / "out.json"
        pyogrio.write_dataframe(gdf[["code", "geometry"]], src, driver="GeoJSON")
        cmd = mapshaper_command(npx, simplify_cfg, src, dst, tolerance_m, precision)
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise SimplifyError(f"mapshaper failed ({proc.returncode}): {proc.stderr.strip()}")
        out = pyogrio.read_dataframe(dst)
    if out.crs is None:
        out = out.set_crs(gdf.crs)
    geometry = out.set_index("code").geometry.reindex(gdf["code"])
    if geometry.isna().any() or len(out) != len(gdf):
        raise SimplifyError(f"mapshaper returned {len(out)} features for {len(gdf)} inputs")
    return gpd.GeoSeries(geometry.to_numpy(), index=gdf.index, crs=gdf.crs)


def simplify_shapely(gdf: gpd.GeoDataFrame, tolerance_m: float, metric_crs: str) -> gpd.GeoSeries:
    metric = gdf.geometry.to_crs(metric_crs)
    simplified = shapely.coverage_simplify(valid_polygons(metric.values), tolerance_m)
    return gpd.GeoSeries(simplified, index=gdf.index, crs=metric_crs).to_crs(gdf.crs)


def simplify_level(level: str, gdf: gpd.GeoDataFrame, cfg: dict[str, Any],
                   engine: str, npx: str | None) -> gpd.GeoDataFrame:
    tolerance = cfg["levels"][level]["simplify_m"]
    start, verts_in = time.perf_counter(), vertex_count(gdf.geometry.values)
    if tolerance == 0:
        geometry = gdf.geometry
    elif engine == "mapshaper":
        geometry = simplify_mapshaper(gdf, tolerance, npx, cfg["simplify"],
                                      cfg["export"]["coordinate_precision"])
    else:
        geometry = simplify_shapely(gdf, tolerance, cfg["source_crs"])
    out = gdf.copy()
    out["geometry"] = gpd.GeoSeries(geometry.values, index=gdf.index, crs=gdf.crs)
    log.info("%s: simplified %d features (%s, %sm): %d -> %d vertices, %.1fs",
             level, len(out), engine, tolerance, verts_in,
             vertex_count(out.geometry.values), time.perf_counter() - start)
    return out


def simplify_all(levels: dict[str, gpd.GeoDataFrame], cfg: dict[str, Any]) -> dict[str, gpd.GeoDataFrame]:
    engine, npx = resolve_engine(cfg["simplify"])
    return {level: simplify_level(level, gdf, cfg, engine, npx) for level, gdf in levels.items()}
