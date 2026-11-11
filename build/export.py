"""Write simplified levels to data/processed.

  <la_file>                                all LAs in one file
  <per_la_path> for per_la_levels          one GeoJSON per LA per level, split on parent_code
  <national_path> for national_levels      one GeoJSON per level for all of Scotland
  <index_file> for index_levels            search index for small levels
  <per_la_index_path> for per_la_index_levels   search index for large levels, per LA
  <metrics file>                           metric definitions and the values of metrics that come
                                           from no dataset (build/metrics.py)
  <dataset_values_path>                    a Census table's values at one level, per dataset
  <oa_values_path>                         a Census table's output-area values, per LA and dataset
  <explorer file>                          validated config/explorer.yaml (build/explorer.py)
  <manifest_file>                          uncompressed entry point: every path above, as
                                           served, plus level labels and LA codes
Then the whole out_dir is copied to `publish_dir` (web/data) so `python -m http.server`
run in web/ serves it.

GeoJSON follows RFC 7946: EPSG:4326, no crs member, exterior rings counter-
clockwise. Coordinates are snapped to `export.coordinate_precision` decimal places
with shapely.set_precision, which (unlike plain rounding) keeps geometries valid.
Indexes are columnar: {"fields": [...], "rows": [[...], ...]}.
All JSON is minified. With `export.gzip`, each file is written only as <path>.gz,
with a fixed timestamp so rebuilding identical data gives identical bytes.

Every per-LA file is written for every LA, empty if needed, so the front end
never requests a missing file.
"""
from __future__ import annotations

import gzip
import json
import logging
import re
import shutil
from pathlib import Path
from typing import Any

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

from build.config import PROJECT_ROOT, ConfigError, resolve_path
from build.load import SCHEMA

log = logging.getLogger(__name__)

AREA_DECIMALS = 4
GZIP_SUFFIX = ".gz"
VALUE_PATHS = ("dataset_values_path", "oa_values_path")   # export keys of the per-dataset files
CODES = "codes"


# --- serialisation -----------------------------------------------------------

def dumps(obj: Any) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def json_records(df: pd.DataFrame) -> list[dict]:
    """Rows as dicts of plain Python values, with pandas NA as None."""
    return df.astype(object).where(df.notna(), None).to_dict("records")


def output_columns(gdf: gpd.GeoDataFrame) -> list[str]:
    """Common schema first, then any level-specific extras (e.g. locality_code)."""
    extras = [c for c in gdf.columns if c not in SCHEMA and c != gdf.geometry.name]
    return [*SCHEMA, *extras]


def snap_to_grid(geoms: np.ndarray, precision: int) -> np.ndarray:
    """Snap coordinates to a 10^-precision grid, keeping geometries valid.

    Plain rounding can create self-intersections; set_precision repairs them.
    Shared vertices snap to the same grid point, so neighbours stay aligned.
    """
    snapped = shapely.set_precision(geoms, 10.0 ** -precision)
    collapsed = int((shapely.is_empty(snapped) & ~shapely.is_empty(geoms)).sum())
    if collapsed:
        log.warning("%d geometries collapsed to empty when snapped to %d dp", collapsed, precision)
    return snapped


def shorten_numbers(geojson: str, pattern: re.Pattern, precision: int) -> str:
    """GEOS may print a snapped value as e.g. 56.152589999999996; print it as 56.15259."""
    return pattern.sub(lambda m: repr(round(float(m.group()), precision)), geojson)


def rfc7946_geometries(gdf: gpd.GeoDataFrame, precision: int) -> list[str | None]:
    """Geometry JSON strings: snapped to precision, exterior rings counter-clockwise."""
    geoms = snap_to_grid(gdf.geometry.values, precision)
    geoms = shapely.orient_polygons(geoms, exterior_cw=False)
    long_number = re.compile(r"-?\d+\.\d{%d,}" % (precision + 1))
    return [g if g is None else shorten_numbers(g, long_number, precision)
            for g in shapely.to_geojson(geoms)]


def feature_collection(gdf: gpd.GeoDataFrame, precision: int) -> str:
    props = gdf[output_columns(gdf)].copy()
    props["area_km2"] = props["area_km2"].round(AREA_DECIMALS)
    features = (
        f'{{"type":"Feature","properties":{dumps(p)},"geometry":{g or "null"}}}'
        for p, g in zip(json_records(props), rfc7946_geometries(gdf, precision))
    )
    return '{"type":"FeatureCollection","features":[' + ",".join(features) + "]}"


def index_table(gdfs: list[gpd.GeoDataFrame], fields: list[str], precision: int) -> str:
    rows: list[list] = []
    for gdf in gdfs:
        df = gdf[[f for f in fields if f != "bbox"]].copy()
        if "bbox" in fields:
            bounds = gdf.geometry.bounds.round(precision)
            df["bbox"] = bounds[["minx", "miny", "maxx", "maxy"]].to_numpy().tolist()
        rows += [[r[f] for f in fields] for r in json_records(df[fields])]
    return dumps({"fields": fields, "rows": rows})


# --- files -------------------------------------------------------------------

class Writer:
    """Writes text files under out_dir, gzipped or not, and records their sizes."""

    def __init__(self, out_dir: Path, export_cfg: dict[str, Any]):
        self.out_dir = out_dir
        self.gzip = bool(export_cfg["gzip"])
        self.level = int(export_cfg.get("gzip_level", 9))
        self.records: list[dict] = []

    def disk_path(self, logical: str) -> Path:
        return self.out_dir / (logical + GZIP_SUFFIX if self.gzip else logical)

    def write(self, logical: str, text: str, level: str, la_code: str | None,
              features: int) -> dict:
        raw = text.encode("utf-8")
        data = gzip.compress(raw, compresslevel=self.level, mtime=0) if self.gzip else raw
        path = self.disk_path(logical)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        record = {"file": path.relative_to(self.out_dir).as_posix(), "level": level,
                  "la_code": la_code, "features": features,
                  "raw_bytes": len(raw), "bytes": len(data)}
        self.records.append(record)
        return record


def owned_paths(export_cfg: dict[str, Any], out_dir: Path) -> list[Path]:
    """Every file this step may have written, gzipped or not, under any previous run."""
    logical = [export_cfg["la_file"], export_cfg["index_file"], export_cfg["manifest_file"],
               export_cfg["metrics_file"], export_cfg["explorer_file"]]
    patterns = [export_cfg["per_la_path"].format(level=lv, la_code="*")
                for lv in export_cfg["per_la_levels"]]
    patterns.append(export_cfg["per_la_index_path"].format(la_code="*"))
    if export_cfg.get("national_path"):  # any level, so a level dropped from the config goes too
        patterns.append(export_cfg["national_path"].format(level="*"))
    paths = [out_dir / (name + suffix) for name in logical for suffix in ("", GZIP_SUFFIX)]
    for pattern in patterns:
        paths += [*out_dir.glob(pattern), *out_dir.glob(pattern + GZIP_SUFFIX)]
    for key in VALUE_PATHS:
        if export_cfg.get(key):
            paths += value_files(out_dir, export_cfg[key])
    return paths


def value_files(out_dir: Path, template: str) -> list[Path]:
    """Every file under a value template's fixed folder (the part before its first
    placeholder), at any depth: datasets, levels and LAs come and go, and an earlier layout
    (one OA file per LA) must not be left behind. A template with no fixed folder is matched
    as a pattern instead, so nothing outside it is touched."""
    suffix = Path(template).suffix
    folder = template.split("{")[0].rpartition("/")[0]
    if not folder:
        pattern = re.sub(r"\{\w+\}", "*", template)
        return [*out_dir.glob(pattern), *out_dir.glob(pattern + GZIP_SUFFIX)]
    root = out_dir / folder
    return [*root.rglob(f"*{suffix}"), *root.rglob(f"*{suffix}{GZIP_SUFFIX}")]


def clean_outputs(export_cfg: dict[str, Any], out_dir: Path) -> int:
    """Delete files this step owns, so removed LAs/levels/settings leave nothing stale."""
    removed = 0
    for path in set(owned_paths(export_cfg, out_dir)):
        if path.is_file():
            path.unlink()
            removed += 1
    return removed


# --- writers -----------------------------------------------------------------

def per_la_groups(level: str, gdf: gpd.GeoDataFrame, la_codes: list[str]) -> dict[str, gpd.GeoDataFrame]:
    """Split a level by parent_code, with an (empty) entry for every LA."""
    groups = gdf.groupby("parent_code").indices
    orphans = len(gdf) - sum(len(groups.get(c, [])) for c in la_codes)
    if orphans:
        log.warning("%s: %d features have no parent in the LA table and are not exported",
                    level, orphans)
    return {code: gdf.iloc[groups.get(code, [])] for code in la_codes}


def export_geometry(levels: dict[str, gpd.GeoDataFrame], la_level: str, la_codes: list[str],
                    export_cfg: dict[str, Any], writer: Writer) -> None:
    precision = export_cfg["coordinate_precision"]
    la = levels[la_level]
    writer.write(export_cfg["la_file"], feature_collection(la, precision), la_level, None, len(la))
    for level in export_cfg["per_la_levels"]:
        before = len(writer.records)
        for code, subset in per_la_groups(level, levels[level], la_codes).items():
            path = export_cfg["per_la_path"].format(level=level, la_code=code)
            writer.write(path, feature_collection(subset, precision), level, code, len(subset))
        log_files(level, len(levels[level]), writer.records[before:])
    for level in export_cfg.get("national_levels", []):
        gdf = levels[level]
        record = writer.write(export_cfg["national_path"].format(level=level),
                              feature_collection(gdf, precision), level, None, len(gdf))
        log_files(level, len(gdf), [record])


def export_indexes(levels: dict[str, gpd.GeoDataFrame], la_codes: list[str],
                   export_cfg: dict[str, Any], writer: Writer) -> None:
    fields, precision = export_cfg["index_fields"], export_cfg["coordinate_precision"]
    top = [levels[lv] for lv in export_cfg["index_levels"]]
    writer.write(export_cfg["index_file"], index_table(top, fields, precision),
                 "index", None, sum(len(g) for g in top))

    before = len(writer.records)
    split = {lv: per_la_groups(lv, levels[lv], la_codes) for lv in export_cfg["per_la_index_levels"]}
    for code in la_codes:
        parts = [split[lv][code] for lv in export_cfg["per_la_index_levels"]]
        path = export_cfg["per_la_index_path"].format(la_code=code)
        writer.write(path, index_table(parts, fields, precision), "index_la", code,
                     sum(len(p) for p in parts))
    total = sum(len(levels[lv]) for lv in export_cfg["per_la_index_levels"])
    log_files("index_la", total, writer.records[before:])


def export_oa_values(oa_values: dict[str, dict[str, dict[str, list]]], la_codes: list[str],
                     export_cfg: dict[str, Any], writer: Writer) -> None:
    """One columnar file per LA and dataset with the Census values of the LA's output areas
    (empty if it has none)."""
    before = len(writer.records)
    datasets = sorted({ds for by_dataset in oa_values.values() for ds in by_dataset})
    for code in la_codes:
        for ds in datasets:
            cols = oa_values.get(code, {}).get(ds, {CODES: []})
            writer.write(export_cfg["oa_values_path"].format(la_code=code, dataset=ds), dumps(cols),
                         "oa_values", code, len(cols[CODES]))
    areas = sum(len(next(iter(v.values()))[CODES]) for v in oa_values.values() if v)
    log.info("oa_values: %d output areas x %d datasets", areas, len(datasets))
    log_files("oa_values", areas * len(datasets), writer.records[before:])


def split_metrics(metrics: dict[str, Any]) -> tuple[dict[str, Any], dict[str, dict[str, dict[str, list]]]]:
    """metrics.json without the values of dataset metrics, and those values as
    {dataset id: {level: {codes, <metric id>: [...]}}}."""
    dataset_of = {m["id"]: m["dataset"] for m in metrics["metrics"] if m.get("dataset")}
    kept: dict[str, dict[str, list]] = {}
    split: dict[str, dict[str, dict[str, list]]] = {}
    for level, cols in metrics.get("values", {}).items():
        kept[level] = {k: v for k, v in cols.items() if k not in dataset_of}
        for metric_id, values in cols.items():
            if metric_id in dataset_of:
                table = split.setdefault(dataset_of[metric_id], {}).setdefault(level, {CODES: cols[CODES]})
                table[metric_id] = values
    return {**metrics, "values": kept}, split


def export_dataset_values(by_dataset: dict[str, dict[str, dict[str, list]]], export_cfg: dict[str, Any],
                          writer: Writer) -> None:
    """One columnar file per dataset and level."""
    before = len(writer.records)
    for ds, by_level in sorted(by_dataset.items()):
        for level, cols in by_level.items():
            writer.write(export_cfg["dataset_values_path"].format(level=level, dataset=ds), dumps(cols),
                         "dataset_values", None, len(cols[CODES]))
    metrics = sum(len(cols) - 1 for by_level in by_dataset.values() for cols in by_level.values())
    log.info("dataset_values: %d datasets, %d metric columns", len(by_dataset), metrics)
    log_files("dataset_values", sum(r["features"] for r in writer.records[before:]), writer.records[before:])


def served_name(export_cfg: dict[str, Any], logical: str) -> str:
    return logical + GZIP_SUFFIX if export_cfg["gzip"] else logical


def build_manifest(cfg: dict[str, Any], la_codes: list[str]) -> dict[str, Any]:
    """Paths as served, relative to the data root; {la_code} is left as a placeholder."""
    e = cfg["export"]
    name = lambda logical: served_name(e, logical)  # noqa: E731
    if e.get("oa_values_path") and not cfg.get("census", {}).get("oa_level"):
        raise ConfigError("export.oa_values_path is set but census.oa_level is not: the front end "
                          "could not tell which level the OA value files belong to")
    return {
        "gzip": bool(e["gzip"]),
        "la_level": cfg["assign"]["la_level"],
        "locality_level": cfg["assign"]["locality_level"],
        "la_file": name(e["la_file"]),
        "per_la": {lv: name(e["per_la_path"].format(level=lv, la_code="{la_code}"))
                   for lv in e["per_la_levels"]},
        "national": {lv: name(e["national_path"].format(level=lv))
                     for lv in e.get("national_levels", [])},
        "index_file": name(e["index_file"]),
        "per_la_index": name(e["per_la_index_path"]),
        # {level}/{dataset} and {la_code}/{dataset} are left as placeholders
        "dataset_values": name(e["dataset_values_path"]) if e.get("dataset_values_path") else None,
        "oa_values": name(e["oa_values_path"]) if e.get("oa_values_path") else None,
        "oa_level": cfg.get("census", {}).get("oa_level"),
        # level -> the output-area field naming its area (OA membership, e.g. for queries)
        "oa_groups": dict(cfg.get("census", {}).get("groups", {})),
        "neighbours": {r["level"]: r["field"] for r in cfg["assign"].get("neighbours", [])},
        "index_fields": e["index_fields"],
        "metrics_file": name(e["metrics_file"]),
        "explorer_file": name(e["explorer_file"]),
        "levels": {lv: {"label": spec.get("label", lv),
                        "plural": spec.get("label_plural", spec.get("label", lv) + "s")}
                   for lv, spec in cfg["levels"].items()},
        "la_codes": la_codes,
    }


def publish(export_cfg: dict[str, Any]) -> Path | None:
    """Replace publish_dir with a copy of out_dir."""
    if not export_cfg.get("publish_dir"):
        return None
    src, dst = resolve_path(export_cfg["out_dir"]), resolve_path(export_cfg["publish_dir"])
    if not dst.resolve().is_relative_to(PROJECT_ROOT) or dst.resolve() in (
            src.resolve(), *src.resolve().parents):
        raise ValueError(f"refusing to publish to {dst}: must be inside the project and not "
                         f"contain {src}")
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    size = sum(p.stat().st_size for p in dst.rglob("*") if p.is_file())
    log.info("publish: copied %s -> %s (%.1f MB)", src, dst, size / 1e6)
    return dst


def export_all(levels: dict[str, gpd.GeoDataFrame], cfg: dict[str, Any],
               metrics: dict[str, Any] | None = None,
               explorer: dict[str, Any] | None = None,
               oa_values: dict[str, dict[str, dict[str, list]]] | None = None) -> pd.DataFrame:
    """Write every output file, then publish.

    With `export.dataset_values_path`, the values of dataset metrics leave `metrics` for one
    file per dataset and level; without it they stay in the metrics file.

    Returns one row per file: file, level, la_code, features, raw_bytes
    (uncompressed JSON) and bytes (on disk).
    """
    export_cfg = cfg["export"]
    out_dir = resolve_path(export_cfg["out_dir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    log.info("export: removed %d previous output files", clean_outputs(export_cfg, out_dir))

    la_level = cfg["assign"]["la_level"]
    la_codes = sorted(levels[la_level]["code"])
    writer = Writer(out_dir, export_cfg)
    export_geometry(levels, la_level, la_codes, export_cfg, writer)
    export_indexes(levels, la_codes, export_cfg, writer)
    if oa_values and export_cfg.get("oa_values_path"):
        export_oa_values(oa_values, la_codes, export_cfg, writer)
    if metrics is not None:
        if export_cfg.get("dataset_values_path"):
            metrics, by_dataset = split_metrics(metrics)
            export_dataset_values(by_dataset, export_cfg, writer)
        writer.write(export_cfg["metrics_file"], dumps(metrics), "metrics", None,
                     len(metrics["metrics"]))
    if explorer is not None:
        writer.write(export_cfg["explorer_file"], dumps(explorer), "explorer", None,
                     sum(len(c["indicators"]) for c in explorer["categories"]))
    manifest_path = out_dir / export_cfg["manifest_file"]
    manifest_path.write_text(json.dumps(build_manifest(cfg, la_codes), indent=1), encoding="utf-8")
    writer.records.append({"file": export_cfg["manifest_file"], "level": "manifest",
                           "la_code": None, "features": 0, "raw_bytes": manifest_path.stat().st_size,
                           "bytes": manifest_path.stat().st_size})

    files = pd.DataFrame(writer.records)
    log.info("export: %d files, %.1f MB on disk (%.1f MB uncompressed), in %s",
             len(files), files["bytes"].sum() / 1e6, files["raw_bytes"].sum() / 1e6, out_dir)
    publish(export_cfg)
    return files


def log_files(level: str, features_in: int, records: list[dict]) -> None:
    log.info("%s: %d features in -> %d out across %d files, %.1f MB on disk (%.1f MB raw)",
             level, features_in, sum(r["features"] for r in records), len(records),
             sum(r["bytes"] for r in records) / 1e6, sum(r["raw_bytes"] for r in records) / 1e6)


# --- size report -------------------------------------------------------------

def size_summary(files: pd.DataFrame, max_mb: float) -> pd.DataFrame:
    """Per level: file count, raw/on-disk totals, largest file, files over max_mb on disk."""
    f = files.assign(mb=files["bytes"] / 1e6, raw_mb=files["raw_bytes"] / 1e6)
    largest = f.loc[f.groupby("level", sort=False)["mb"].idxmax()].set_index("level")
    summary = f.groupby("level", sort=False).agg(
        files=("file", "size"), features=("features", "sum"),
        raw_mb=("raw_mb", "sum"), disk_mb=("mb", "sum"),
        over_limit=("bytes", lambda s: int((s > max_mb * 1e6).sum())))
    summary["largest_file"] = largest["file"]
    summary["largest_mb"] = largest["mb"]
    return summary.reset_index().round({"raw_mb": 2, "disk_mb": 2, "largest_mb": 2})


def oversized(files: pd.DataFrame, max_mb: float) -> pd.DataFrame:
    f = files.assign(mb=(files["bytes"] / 1e6).round(2), raw_mb=(files["raw_bytes"] / 1e6).round(2))
    return f[f["bytes"] > max_mb * 1e6].sort_values("mb", ascending=False)[
        ["file", "features", "raw_mb", "mb"]].reset_index(drop=True)
