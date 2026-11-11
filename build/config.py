"""Load and validate config/*.yaml."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LEVELS_PATH = PROJECT_ROOT / "config" / "levels.yaml"

COMMON_FIELDS = ("code", "name", "pop", "households", "parent_code", "area_km2")
REQUIRED_FIELDS = ("code", "name")
PARENT_JOIN_METHODS = ("representative_point",)
LA_GEOMETRY_SOURCES = ("dissolve_oa", "file")
SIMPLIFY_ENGINES = ("mapshaper", "shapely")
# d3-scale-chromatic sequential schemes (scheme<Name>[k]) the front end can draw.
KNOWN_RAMPS = ("Blues", "Greens", "Greys", "Oranges", "Purples", "Reds",
               "BuGn", "BuPu", "GnBu", "OrRd", "PuBuGn", "PuBu", "PuRd", "RdPu",
               "YlGnBu", "YlGn", "YlOrBr", "YlOrRd")


class ConfigError(ValueError):
    pass


def load_levels_config(path: Path = LEVELS_PATH) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    validate_levels_config(cfg)
    return cfg


def validate_levels_config(cfg: dict[str, Any]) -> None:
    for key in ("source_crs", "output_crs", "levels"):
        if key not in cfg:
            raise ConfigError(f"levels config missing '{key}'")
    for level, spec in cfg["levels"].items():
        if "derived" in spec:
            validate_derived(level, spec["derived"], cfg)
            continue
        if "path" not in spec or "fields" not in spec:
            raise ConfigError(f"level '{level}' needs 'path' and 'fields'")
        missing = [f for f in COMMON_FIELDS if f not in spec["fields"]]
        if missing:
            raise ConfigError(f"level '{level}' fields missing keys: {missing}")
        empty = [f for f in REQUIRED_FIELDS if not spec["fields"][f]]
        if empty:
            raise ConfigError(f"level '{level}' must map {empty} to a source column")
        join = spec.get("parent_join")
        if join is not None and join not in PARENT_JOIN_METHODS:
            raise ConfigError(f"level '{level}' parent_join must be one of {PARENT_JOIN_METHODS}")
    if "assign" in cfg:
        validate_assign_config(cfg["assign"], set(cfg["levels"]))
    if "simplify" in cfg:
        validate_simplify_config(cfg)
    if "export" in cfg:
        validate_export_config(cfg["export"], set(cfg["levels"]))


def is_derived(spec: dict[str, Any]) -> bool:
    return "derived" in spec


def assigned_fields(cfg: dict[str, Any]) -> dict[str, set[str]]:
    """Fields assign.py adds to each level, beyond the common schema."""
    a = cfg.get("assign", {})
    out: dict[str, set[str]] = {}
    for lv in a.get("locality_targets", []):
        out.setdefault(lv, set()).add(a["locality_field"])
    for rule in a.get("lookup_fields", []):
        out.setdefault(rule["level"], set()).update(rule["fields"])
    for rule in a.get("point_fields", []):
        out.setdefault(rule["level"], set()).update([rule["link_field"], *rule["fields"]])
    for rule in a.get("area_fields", []):
        out.setdefault(rule["level"], set()).add(rule["link_field"])
    for rule in a.get("neighbours", []):
        out.setdefault(rule["level"], set()).add(rule["field"])
    return out


def validate_derived(level: str, d: dict[str, Any], cfg: dict[str, Any]) -> None:
    missing = [k for k in ("from", "group_field", "names") if k not in d]
    if missing:
        raise ConfigError(f"derived level '{level}' needs {missing}")
    if d["from"] not in cfg["levels"] or is_derived(cfg["levels"][d["from"]]):
        raise ConfigError(f"derived level '{level}': from '{d['from']}' must be a file-backed level")
    if d["group_field"] not in assigned_fields(cfg).get(d["from"], set()):
        raise ConfigError(f"derived level '{level}': group_field '{d['group_field']}' is not "
                          f"assigned to '{d['from']}' (see assign.lookup_fields / point_fields)")
    if not {"path", "code", "name"} <= set(d["names"]):
        raise ConfigError(f"derived level '{level}': names needs path, code and name")


def validate_assign_config(assign: dict[str, Any], levels: set[str]) -> None:
    if assign.get("la_geometry", "dissolve_oa") not in LA_GEOMETRY_SOURCES:
        raise ConfigError(f"assign.la_geometry must be one of {LA_GEOMETRY_SOURCES}")
    named = [assign[k] for k in ("la_level", "dissolve_level", "locality_level")]
    unknown = [lv for lv in [*named, *assign["locality_targets"]] if lv not in levels]
    for rule in assign.get("lookup_fields", []):
        if not {"level", "path", "key", "fields"} <= set(rule):
            raise ConfigError("assign.lookup_fields entries need level, path, key and fields")
        unknown += [rule["level"]] if rule["level"] not in levels else []
    for rule in assign.get("point_fields", []):
        if not {"level", "from", "link_field", "fields"} <= set(rule):
            raise ConfigError("assign.point_fields entries need level, from, link_field and fields")
        unknown += [lv for lv in (rule["level"], rule["from"]) if lv not in levels]
    for rule in assign.get("area_fields", []):
        if not {"level", "from", "link_field"} <= set(rule):
            raise ConfigError("assign.area_fields entries need level, from and link_field")
        unknown += [lv for lv in (rule["level"], rule["from"]) if lv not in levels]
    for rule in assign.get("neighbours", []):
        if not {"level", "field"} <= set(rule):
            raise ConfigError("assign.neighbours entries need level and field")
        unknown += [rule["level"]] if rule["level"] not in levels else []
    if unknown:
        raise ConfigError(f"assign refers to unknown levels: {unknown}")


def resolve_path(path: str | Path) -> Path:
    p = Path(path)
    return p if p.is_absolute() else PROJECT_ROOT / p


def validate_simplify_config(cfg: dict[str, Any]) -> None:
    if cfg["simplify"].get("engine") not in SIMPLIFY_ENGINES:
        raise ConfigError(f"simplify.engine must be one of {SIMPLIFY_ENGINES}")
    for level, spec in cfg["levels"].items():
        tol = spec.get("simplify_m")
        if not isinstance(tol, (int, float)) or tol < 0:
            raise ConfigError(f"level '{level}' needs simplify_m >= 0 (metres)")


def validate_export_config(export: dict[str, Any], levels: set[str]) -> None:
    named = [*export["per_la_levels"], *export["index_levels"], *export["per_la_index_levels"],
             *export.get("national_levels", [])]
    unknown = [lv for lv in named if lv not in levels]
    if unknown:
        raise ConfigError(f"export refers to unknown levels: {unknown}")
    if "{level}" not in export["per_la_path"] or "{la_code}" not in export["per_la_path"]:
        raise ConfigError("export.per_la_path must contain {level} and {la_code}")
    if export.get("national_levels") and "{level}" not in export.get("national_path", ""):
        raise ConfigError("export.national_path must contain {level}")
    if "{la_code}" not in export["per_la_index_path"]:
        raise ConfigError("export.per_la_index_path must contain {la_code}")
    for key, needs in (("dataset_values_path", ("{level}", "{dataset}")),
                       ("oa_values_path", ("{la_code}", "{dataset}"))):
        if export.get(key) and not all(p in export[key] for p in needs):
            raise ConfigError(f"export.{key} must contain {' and '.join(needs)}")
    both = set(export["index_levels"]) & set(export["per_la_index_levels"])
    if both:
        raise ConfigError(f"levels in both index_levels and per_la_index_levels: {sorted(both)}")
