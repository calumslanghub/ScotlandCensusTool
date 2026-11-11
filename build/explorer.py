"""Load, validate and export config/explorer.yaml (what the explorer shows and how).

The front end builds its tabs, indicator list and chart panels only from the
explorer.json written here, plus metrics.json. Validation fails the build with the
offending indicator id:
  - every `metric` and panel `series` id must exist in config/metrics.yaml
  - every map `scheme` must be a known ramp (build.config.KNOWN_RAMPS)
  - `reference_lines` values must be in REFERENCE_LINES
  - panel types, marks, scales and map methods come from the closed lists below

Indicators backed by a `dataset` (config/datasets/<id>.yaml) name the dataset's local ids
(`headline`, panel `series`); they are expanded here to the full metric ids and given a
`map.options` list for the map's Show dropdown. They are left out of explorer.json until
that dataset exists with `status: ready`.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml

from build.census import DATASETS_DIR, full_id, is_ready, load_datasets, metric_defs, with_dataset_metrics
from build.config import KNOWN_RAMPS, PROJECT_ROOT, ConfigError, assigned_fields

log = logging.getLogger(__name__)

EXPLORER_PATH = PROJECT_ROOT / "config" / "explorer.yaml"

PANEL_TYPES = ("ranked", "profile", "composition", "breakdown")
SERIES_PANELS = ("profile", "composition", "breakdown")
OPTION_KINDS = ("mean", "share")      # dataset metric kinds offered in the map's Show dropdown
DEFAULT_INDICATOR_LEVELS = ("la", "ew", "locality", "dz", "cc")
MARKS = ("dot", "bar")
SCALES = ("linear", "log")
REFERENCE_LINES = ("national", "la")
MAP_METHODS = ("quantile", "jenks")
SELECTORS = ("category",)
READY = "ready"
COMPARE_KEYS = {"max_items", "same_level_only"}
COMPARE_COLOURS = 4            # web/css/tokens.css --compare-1..4
BASELINE_KEYS = {"modes", "scheme", "levels", "min_denominator"}
BASELINE_MODES = ("relative", "difference")
BASELINE_SCHEMES = ("diverging",)
DENOMINATOR_FIELDS = ("pop", "households")   # common-schema counts on every feature
BASEMAP_KEYS = {"attribution", "tiles", "label_tiles", "tile_size", "max_zoom",
                "fill_opacity", "context_opacity"}
TILE_PLACEHOLDERS = ("{z}", "{x}", "{y}")
STEP_KEYS = {"level", "link", "neighbours"}
QUERY_KEYS = {"levels", "scopes", "needs_scope", "preset_band", "max_criteria", "scheme"}
QUERY_MAX_CRITERIA = (2, 8)
QUERY_PRESET_BAND = (1, 50)    # percent of the areas in scope that "High" / "Low" pick
CLUSTER_KEYS = {"enabled", "k_max", "restarts", "max_iter", "seed", "min_pop", "silhouette_sample",
                "max_work", "min_cores", "min_memory_gb"}
CLUSTER_K_MAX = (2, 10)        # one categorical colour per cluster (d3 schemeTableau10)


def load_explorer_config(metrics_cfg: dict[str, Any], path: Path | None = None,
                         datasets_dir: Path | None = None,
                         levels_cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    """Validated explorer config: dataset indicators expanded, not-yet-ready ones removed.

    levels_cfg: config/levels.yaml. Map modes, overlays and baseline.levels name
    geography levels and link fields that only it knows; without it they are checked
    against the metric levels alone.
    """
    with open(path or EXPLORER_PATH, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    datasets = load_datasets(datasets_dir or DATASETS_DIR)
    cfg = visible_config(cfg, datasets)
    validate_explorer_config(cfg, with_dataset_metrics(metrics_cfg, datasets), levels_cfg)
    return cfg


# --- validation --------------------------------------------------------------

def validate_explorer_config(cfg: dict[str, Any], metrics_cfg: dict[str, Any],
                             levels_cfg: dict[str, Any] | None = None) -> None:
    metric_ids = {m["id"] for m in metrics_cfg["metrics"]}
    levels = set(metrics_cfg["levels"])
    geo_levels = set(levels_cfg["levels"]) if levels_cfg else levels
    validate_compare(cfg.get("compare"))
    validate_baseline(cfg.get("baseline"), geo_levels)
    validate_query(cfg.get("query"), geo_levels)
    validate_cluster(cfg.get("cluster"), cfg.get("query"))
    validate_basemap(cfg.get("basemap"), geo_levels)
    if levels_cfg:
        validate_overlays(cfg.get("overlays") or {}, levels_cfg)
        validate_mode_paths(cfg.get("map_modes", []), set(cfg.get("overlays") or {}), levels_cfg)
    if not cfg.get("categories"):
        raise ConfigError("explorer.yaml: needs at least one category")
    unknown = [c for c in cfg.get("summary_cards", []) if c not in metric_ids]
    if unknown:
        raise ConfigError(f"explorer.yaml summary_cards: unknown metric ids {unknown} "
                          "(not in config/metrics.yaml)")
    validate_map_modes(cfg.get("map_modes", []))
    unique([c.get("id") for c in cfg["categories"]], "category")
    unique([i.get("id") for c in cfg["categories"] for i in c.get("indicators", [])], "indicator")
    for category in cfg["categories"]:
        if not category.get("indicators"):
            raise ConfigError(f"explorer.yaml category '{category.get('id')}': no indicators")
        for indicator in category["indicators"]:
            validate_indicator(indicator, metric_ids, levels)


def unique(ids: list[Any], what: str) -> None:
    dupes = sorted({i for i in ids if ids.count(i) > 1}, key=str)
    if dupes or None in ids:
        raise ConfigError(f"explorer.yaml: every {what} needs a unique id (duplicates: {dupes})")


def unknown_keys(block: dict[str, Any], allowed: set[str], where: str) -> None:
    extra = sorted(set(block) - allowed)
    if extra:
        raise ConfigError(f"explorer.yaml {where}: unknown keys {extra} (allowed: {sorted(allowed)})")


def validate_compare(c: dict[str, Any] | None) -> None:
    if c is None:
        return
    unknown_keys(c, COMPARE_KEYS, "compare")
    n = c.get("max_items")
    if not isinstance(n, int) or isinstance(n, bool) or not 2 <= n <= COMPARE_COLOURS:
        raise ConfigError(f"explorer.yaml compare.max_items must be an integer 2..{COMPARE_COLOURS} "
                          f"(one colour each), got {n!r}")
    if c.get("same_level_only", True) is not True:
        raise ConfigError("explorer.yaml compare.same_level_only: only true is supported")


def validate_baseline(b: dict[str, Any] | None, geo_levels: set[str]) -> None:
    if b is None:
        return
    unknown_keys(b, BASELINE_KEYS, "baseline")
    modes = b.get("modes")
    if not modes or not isinstance(modes, list) or any(m not in BASELINE_MODES for m in modes):
        raise ConfigError(f"explorer.yaml baseline.modes must be a non-empty list from {BASELINE_MODES}, "
                          f"got {modes!r}")
    if b.get("scheme") not in BASELINE_SCHEMES:
        raise ConfigError(f"explorer.yaml baseline.scheme must be one of {BASELINE_SCHEMES}, "
                          f"got {b.get('scheme')!r}")
    bad = [lv for lv in b.get("levels") or [] if lv not in geo_levels]
    if not b.get("levels") or bad:
        raise ConfigError(f"explorer.yaml baseline.levels: unknown levels {bad} "
                          f"(known: {sorted(geo_levels)})")
    md = b.get("min_denominator")
    if md is not None:
        if not isinstance(md, dict) or set(md) != {"field", "value"}:
            raise ConfigError("explorer.yaml baseline.min_denominator needs {field, value}")
        if md["field"] not in DENOMINATOR_FIELDS:
            raise ConfigError(f"explorer.yaml baseline.min_denominator.field must be one of "
                              f"{DENOMINATOR_FIELDS}, got {md['field']!r}")
        if not isinstance(md["value"], (int, float)) or md["value"] < 0:
            raise ConfigError("explorer.yaml baseline.min_denominator.value must be a number >= 0")


def is_int_in(value: Any, bounds: tuple[int, int]) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and bounds[0] <= value <= bounds[1]


def validate_query(q: dict[str, Any] | None, geo_levels: set[str]) -> None:
    """The "Find areas" tool: levels it queries, levels it can be limited to, slider presets."""
    if q is None:
        return
    unknown_keys(q, QUERY_KEYS, "query")
    for key in ("levels", "scopes"):
        values = q.get(key)
        bad = [lv for lv in values or [] if lv not in geo_levels]
        if not isinstance(values, list) or not values or bad:
            raise ConfigError(f"explorer.yaml query.{key}: needs a non-empty list of levels "
                              f"(unknown: {bad}, known: {sorted(geo_levels)})")
    stray = [lv for lv in q.get("needs_scope") or [] if lv not in q["levels"]]
    if not isinstance(q.get("needs_scope", []), list) or stray:
        raise ConfigError(f"explorer.yaml query.needs_scope: levels not in query.levels {stray}")
    if not is_int_in(q.get("preset_band"), QUERY_PRESET_BAND):
        raise ConfigError(f"explorer.yaml query.preset_band must be an integer "
                          f"{QUERY_PRESET_BAND[0]}..{QUERY_PRESET_BAND[1]}, got {q.get('preset_band')!r}")
    if not is_int_in(q.get("max_criteria"), QUERY_MAX_CRITERIA):
        raise ConfigError(f"explorer.yaml query.max_criteria must be an integer "
                          f"{QUERY_MAX_CRITERIA[0]}..{QUERY_MAX_CRITERIA[1]}, got {q.get('max_criteria')!r}")
    if q.get("scheme") not in KNOWN_RAMPS:
        raise ConfigError(f"explorer.yaml query.scheme: unknown ramp {q.get('scheme')!r}")


def is_number(value: Any, minimum: float = 0) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value >= minimum


def validate_cluster(c: dict[str, Any] | None, query: dict[str, Any] | None) -> None:
    """k-means "Cluster areas": a mode of the Find areas builder, so it needs the query block."""
    if c is None:
        return
    unknown_keys(c, CLUSTER_KEYS, "cluster")
    if not isinstance(c.get("enabled"), bool):
        raise ConfigError(f"explorer.yaml cluster.enabled must be true or false, got {c.get('enabled')!r}")
    if c["enabled"] and query is None:
        raise ConfigError("explorer.yaml cluster: needs the query block (it is a mode of Find areas)")
    if not is_int_in(c.get("k_max"), CLUSTER_K_MAX):
        raise ConfigError(f"explorer.yaml cluster.k_max must be an integer "
                          f"{CLUSTER_K_MAX[0]}..{CLUSTER_K_MAX[1]}, got {c.get('k_max')!r}")
    for key in ("restarts", "max_iter", "silhouette_sample", "min_cores"):
        if not is_int_in(c.get(key), (1, 10**7)):
            raise ConfigError(f"explorer.yaml cluster.{key} must be a positive integer, got {c.get(key)!r}")
    if not is_int_in(c.get("seed"), (0, 2**32 - 1)):
        raise ConfigError(f"explorer.yaml cluster.seed must be an integer 0..2^32-1, got {c.get('seed')!r}")
    for key in ("min_pop", "max_work", "min_memory_gb"):
        if not is_number(c.get(key)):
            raise ConfigError(f"explorer.yaml cluster.{key} must be a number >= 0, got {c.get(key)!r}")


def validate_tiles(urls: Any, key: str) -> None:
    if not isinstance(urls, list) or not urls or not all(
            isinstance(u, str) and u.startswith("https://") and all(p in u for p in TILE_PLACEHOLDERS)
            for u in urls):
        raise ConfigError(f"explorer.yaml basemap.{key} must be a non-empty list of https URLs "
                          f"containing {', '.join(TILE_PLACEHOLDERS)}, got {urls!r}")


def is_opacity(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1


def validate_basemap(b: dict[str, Any] | None, geo_levels: set[str]) -> None:
    """Raster tiles under the map (and labels over it) and the fill opacities that show them."""
    if b is None:
        return
    unknown_keys(b, BASEMAP_KEYS, "basemap")
    if not isinstance(b.get("attribution"), str) or not b["attribution"].strip():
        raise ConfigError("explorer.yaml basemap.attribution is required (tile licences need it)")
    validate_tiles(b.get("tiles"), "tiles")
    if "label_tiles" in b:
        validate_tiles(b["label_tiles"], "label_tiles")
    for key in ("tile_size", "max_zoom"):
        if key in b and (not isinstance(b[key], int) or isinstance(b[key], bool) or b[key] <= 0):
            raise ConfigError(f"explorer.yaml basemap.{key} must be a positive integer, got {b[key]!r}")
    fill = b.get("fill_opacity") or {}
    if not isinstance(fill, dict):
        raise ConfigError("explorer.yaml basemap.fill_opacity must map levels to opacities")
    bad = [lv for lv in fill if lv not in geo_levels]
    if bad:
        raise ConfigError(f"explorer.yaml basemap.fill_opacity: unknown levels {bad} "
                          f"(known: {sorted(geo_levels)})")
    for where, value in [*((f"fill_opacity.{lv}", v) for lv, v in fill.items()),
                         *((("context_opacity", b["context_opacity"]),) if "context_opacity" in b else ())]:
        if not is_opacity(value):
            raise ConfigError(f"explorer.yaml basemap.{where} must be a number 0..1, got {value!r}")


def validate_map_modes(modes: list[dict[str, Any]]) -> None:
    if modes and sum(bool(m.get("default")) for m in modes) != 1:
        raise ConfigError("explorer.yaml map_modes: exactly one mode needs default: true")
    unique([m.get("id") for m in modes], "map mode")


def link_fields(levels_cfg: dict[str, Any]) -> dict[str, set[str]]:
    """Fields a level's exported features can be filtered on: parent_code + assigned ones."""
    added = assigned_fields(levels_cfg)
    return {lv: {"parent_code", *added.get(lv, set())} for lv in levels_cfg["levels"]}


def validate_mode_paths(modes: list[dict[str, Any]], overlay_ids: set[str],
                        levels_cfg: dict[str, Any]) -> None:
    export, la_level = levels_cfg["export"], levels_cfg["assign"]["la_level"]
    national = {la_level, *export.get("national_levels", [])}
    per_la, fields = set(export["per_la_levels"]), link_fields(levels_cfg)
    adjacency = {r["level"] for r in levels_cfg["assign"].get("neighbours", [])}
    for mode in modes:
        where = f"explorer.yaml map mode '{mode.get('id')}'"
        steps = mode.get("path")
        if not steps or "label" not in mode:
            raise ConfigError(f"{where}: needs a label and a non-empty path")
        first = steps[0]
        if first.get("level") not in national or "link" in first:
            raise ConfigError(f"{where}: the first step must be a national level {sorted(national)} "
                              f"with no link, got {first}")
        for step in steps:
            unknown_keys(step, STEP_KEYS, f"map mode '{mode.get('id')}' step")
        for prev, step in zip(steps, steps[1:]):
            lv, link = step.get("level"), step.get("link")
            if step.get("neighbours") and prev["level"] not in adjacency:
                raise ConfigError(f"{where}: '{lv}' shows neighbours, but '{prev['level']}' has no "
                                  f"neighbour list (levels.yaml assign.neighbours)")
            if lv not in per_la:
                raise ConfigError(f"{where}: level '{lv}' has no per-LA file (export.per_la_levels)")
            if link not in fields[lv]:
                raise ConfigError(f"{where}: level '{lv}' cannot link on '{link}' "
                                  f"(available: {sorted(fields[lv])})")
            if link == "parent_code" and prev["level"] != la_level:
                raise ConfigError(f"{where}: '{lv}' links on parent_code, so the step before "
                                  f"must be '{la_level}', got '{prev['level']}'")
        bad = [o for o in mode.get("overlays", []) if o not in overlay_ids]
        if bad:
            raise ConfigError(f"{where}: unknown overlays {bad}")


def validate_overlays(overlays: dict[str, Any], levels_cfg: dict[str, Any]) -> None:
    per_la, fields = set(levels_cfg["export"]["per_la_levels"]), link_fields(levels_cfg)
    for oid, o in overlays.items():
        where = f"explorer.yaml overlay '{oid}'"
        missing = [k for k in ("label", "level", "at", "field") if k not in o]
        if missing:
            raise ConfigError(f"{where}: missing {missing}")
        if o["level"] not in per_la:
            raise ConfigError(f"{where}: level '{o['level']}' has no per-LA file")
        if o["at"] not in levels_cfg["levels"]:
            raise ConfigError(f"{where}: unknown level '{o['at']}' in at")
        if o["field"] not in fields[o["level"]]:
            raise ConfigError(f"{where}: '{o['level']}' has no field '{o['field']}'")


def validate_indicator(ind: dict[str, Any], metric_ids: set[str], levels: set[str]) -> None:
    where = f"explorer.yaml indicator '{ind.get('id')}'"

    def fail(msg: str) -> None:
        raise ConfigError(f"{where}: {msg}")

    def check_metric(metric_id: Any, role: str) -> None:
        if metric_id not in metric_ids:
            fail(f"{role} '{metric_id}' is not a metric id in config/metrics.yaml")

    if "label" not in ind:
        fail("missing label")
    if "metric" not in ind:
        fail("missing metric")
    check_metric(ind["metric"], "metric")
    for option in (ind.get("map") or {}).get("options", []):
        check_metric(option, "map option")
    bad_levels = [lv for lv in ind.get("levels", []) if lv not in levels]
    if bad_levels:
        fail(f"levels {bad_levels} are not metric levels {sorted(levels)}")
    validate_map(ind.get("map") or {}, fail)
    if not ind.get("panels"):
        fail("needs at least one panel")
    for n, panel in enumerate(ind["panels"], 1):
        validate_panel(panel, lambda msg: fail(f"panel {n}: {msg}"), check_metric)
    m = ind.get("map") or {}
    if m.get("selector") and not m.get("options") and not any(
            p["type"] in SERIES_PANELS for p in ind["panels"]):
        fail("map.selector needs a profile or composition panel to choose from")


def validate_map(m: dict[str, Any], fail) -> None:
    if m.get("scheme") not in KNOWN_RAMPS:
        fail(f"map.scheme '{m.get('scheme')}' is not a known ramp ({', '.join(KNOWN_RAMPS)})")
    if m.get("method", "quantile") not in MAP_METHODS:
        fail(f"map.method must be one of {MAP_METHODS}")
    if not isinstance(m.get("classes", 5), int) or m.get("classes", 5) < 2:
        fail("map.classes must be an integer >= 2")
    if m.get("selector") is not None and m["selector"] not in SELECTORS:
        fail(f"map.selector must be one of {SELECTORS}")


def validate_panel(p: dict[str, Any], fail, check_metric) -> None:
    if p.get("type") not in PANEL_TYPES:
        fail(f"type '{p.get('type')}' must be one of {PANEL_TYPES}")
    if "title" not in p:
        fail("missing title")
    lines = p.get("reference_lines")
    if not isinstance(lines, list):
        fail("reference_lines must be a list (use [] for none)")
    bad = [x for x in lines if x not in REFERENCE_LINES]
    if bad:
        fail(f"reference_lines {bad} must be from {REFERENCE_LINES}")
    if p["type"] == "ranked":
        if p.get("mark") not in MARKS:
            fail(f"mark '{p.get('mark')}' must be one of {MARKS}")
        if p.get("scale") not in SCALES:
            fail(f"scale '{p.get('scale')}' must be one of {SCALES}")
        if p["mark"] == "bar" and p["scale"] == "log":
            fail("a bar chart starts at zero, so it cannot use a log scale")
    if "group" in p and p["type"] != "breakdown":
        fail("only a breakdown panel can pick a category group")
    if p["type"] in SERIES_PANELS:
        if not p.get("series"):
            fail(f"a {p['type']} panel needs series")
        for s in p["series"]:
            check_metric(s, "series")


# --- visibility --------------------------------------------------------------

def expand_dataset_indicator(ind: dict[str, Any], ds: dict[str, Any]) -> dict[str, Any]:
    """A dataset indicator with its local ids (headline, panel series, map.options) turned
    into metric ids, and the Show dropdown's options listed (means first, then categories)."""
    defs = metric_defs(ds)
    local = {d["local"] for d in defs if d["kind"] != "count"} | {
        d["local"] + "__n" for d in defs if d["kind"] == "count"}

    def full(name: str) -> str:
        if name not in local:
            raise ConfigError(f"explorer.yaml indicator '{ind['id']}': '{name}' is not a metric of "
                              f"dataset '{ds['id']}' (has: {sorted(local)})")
        return full_id(ds["id"], name)

    if "headline" not in ind:
        raise ConfigError(f"explorer.yaml indicator '{ind['id']}': a dataset indicator needs a headline")
    out = {k: v for k, v in ind.items() if k != "headline"}
    out["metric"] = full(ind["headline"])
    out.setdefault("levels", list(DEFAULT_INDICATOR_LEVELS))
    out["map"] = {"scheme": ds["scheme"], "classes": 5, "method": "quantile", **(ind.get("map") or {})}
    if out["map"].get("selector"):
        explicit = out["map"].get("options")
        out["map"]["options"] = ([full(o) for o in explicit] if explicit
                                 else [d["id"] for d in defs if d["kind"] in OPTION_KINDS])
    groups = {c["group"] for c in ds["categories"] if c.get("group")}
    for p in ind["panels"]:
        if p.get("group") is not None and p["group"] not in groups:
            raise ConfigError(f"explorer.yaml indicator '{ind['id']}': panel group '{p['group']}' is not "
                              f"a category group of dataset '{ds['id']}' (has: {sorted(groups)})")
    out["panels"] = [{**p, **({"series": [full(s) for s in p["series"]]} if p.get("series") else {})}
                     for p in ind["panels"]]
    return out


def visible_config(cfg: dict[str, Any], datasets: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Expand ready dataset indicators; drop the rest (and then-empty categories)."""
    categories, hidden = [], []
    for category in cfg["categories"]:
        shown = []
        for ind in category["indicators"]:
            if "dataset" not in ind:
                shown.append(ind)
                continue
            ds = datasets.get(ind["dataset"])
            if ds and is_ready(ds):
                shown.append(expand_dataset_indicator(ind, ds))
                continue
            hidden.append(ind["id"])
            log.warning("explorer: hiding indicator %s (dataset %s is %s)", ind["id"], ind["dataset"],
                        ds.get("status", "draft") if ds else "missing")
        if shown:
            categories.append({**category, "indicators": shown})
    n = sum(len(c["indicators"]) for c in categories)
    log.info("explorer: %d categories, %d indicators shown, %d hidden",
             len(categories), n, len(hidden))
    return {**cfg, "categories": categories, "hidden_indicators": hidden}


# --- checks against the built metrics ---------------------------------------

def indicator_metric_ids(ind: dict[str, Any]) -> list[str]:
    """Every metric an indicator can map: its own, plus series when map.selector is on."""
    ids = [ind["metric"]]
    m = ind.get("map") or {}
    if m.get("selector"):
        ids += m.get("options") or [s for p in ind["panels"] for s in p.get("series", [])]
    return list(dict.fromkeys(ids))


def panel_metric_ids(ind: dict[str, Any], panel: dict[str, Any]) -> list[str]:
    return indicator_metric_ids(ind) if panel["type"] == "ranked" else list(panel["series"])


def reference_gaps(explorer: dict[str, Any], metrics: dict[str, Any], la_level: str) -> list[str]:
    """Values a chart needs that metrics.json lacks. Empty when every chart can draw.

    ranked panels need each metric at every indicator level; reference lines need the
    national value ('national') and a value for every council area ('la').
    """
    meta = {m["id"]: m for m in metrics["metrics"]}
    values = metrics["values"]
    gaps = []
    for category in explorer["categories"]:
        for ind in category["indicators"]:
            for panel in ind["panels"]:
                for mid in panel_metric_ids(ind, panel):
                    where = f"indicator '{ind['id']}' {panel['type']} panel, metric '{mid}'"
                    gaps += panel_gaps(ind, panel, mid, meta, values, la_level, where)
    return gaps


def panel_gaps(ind, panel, mid, meta, values, la_level, where) -> list[str]:
    if mid not in meta:
        return [f"{where}: not in metrics.json"]
    gaps = []
    needed_levels = ind.get("levels", []) if panel["type"] == "ranked" else []
    if "la" in panel["reference_lines"]:
        needed_levels = [*needed_levels, la_level]
    for lv in dict.fromkeys(needed_levels):
        column = values.get(lv, {}).get(mid)
        if column is None:
            gaps.append(f"{where}: no values for level '{lv}'")
        elif lv == la_level and "la" in panel["reference_lines"] and None in column:
            gaps.append(f"{where}: {column.count(None)} council areas have no value")
    if "national" in panel["reference_lines"] and meta[mid]["national"] is None:
        gaps.append(f"{where}: no national value")
    return gaps


def check_references(explorer: dict[str, Any], metrics: dict[str, Any], la_level: str) -> None:
    gaps = reference_gaps(explorer, metrics, la_level)
    if gaps:
        raise ConfigError("metrics.json is missing values the explorer charts need:\n  "
                          + "\n  ".join(gaps))
    log.info("explorer: every chart's values and reference values are in metrics.json")
