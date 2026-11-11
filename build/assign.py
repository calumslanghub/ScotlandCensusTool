"""Assign each feature its parent LA (parent_code) and, for small levels, a locality.

Rules (see CLAUDE.md):
  - Levels with a mapped parent_code column (OA, postcode) keep the source `council`
    value; it is only checked against the LA table.
  - Levels with `parent_join: representative_point` (DZ, locality) get the code of
    the LA polygon containing the feature's representative point. A representative
    point always lies inside its feature (a centroid need not, e.g. for crescent or
    multipart shapes), so a feature straddling an LA boundary is assigned to exactly
    one LA, deterministically.
  - Each `assign.locality_targets` level (OA, postcode) gets `assign.locality_field`:
    the locality containing its representative point, or null when none does.
  - `assign.lookup_fields` add attributes by code from a JoinGuide lookup CSV (e.g. the
    OA's electoral ward, EW2022).
  - `assign.point_fields` link a level to the `from` feature containing its representative
    point (postcode -> OA) and copy that feature's fields (the ward). An optional `check`
    lookup is compared and the agreement rate logged.
  - `assign.area_fields` link a level to the `from` feature holding the largest share of
    its area (measured in source_crs; ties: lowest code), for boundaries with no lookup
    that do not nest (OA -> community council). Optional `parents` limits it to features
    in those council areas (others get null); `counts` are then summed from the linked
    features onto the `from` features (their pop / households).
  - Derived levels (levels.yaml `derived`, e.g. electoral wards) are the `from` level
    dissolved by `group_field`, named from a lookup; parent LA = the LA holding most of
    their member features (ties: lowest code), with straddlers logged.
  - `assign.neighbours` give each feature of a level a sorted list of the codes of the
    features that touch it (share an edge or a corner), e.g. the wards around a ward.

LA polygons come from `assign.la_geometry`:
  - dissolve_oa (default): the OA level dissolved by parent_code. Shares coastline
    and boundaries with the other Census layers, so points cannot fall in gaps.
  - file: the LA level's own boundary file.

Every assignment produces a report row per feature with one of STATUSES.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

from build.config import is_derived, resolve_path
from build.geometry import valid_polygons
from build.load import SCHEMA

log = logging.getLogger(__name__)

MATCHED = "matched"
NO_MATCH = "no_match"
MULTIPLE_MATCH = "multiple_match"
EMPTY_GEOMETRY = "empty_geometry"
MISSING_COUNCIL = "missing_council"
UNKNOWN_COUNCIL = "unknown_council"
STATUSES = (MATCHED, NO_MATCH, MULTIPLE_MATCH, EMPTY_GEOMETRY, MISSING_COUNCIL, UNKNOWN_COUNCIL)

REPORT_COLUMNS = ("level", "field", "code", "status")


@dataclass
class AssignResult:
    levels: dict[str, gpd.GeoDataFrame]
    report: pd.DataFrame  # one row per feature per assigned field: REPORT_COLUMNS

    def summary(self) -> pd.DataFrame:
        """Feature counts per level, field and status."""
        return (self.report.groupby(["level", "field", "status"]).size()
                .rename("count").reset_index())

    def failures(self, field: str = "parent_code") -> pd.DataFrame:
        """Rows for `field` that did not resolve to exactly one valid code."""
        r = self.report
        return r[(r["field"] == field) & (r["status"] != MATCHED)]


# --- geometry helpers --------------------------------------------------------

def representative_points(gdf: gpd.GeoDataFrame) -> gpd.GeoSeries:
    points = shapely.point_on_surface(valid_polygons(gdf.geometry.values))
    return gpd.GeoSeries(points, index=gdf.index, crs=gdf.crs)


def union_coverage(geoms: np.ndarray) -> shapely.Geometry:
    """Union polygons that tile without overlaps; fall back to a full union."""
    try:
        merged = shapely.coverage_union_all(geoms)
        if merged.is_valid:
            return merged
    except shapely.errors.GEOSException:
        pass
    log.warning("coverage union failed or invalid; falling back to union_all")
    return shapely.union_all(geoms)


# --- LA table ----------------------------------------------------------------

def dissolve_by_parent(gdf: gpd.GeoDataFrame, level: str) -> gpd.GeoDataFrame:
    """One feature per parent_code: geometry unioned, counts and area summed."""
    return dissolve_by(gdf, "parent_code", level)


def dissolve_by(gdf: gpd.GeoDataFrame, field: str, level: str) -> gpd.GeoDataFrame:
    """One feature per value of `field` (nulls dropped): geometry unioned, counts and
    area summed. name and parent_code are left to the caller."""
    gdf = gdf[gdf[field].notna()]
    geoms = valid_polygons(gdf.geometry.values)
    groups = gdf.groupby(field).indices
    codes = sorted(groups)
    sums = gdf.groupby(field)[["pop", "households", "area_km2"]].sum().loc[codes]
    out = pd.DataFrame({
        "code": pd.array(codes, dtype="string"),
        "name": pd.array(codes, dtype="string"),
        "level": level,
        "parent_code": pd.Series(pd.NA, index=range(len(codes)), dtype="string"),
        "pop": sums["pop"].to_numpy(),
        "households": sums["households"].to_numpy(),
        "area_km2": sums["area_km2"].to_numpy(),
    })
    geometry = [union_coverage(geoms[groups[c]]) for c in codes]
    return gpd.GeoDataFrame(out, geometry=geometry, crs=gdf.crs)


def la_table(levels: dict[str, gpd.GeoDataFrame], assign_cfg: dict[str, Any]) -> gpd.GeoDataFrame:
    la_level = assign_cfg["la_level"]
    file_la = levels[la_level]
    source = assign_cfg.get("la_geometry", "dissolve_oa")
    if source == "file":
        log.info("LA table: %d features from %s file", len(file_la), la_level)
        return file_la
    base = levels[assign_cfg["dissolve_level"]]
    la = dissolve_by_parent(base, la_level)
    names = file_la.set_index("code")["name"]
    la["name"] = la["code"].map(names).fillna(la["code"]).astype("string")
    unnamed = int((~la["code"].isin(names.index)).sum())
    if unnamed:
        log.warning("LA table: %d dissolved codes not in %s file (named by code)", unnamed, la_level)
    log.info("LA table: dissolved %d %s features -> %d LAs",
             len(base), assign_cfg["dissolve_level"], len(la))
    return la[[*SCHEMA, "geometry"]]


# --- assignment --------------------------------------------------------------

def join_points(features: gpd.GeoDataFrame,
                polygons: gpd.GeoDataFrame) -> tuple[pd.Series, pd.Series]:
    """Code of the polygon containing each feature's representative point.

    Returns (code, status), both indexed like `features`; code is null unless
    exactly one polygon contains the point.
    """
    n = len(features)
    points = representative_points(features)
    pts = gpd.GeoDataFrame({"_pos": np.arange(n)}, geometry=points.values, crs=features.crs)
    polys = gpd.GeoDataFrame({"_match": polygons["code"].to_numpy()},
                             geometry=valid_polygons(polygons.geometry.values),
                             crs=polygons.crs).to_crs(features.crs)
    hits = gpd.sjoin(pts, polys, predicate="within", how="inner")
    grouped = hits.groupby("_pos")["_match"]
    counts = grouped.size().reindex(range(n), fill_value=0).to_numpy()
    first = grouped.first().reindex(range(n)).to_numpy()

    empty = (points.isna() | points.is_empty).to_numpy()
    status = np.select([empty, counts == 0, counts > 1],
                       [EMPTY_GEOMETRY, NO_MATCH, MULTIPLE_MATCH], default=MATCHED)
    code = pd.Series(first, index=features.index, dtype="string").where(status == MATCHED)
    return code, pd.Series(status, index=features.index)


def council_status(gdf: gpd.GeoDataFrame, la_codes: set[str]) -> pd.Series:
    parent = gdf["parent_code"]
    status = np.select([parent.isna().to_numpy(), (~parent.isin(la_codes)).to_numpy()],
                       [MISSING_COUNCIL, UNKNOWN_COUNCIL], default=MATCHED)
    return pd.Series(status, index=gdf.index)


def report_rows(level: str, field: str, gdf: gpd.GeoDataFrame, status: pd.Series) -> pd.DataFrame:
    return pd.DataFrame({"level": level, "field": field,
                         "code": gdf["code"].to_numpy(), "status": status.to_numpy()})


def log_status(level: str, field: str, status: pd.Series) -> None:
    counts = status.value_counts()
    other = ", ".join(f"{s} {n}" for s, n in counts.items() if s != MATCHED)
    log.info("%s.%s: matched %d/%d%s", level, field, counts.get(MATCHED, 0),
             len(status), f" ({other})" if other else "")


def assign_parents(levels: dict[str, gpd.GeoDataFrame], cfg: dict[str, Any],
                   la: gpd.GeoDataFrame) -> tuple[dict[str, gpd.GeoDataFrame], list[pd.DataFrame]]:
    la_codes = set(la["code"].dropna())
    out, reports = {}, []
    for level, spec in cfg["levels"].items():
        if level == cfg["assign"]["la_level"] or is_derived(spec):
            continue
        gdf = levels[level].copy()
        if spec.get("parent_join"):
            gdf["parent_code"], status = join_points(gdf, la)
        elif spec["fields"]["parent_code"]:
            status = council_status(gdf, la_codes)
        else:
            raise ValueError(f"{level}: no parent_code column and no parent_join rule")
        log_status(level, "parent_code", status)
        reports.append(report_rows(level, "parent_code", gdf, status))
        out[level] = gdf
    return out, reports


def assign_localities(levels: dict[str, gpd.GeoDataFrame],
                      assign_cfg: dict[str, Any]) -> list[pd.DataFrame]:
    """Add the locality field to each target level in place."""
    field = assign_cfg["locality_field"]
    localities = levels[assign_cfg["locality_level"]]
    reports = []
    for level in assign_cfg["locality_targets"]:
        gdf = levels[level]
        gdf[field], status = join_points(gdf, localities)
        log_status(level, field, status)
        reports.append(report_rows(level, field, gdf, status))
    return reports


def read_lookup(path: str, columns: list[str]) -> pd.DataFrame:
    df = pd.read_csv(resolve_path(path), dtype="string", encoding="utf-8-sig", usecols=columns)
    return df.apply(lambda c: c.str.strip())


def assign_lookup_fields(levels: dict[str, gpd.GeoDataFrame],
                         assign_cfg: dict[str, Any]) -> list[pd.DataFrame]:
    """Add lookup attributes by code, in place. Codes missing from the lookup get null."""
    reports = []
    for rule in assign_cfg.get("lookup_fields", []):
        gdf = levels[rule["level"]]
        table = read_lookup(rule["path"], [rule["key"], *rule["fields"].values()])
        table = table.drop_duplicates(rule["key"]).set_index(rule["key"])
        for out_field, column in rule["fields"].items():
            gdf[out_field] = gdf["code"].map(table[column]).astype("string")
            status = pd.Series(np.where(gdf[out_field].notna(), MATCHED, NO_MATCH), index=gdf.index)
            log_status(rule["level"], out_field, status)
            reports.append(report_rows(rule["level"], out_field, gdf, status))
    return reports


def check_point_link(level: str, gdf: gpd.GeoDataFrame, link_field: str,
                     check: dict[str, str]) -> None:
    """Log how often the spatial link agrees with a lookup CSV (QA only)."""
    table = read_lookup(check["path"], [check["key"], check["value"]])
    table = table.drop_duplicates(check["key"]).set_index(check["key"])[check["value"]]
    expected = gdf["code"].map(table)
    known = expected.notna() & gdf[link_field].notna()
    agree = int((expected[known] == gdf.loc[known, link_field]).sum())
    log.info("%s.%s vs %s: %d of %d agree (%.2f%%); %d not in the check file", level, link_field,
             resolve_path(check["path"]).name, agree, int(known.sum()),
             100 * agree / max(int(known.sum()), 1), int(expected.isna().sum()))


def assign_point_fields(levels: dict[str, gpd.GeoDataFrame],
                        assign_cfg: dict[str, Any]) -> list[pd.DataFrame]:
    """Link features to the `from` feature containing their representative point, in place."""
    reports = []
    for rule in assign_cfg.get("point_fields", []):
        level = rule["level"]
        gdf, source = levels[level], levels[rule["from"]]
        gdf[rule["link_field"]], status = join_points(gdf, source)
        log_status(level, rule["link_field"], status)
        reports.append(report_rows(level, rule["link_field"], gdf, status))
        attrs = source.set_index("code")
        for f in rule["fields"]:
            gdf[f] = gdf[rule["link_field"]].map(attrs[f]).astype("string")
        if rule.get("check"):
            check_point_link(level, gdf, rule["link_field"], rule["check"])
    return reports


def join_largest_overlap(features: gpd.GeoDataFrame, polygons: gpd.GeoDataFrame,
                         crs: str) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Code of the polygon covering most of each feature's area, measured in `crs`.

    Returns (code, status, share): share is the winner's fraction of the feature's area.
    Ties go to the lowest code. A feature that overlaps no polygon gets NO_MATCH.
    """
    f = valid_polygons(features.to_crs(crs).geometry.values)
    p_gdf = polygons.to_crs(crs)
    p, codes = valid_polygons(p_gdf.geometry.values), p_gdf["code"].to_numpy()
    left, right = gpd.GeoSeries(p, crs=crs).sindex.query(f, predicate="intersects")
    pairs = pd.DataFrame({"pos": left, "match": codes[right],
                          "area": shapely.area(shapely.intersection(f[left], p[right]))})
    best = (pairs[pairs["area"] > 0].sort_values(["pos", "area", "match"], ascending=[True, False, True])
            .drop_duplicates("pos").set_index("pos").reindex(range(len(features))))
    empty = shapely.is_missing(f) | shapely.is_empty(f)
    status = np.select([empty, best["match"].isna().to_numpy()], [EMPTY_GEOMETRY, NO_MATCH], default=MATCHED)
    code = pd.Series(best["match"].to_numpy(), index=features.index, dtype="string").where(status == MATCHED)
    share = pd.Series(best["area"].to_numpy() / shapely.area(f), index=features.index)
    return code, pd.Series(status, index=features.index), share


def assign_area_fields(levels: dict[str, gpd.GeoDataFrame], assign_cfg: dict[str, Any],
                       source_crs: str) -> list[pd.DataFrame]:
    """Link features to the `from` feature holding most of their area, in place; sum
    `counts` from the linked features onto the `from` level."""
    reports = []
    for rule in assign_cfg.get("area_fields", []):
        level, field = rule["level"], rule["link_field"]
        gdf, source = levels[level], levels[rule["from"]]
        scope = gdf["parent_code"].isin(rule["parents"]) if rule.get("parents") else pd.Series(True, index=gdf.index)
        sub = gdf[scope]
        code, status, share = join_largest_overlap(sub, source, source_crs)
        gdf[field] = pd.Series(pd.NA, index=gdf.index, dtype="string")
        gdf.loc[sub.index, field] = code
        log_status(level, field, status)
        won = share[status == MATCHED]
        log.info("%s.%s: %d %s in scope of %d; winner holds <50%% of the area for %d, <90%% for %d; "
                 "%d of %d %s get no %s", level, field, len(sub), level, len(gdf), int((won < 0.5).sum()),
                 int((won < 0.9).sum()), int((~source["code"].isin(code.dropna())).sum()), len(source),
                 rule["from"], level)
        reports.append(report_rows(level, field, sub, status))
        if rule.get("counts"):
            sums = gdf[gdf[field].notna()].groupby(field)[rule["counts"]].sum()
            out = source.copy()
            for c in rule["counts"]:
                out[c] = out["code"].map(sums[c]).astype("Int64")
            levels[rule["from"]] = out
            log.info("%s: %s summed from %s (%d features have none)", rule["from"], rule["counts"],
                     level, int(out[rule["counts"][0]].isna().sum()))
    return reports


def majority(values: pd.Series) -> Any:
    """Most common value; ties go to the lowest, so the result is deterministic."""
    counts = values.dropna().value_counts()
    if counts.empty:
        return pd.NA
    return min(counts[counts == counts.max()].index)


def derive_level(level: str, spec: dict[str, Any], levels: dict[str, gpd.GeoDataFrame]
                 ) -> tuple[gpd.GeoDataFrame, pd.DataFrame]:
    d = spec["derived"]
    members, field = levels[d["from"]], d["group_field"]
    out = dissolve_by(members, field, level)
    names = read_lookup(d["names"]["path"], [d["names"]["code"], d["names"]["name"]])
    names = names.drop_duplicates(d["names"]["code"]).set_index(d["names"]["code"])[d["names"]["name"]]
    out["name"] = out["code"].map(names).fillna(out["code"]).astype("string")
    grouped = members[members[field].notna()].groupby(field)["parent_code"]
    out["parent_code"] = out["code"].map(grouped.agg(majority)).astype("string")
    log.info("%s: derived %d features from %d %s by %s (%d straddle LAs, %d unnamed, "
             "%d %s without %s)", level, len(out), len(members), d["from"], field,
             int((grouped.nunique() > 1).sum()), int((~out["code"].isin(names.index)).sum()),
             int(members[field].isna().sum()), d["from"], field)
    status = pd.Series(np.where(out["parent_code"].notna(), MATCHED, NO_MATCH), index=out.index)
    return out[[*SCHEMA, "geometry"]], report_rows(level, "parent_code", out, status)


def neighbour_lists(gdf: gpd.GeoDataFrame) -> list[list[str]]:
    """For each feature, the sorted codes of the other features its geometry intersects."""
    left, right = gdf.sindex.query(gdf.geometry.values, predicate="intersects")
    codes = gdf["code"].to_numpy()
    out: list[set[str]] = [set() for _ in range(len(gdf))]
    for i, j in zip(left, right):
        if i != j and codes[i] != codes[j]:
            out[i].add(str(codes[j]))
    return [sorted(n) for n in out]


def assign_neighbours(levels: dict[str, gpd.GeoDataFrame], assign_cfg: dict[str, Any]) -> None:
    """Add each `assign.neighbours` field in place (levels must already be final, e.g. derived)."""
    for rule in assign_cfg.get("neighbours", []):
        level, field = rule["level"], rule["field"]
        gdf = levels[level].copy()
        gdf[field] = pd.Series(neighbour_lists(gdf), index=gdf.index, dtype=object)
        counts = gdf[field].map(len)
        log.info("%s: %s for %d features in -> %d out (mean %.1f neighbours, %d with none)",
                 level, field, len(levels[level]), len(gdf), counts.mean() if len(gdf) else 0.0,
                 int((counts == 0).sum()))
        levels[level] = gdf


def assign(levels: dict[str, gpd.GeoDataFrame], cfg: dict[str, Any]) -> AssignResult:
    """Assign parent_code to every non-LA level and locality codes to target levels.

    Inputs are not modified. The returned LA level is the LA table actually used
    for joins (dissolved from OA by default).
    """
    assign_cfg = cfg["assign"]
    la = la_table(levels, assign_cfg)
    out, reports = assign_parents(levels, cfg, la)
    out[assign_cfg["la_level"]] = la
    reports += assign_localities(out, assign_cfg)
    reports += assign_lookup_fields(out, assign_cfg)
    reports += assign_point_fields(out, assign_cfg)
    reports += assign_area_fields(out, assign_cfg, cfg["source_crs"])
    for level, spec in cfg["levels"].items():
        if is_derived(spec):
            out[level], report = derive_level(level, spec, out)
            reports.append(report)
    assign_neighbours(out, assign_cfg)
    report = pd.concat(reports, ignore_index=True)[list(REPORT_COLUMNS)]
    return AssignResult(levels=out, report=report)


def localities_per_la(result: AssignResult, cfg: dict[str, Any]) -> pd.DataFrame:
    """Locality count and population per LA, including LAs with none."""
    assign_cfg = cfg["assign"]
    la = result.levels[assign_cfg["la_level"]]
    loc = result.levels[assign_cfg["locality_level"]]
    agg = loc.groupby("parent_code").agg(localities=("code", "size"), locality_pop=("pop", "sum"))
    table = la[["code", "name"]].set_index("code").join(agg)
    table["localities"] = table["localities"].fillna(0).astype(int)
    table["locality_pop"] = table["locality_pop"].fillna(0).astype("Int64")
    return table.reset_index().sort_values("name", ignore_index=True)
