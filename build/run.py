"""Build entry point.

    python -m build.run           load, assign, simplify and export to data/processed
    python -m build.run --check   load every level and print a QA table
"""
from __future__ import annotations

import argparse
import logging
import sys
from typing import Any

import geopandas as gpd
import pandas as pd

from build.assign import assign, localities_per_la
from build.census import build_census_metrics, load_datasets, oa_values_by_la, with_dataset_metrics
from build.config import load_levels_config, resolve_path
from build.explorer import check_references, load_explorer_config
from build.export import export_all, oversized, size_summary
from build.load import load_all, read_source, to_common_schema
from build.metrics import build_metrics, load_metrics_config
from build.simplify import simplify_all

log = logging.getLogger("build")


def geometry_stats(gdf: gpd.GeoDataFrame) -> dict[str, int]:
    geom = gdf.geometry
    null_or_empty = geom.isna() | geom.is_empty
    present = geom[~null_or_empty]
    return {
        "null_empty": int(null_or_empty.sum()),
        "invalid": int((~present.is_valid).sum()),
    }


def check_level(level: str, cfg: dict[str, Any]) -> dict[str, Any]:
    spec = cfg["levels"][level]
    src = to_common_schema(level, read_source(level, spec, cfg["source_crs"]), spec)
    out = src.to_crs(cfg["output_crs"])
    src_stats, out_stats = geometry_stats(src), geometry_stats(out)
    return {
        "level": level,
        "rows": len(out),
        "crs": f"{src.crs.to_string()} -> {out.crs.to_string()}",
        "null_empty_geom": out_stats["null_empty"],
        "dup_codes": int(out["code"].duplicated(keep=False).sum()),
        "invalid_src": src_stats["invalid"],
        "invalid_out": out_stats["invalid"],
    }


def print_table(rows: list[dict[str, Any]]) -> None:
    headers = list(rows[0])
    widths = [max(len(h), *(len(str(r[h])) for r in rows)) for h in headers]
    line = "  ".join(h.ljust(w) for h, w in zip(headers, widths))
    print(line)
    print("-" * len(line))
    for r in rows:
        print("  ".join(str(r[h]).ljust(w) for h, w in zip(headers, widths)))


def run_check(cfg: dict[str, Any]) -> int:
    rows = [check_level(level, cfg) for level in cfg["levels"]]
    print()
    print_table(rows)
    print("\ndup_codes counts every row whose code appears more than once.")
    print("invalid_src = invalid in source CRS; invalid_out = invalid after reprojection.")
    return 0


def run_build(cfg: dict[str, Any]) -> int:
    datasets_dir = resolve_path(cfg["census"]["datasets_dir"])
    datasets = load_datasets(datasets_dir)
    metrics_cfg = with_dataset_metrics(load_metrics_config(), datasets)
    # fail on a bad id before the slow steps
    explorer = load_explorer_config(metrics_cfg, levels_cfg=cfg, datasets_dir=datasets_dir)
    result = assign(load_all(cfg), cfg)
    print(f"\nAssignment report (LA geometry: {cfg['assign']['la_geometry']})\n")
    print_table(result.summary().to_dict("records"))
    print("\nLocalities per LA\n")
    print_table(localities_per_la(result, cfg).to_dict("records"))

    oa = result.levels[cfg["census"]["oa_level"]]
    census = build_census_metrics(result.levels, oa, datasets, cfg["census"])
    metrics = build_metrics(result.levels, metrics_cfg, census)
    check_references(explorer, metrics, cfg["assign"]["la_level"])
    files = export_all(simplify_all(result.levels, cfg), cfg, metrics, explorer,
                       oa_values_by_la(census, oa))
    print_size_report(files, cfg["export"]["max_file_mb"])
    return 0


def print_size_report(files: pd.DataFrame, max_mb: float) -> None:
    print("\nOutput sizes (MB = 10^6 bytes; raw = minified JSON, disk = as written)\n")
    print_table(size_summary(files, max_mb).to_dict("records"))
    big = oversized(files, max_mb)
    print(f"\n{len(big)} of {len(files)} files over {max_mb} MB")
    if len(big):
        print()
        print_table(big.to_dict("records"))
    print()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m build.run")
    parser.add_argument("--check", action="store_true", help="print per-level QA stats")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    logging.getLogger("pyogrio").setLevel(logging.WARNING)  # per-file "Created N records"
    cfg = load_levels_config()
    return run_check(cfg) if args.check else run_build(cfg)


if __name__ == "__main__":
    sys.exit(main())
