"""Census tables: OA-level CSVs -> metrics at every level (config/datasets/<id>.yaml).

OA is the only input level. Counts are summed up to each level by the OA's grouping field
(levels.yaml `census.groups`) and to Scotland, and only then turned into shares and means,
so a percentage is never an average of percentages. Adding a table is a YAML change.

Dataset YAML (see config/datasets/_template.yaml):
  categories   count columns (`column`), or derived ones: `of` (sum of other categories),
               `range` (sum of numeric-keyed columns with key in [lo, hi]) or `rest_of`
               (denominator minus the listed categories).
  universe     denominator for shares: the sum of the leaf categories (default; shares add up
               to 100) or `total_column`. Published OA counts are disclosure-controlled, so a
               row's categories do not add up to the table's total column exactly.
  means        weighted mean of the categories that carry a `value`.
  counts       categories also published as people/household counts.
  source.extra further OA tables joined on the OA code (e.g. the same table by age); their
               columns are named `<prefix>: <header>` and never count towards the denominator.
  group        on a category with a `parent`: a second way of splitting the parent (e.g. by
               age) beside its sub-types; the front end's `breakdown` panels pick one group.
  splits       shorthand for those grouped categories: parents x bands, read from a
               source.extra table or the table itself (see expand_splits). A grouped category
               never counts towards the denominator.
Each emitted category / mean / count becomes one metric `<dataset id>__<local id>`.
"""
from __future__ import annotations

import csv
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd
import yaml

from build.config import KNOWN_RAMPS, PROJECT_ROOT, ConfigError, resolve_path

log = logging.getLogger(__name__)

DATASETS_DIR = PROJECT_ROOT / "config" / "datasets"
SEP = "__"
DEN = "_den"
READY = "ready"
SOURCE = "dataset"                 # metrics.yaml `source` of metrics expanded from a dataset
DEFAULT_MIN_DENOMINATOR = 20
SHARE_DECIMALS, MEAN_DECIMALS = 1, 2
DERIVED_KEYS = ("of", "range", "rest_of")


def full_id(dataset_id: str, local: str) -> str:
    return f"{dataset_id}{SEP}{local}"


# --- config ------------------------------------------------------------------

def load_datasets(directory: Path | str | None = None) -> dict[str, dict[str, Any]]:
    """Every config/datasets/*.yaml except files starting with `_`, validated, by id."""
    out: dict[str, dict[str, Any]] = {}
    for path in sorted(Path(directory or DATASETS_DIR).glob("*.yaml")):
        if path.name.startswith("_"):
            continue
        with open(path, encoding="utf-8") as f:
            ds = yaml.safe_load(f) or {}
        if is_ready(ds):
            ds = expand_splits(ds, path.stem)
        validate_dataset(ds, path.stem)
        out[ds["id"]] = ds
    return out


def is_ready(ds: dict[str, Any]) -> bool:
    return ds.get("status", "draft") == READY


def expand_splits(ds: dict[str, Any], stem: str) -> dict[str, Any]:
    """`splits` written out as ordinary categories: one per parent and band, with `parent` and
    `group` set (what a breakdown panel shows), read from a source.extra table or, with no
    `prefix`, from the dataset's own table.

      splits:
        - group: age
          prefix: UV000b                      # a source.extra prefix (omit: the main table)
          column: "{header} - {band}"         # the table's header (after the prefix)
          bands: [{id: a16_24, header: "16 to 24", label: "aged 16 to 24", short: "16 to 24"}]
          parents: {cat_a: "Category A"}      # category id -> its {header} in that table

    Parents are top-level categories: the front end shows one level of sub-categories.
    """
    if not ds.get("splits"):
        return ds
    where = f"dataset '{stem}' splits"
    by_id = {c.get("id"): c for c in ds.get("categories", [])}
    prefixes = {e.get("prefix") for e in ds.get("source", {}).get("extra", [])}
    cats = list(ds.get("categories", []))
    for sp in ds["splits"]:
        missing = [k for k in ("group", "column", "bands", "parents") if k not in sp]
        if missing:
            raise ConfigError(f"{where}: missing {missing}")
        prefix = sp.get("prefix")
        if prefix is not None and prefix not in prefixes:
            raise ConfigError(f"{where}: prefix '{prefix}' is not a source.extra prefix {sorted(prefixes)}")
        if any(not {"id", "header"} <= set(b) for b in sp["bands"]):
            raise ConfigError(f"{where}: every band needs id and header")
        unknown = [p for p in sp["parents"] if p not in by_id]
        if unknown:
            raise ConfigError(f"{where}: parents {unknown} are not categories")
        nested = [p for p in sp["parents"] if by_id[p].get("parent")]
        if nested:
            raise ConfigError(f"{where}: parents {nested} are sub-categories; only top-level categories can be split")
        for parent, header in sp["parents"].items():
            parent_label = by_id[parent].get("label", parent)
            for b in sp["bands"]:
                column = sp["column"].format(header=header, band=b["header"])
                cats.append({"id": f"{parent}_{b['id']}",
                             "column": extra_column(prefix, column) if prefix else column,
                             "parent": parent, "group": sp["group"],
                             "label": f"{parent_label}, {b.get('label', b['header'])}",
                             "short": b.get("short", b["header"])})
    return {**ds, "categories": cats}


def validate_dataset(ds: dict[str, Any], stem: str) -> None:
    if ds.get("id") != stem:
        raise ConfigError(f"dataset file {stem}.yaml: id must equal the file name (got {ds.get('id')!r})")
    if not is_ready(ds):
        return  # drafts may hold TODOs; they are hidden and never read
    where = f"dataset '{stem}'"
    missing = [k for k in ("title", "table", "scheme", "source", "universe", "categories") if k not in ds]
    if missing:
        raise ConfigError(f"{where}: missing {missing}")
    if ds["scheme"] not in KNOWN_RAMPS:
        raise ConfigError(f"{where}: unknown scheme '{ds['scheme']}'")
    if not {"file", "citation"} <= set(ds["source"]):
        raise ConfigError(f"{where}: source needs file and citation")
    if any(not {"file", "prefix"} <= set(e) for e in ds["source"].get("extra", [])):
        raise ConfigError(f"{where}: every source.extra needs file and prefix")
    uni = ds["universe"]
    if "label" not in uni:
        raise ConfigError(f"{where}: universe needs a label")
    if uni.get("denominator", "leaves") not in ("leaves", "total_column"):
        raise ConfigError(f"{where}: universe.denominator must be leaves or total_column")
    if uni.get("denominator") == "total_column" and not uni.get("total_column"):
        raise ConfigError(f"{where}: universe.denominator total_column needs universe.total_column")
    validate_categories(ds, where)
    local = {c["id"] for c in ds["categories"]}
    for m in ds.get("means", []):
        if not {"id", "label"} <= set(m):
            raise ConfigError(f"{where}: every mean needs id and label")
        local.add(m["id"])
    unknown = [c for c in ds.get("counts", []) if c not in {c["id"] for c in ds["categories"]}]
    if unknown:
        raise ConfigError(f"{where}: counts name unknown categories {unknown}")
    if ds.get("means") and not any("value" in c for c in ds["categories"]) and not ds.get("numeric_columns"):
        raise ConfigError(f"{where}: means need categories with a value")
    if len(local) != len(ds["categories"]) + len(ds.get("means", [])):
        raise ConfigError(f"{where}: category and mean ids must be unique")


def validate_categories(ds: dict[str, Any], where: str) -> None:
    seen: list[str] = []
    every = [c.get("id") for c in ds["categories"]]
    for c in ds["categories"]:
        cid = c.get("id")
        if not cid or cid in seen:
            raise ConfigError(f"{where}: category ids must be present and unique (at {cid!r})")
        kinds = [k for k in ("column", *DERIVED_KEYS) if k in c]
        if len(kinds) != 1:
            raise ConfigError(f"{where} category '{cid}': needs exactly one of column, of, range, rest_of")
        refs = c.get("of", []) + c.get("rest_of", []) if kinds[0] in ("of", "rest_of") else []
        bad = [r for r in refs if r not in seen]
        if bad:
            raise ConfigError(f"{where} category '{cid}': {bad} must be declared before it")
        if c.get("parent") is not None and c["parent"] not in every:
            raise ConfigError(f"{where} category '{cid}': parent '{c['parent']}' is not a category")
        if c.get("group") is not None and c.get("parent") is None:
            raise ConfigError(f"{where} category '{cid}': a group needs a parent")
        seen.append(cid)


def metric_defs(ds: dict[str, Any]) -> list[dict[str, Any]]:
    """The metrics a ready dataset publishes, from YAML alone (means, shares, counts)."""
    ds_id = ds["id"]
    base = {"dataset": ds_id, "scheme": ds["scheme"], "source": SOURCE}
    defs = [{**base, "id": full_id(ds_id, m["id"]), "kind": "mean", "local": m["id"],
             "label": m["label"], "short": m.get("short", m["label"]), "unit": m.get("unit", ""),
             "decimals": m.get("decimals", MEAN_DECIMALS), "parent": None}
            for m in ds.get("means", [])]
    for c in ds["categories"]:
        if c.get("emit", True):
            defs.append({**base, "id": full_id(ds_id, c["id"]), "kind": "share", "local": c["id"],
                         "label": c.get("label", c["id"]), "short": c.get("short", c.get("label", c["id"])),
                         "unit": "%", "decimals": SHARE_DECIMALS,
                         "parent": full_id(ds_id, c["parent"]) if c.get("parent") else None,
                         "group": c.get("group")})
    by_id = {c["id"]: c for c in ds["categories"]}
    unit = ds["universe"].get("unit", "people")
    for cid in ds.get("counts", []):
        label = by_id[cid].get("label", cid)
        defs.append({**base, "id": full_id(ds_id, cid + SEP + "n"), "kind": "count", "local": cid,
                     "label": label, "short": by_id[cid].get("short", label),
                     "unit": unit, "decimals": 0, "parent": None})
    return defs


def with_dataset_metrics(metrics_cfg: dict[str, Any], datasets: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """metrics.yaml plus a stub for every metric of every ready dataset, so the explorer
    config can be validated before any CSV is read."""
    extra = [m for ds in datasets.values() if is_ready(ds) for m in metric_defs(ds)]
    return {**metrics_cfg, "metrics": [*metrics_cfg["metrics"], *extra]}


# --- reading -----------------------------------------------------------------

def is_header_line(line: str) -> bool:
    """A header row starts with a comma (no OA code) and names at least one column; a row of
    commas only is padding."""
    return line.startswith(",") and any(cell.strip() for cell in next(csv.reader([line])))


def read_table(path: Path) -> pd.DataFrame:
    """An OA-level table: index = OA code, one int column per CSV header.

    The header is the first line starting with a comma that names a column (title lines above
    it vary) and every such line directly after it (tables by a second and third variable);
    rows with another width (footnotes, blank lines) are skipped; `-` means zero.
    """
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    start = next((i for i, line in enumerate(lines) if is_header_line(line)), None)
    if start is None:
        raise ConfigError(f"{path.name}: no header row (a line starting with ',')")
    first = 1
    while start + first < len(lines) and is_header_line(lines[start + first]):
        first += 1
    rows = list(csv.reader(lines[start:]))
    header = combine_headers(*([h.strip() for h in row] for row in rows[:first]))
    dupes = sorted({h for h in header[1:] if header[1:].count(h) > 1})
    if dupes:
        raise ConfigError(f"{path.name}: column headers are not unique: {dupes[:5]}")
    # data rows have every cell filled; footnotes and padding rows (e.g. text then commas) do not
    body = [r for r in rows[first:] if len(r) == len(header) and all(cell.strip() for cell in r)]
    df = pd.DataFrame(body, columns=["code", *header[1:]]).set_index("code")
    df = df.apply(lambda col: col.str.strip().replace("-", "0"))
    numeric = df.apply(lambda col: col.str.fullmatch(r"\d+"))
    if not numeric.to_numpy().all():
        bad = sorted(set(df.to_numpy()[~numeric.to_numpy()]))
        raise ConfigError(f"{path.name}: non-numeric counts {bad[:5]}")
    log.info("%s: %d rows x %d columns (%d header rows, %d non-data lines skipped)", path.name, len(df),
             len(df.columns), first, len(rows) - first - len(body))
    return df.astype("int64")


def combine_headers(*rows: list[str]) -> list[str]:
    """Header rows (tables by a second variable, e.g. "by age", or by two, "by sex by age") as
    one: `<top> - <sub> - <sub>`. A sub-header that repeats the one above it or the table's
    universe (column 1) adds nothing: that column is the total of the header above."""
    universe = rows[0][1] if len(rows[0]) > 1 else ""
    out, above = list(rows[0]), rows[0]
    for sub in rows[1:]:
        out = [t if s in ("", a, universe) else f"{t} - {s}" for t, a, s in zip(out, above, sub)]
        above = sub
    return out


def extra_column(prefix: str, header: str) -> str:
    return f"{prefix}: {header}"


def read_source(ds: dict[str, Any]) -> pd.DataFrame:
    """A dataset's table: source.file joined with every source.extra table on the OA code."""
    table = read_table(resolve_path(ds["source"]["file"]))
    for extra in ds["source"].get("extra", []):
        more = read_table(resolve_path(extra["file"]))
        if set(more.index) != set(table.index):
            raise ConfigError(f"{ds['id']}: {extra['file']} has other OA codes than {ds['source']['file']}")
        more.columns = [extra_column(extra["prefix"], c) for c in more.columns]
        table = table.join(more)
    return table


def is_extra(ds: dict[str, Any], column: str) -> bool:
    return any(column.startswith(extra_column(e["prefix"], "")) for e in ds["source"].get("extra", []))


def resolve_categories(ds: dict[str, Any], columns: list[str]) -> list[dict[str, Any]]:
    """Declared categories plus, for `numeric_columns`, one hidden keyed category per
    numeric-looking CSV column (e.g. single years of age). `leaf`: in the denominator (a
    count column that is not a subtotal, not from an extra table and not a `group` split of
    another category)."""
    cats = [{"emit": True, "subtotal": False, **c} for c in ds["categories"]]
    for c in cats:
        c["leaf"] = ("column" in c and not c["subtotal"] and not c.get("group")
                     and not is_extra(ds, c["column"]))
    spec = ds.get("numeric_columns")
    if spec:
        aliases, offset = spec.get("aliases", {}), spec.get("offset", 0)
        declared = {c["column"] for c in cats if "column" in c}
        for col in columns:
            key = aliases.get(col, int(col) if col.isdigit() else None)
            if key is None or col in declared:
                continue
            cats.insert(0, {"id": f"{spec['prefix']}_{key}", "column": col, "key": key, "value": key + offset,
                            "emit": False, "subtotal": False, "leaf": True})
    return cats


def category_counts(ds: dict[str, Any], table: pd.DataFrame) -> pd.DataFrame:
    """Counts per category id (plus DEN, the shares' denominator) for every OA."""
    cats = resolve_categories(ds, list(table.columns))
    missing = [c["column"] for c in cats if "column" in c and c["column"] not in table.columns]
    if missing:
        raise ConfigError(f"dataset '{ds['id']}': columns {missing} not in the CSV; has {list(table.columns)}")
    out = pd.DataFrame({c["id"]: table[c["column"]] for c in cats if "column" in c})
    uni = ds["universe"]
    leaves = [c["id"] for c in cats if c["leaf"]]
    out[DEN] = table[uni["total_column"]] if uni.get("denominator") == "total_column" else out[leaves].sum(axis=1)
    for c in (c for c in cats if "column" not in c):
        if "of" in c:
            out[c["id"]] = out[c["of"]].sum(axis=1)
        elif "range" in c:
            lo, hi = c["range"]
            keyed = [k["id"] for k in cats if k.get("key") is not None and lo <= k["key"] <= hi]
            out[c["id"]] = out[keyed].sum(axis=1)
        else:
            out[c["id"]] = out[DEN] - out[c["rest_of"]].sum(axis=1)
    check_total(ds, table, out, leaves)
    return out


def check_total(ds: dict[str, Any], table: pd.DataFrame, counts: pd.DataFrame, leaves: list[str]) -> None:
    """Log how far leaf sums are from the table's own total (disclosure control moves counts)."""
    total_col = ds["universe"].get("total_column")
    if total_col and total_col in table.columns and ds["universe"].get("denominator") != "total_column":
        gap = counts[leaves].sum(axis=1) - table[total_col]
        log.info("%s: leaf sum vs '%s': OA gap %d..%d, Scotland %d vs %d", ds["id"], total_col,
                 gap.min(), gap.max(), counts[leaves].to_numpy().sum(), table[total_col].sum())


# --- aggregation -------------------------------------------------------------

def aggregate(counts: pd.DataFrame, oa: pd.DataFrame, groups: dict[str, str]) -> dict[str, pd.DataFrame]:
    """Sum OA counts by each level's grouping field. OAs with no value for a field are left
    out of that level only (they still count towards the others and Scotland)."""
    by_code = oa.set_index("code")
    out = {}
    for level, field_name in groups.items():
        key = by_code[field_name].reindex(counts.index)
        out[level] = counts.groupby(key.astype(object)).sum()
        left_out = int(key.isna().sum())
        if left_out:
            log.info("  %s: %d OAs have no %s and count towards no %s", level, left_out, field_name, level)
    return out


# --- measures ----------------------------------------------------------------

def evaluate(defn: dict[str, Any], ds: dict[str, Any], cats: dict[str, dict[str, Any]],
             counts: pd.DataFrame) -> pd.Series:
    """One metric over rows of summed counts; NaN where the denominator is too small."""
    floor = ds["universe"].get("min_denominator", DEFAULT_MIN_DENOMINATOR)
    if defn["kind"] == "count":
        return counts[defn["local"]].astype("float64")
    if defn["kind"] == "share":
        den = counts[DEN].astype("float64")
        return (counts[defn["local"]] / den.where(den >= max(floor, 1)) * 100).round(defn["decimals"])
    mean_spec = next(m for m in ds["means"] if m["id"] == defn["local"])
    ids = mean_spec.get("include") or [i for i, c in cats.items() if c.get("value") is not None]
    weights = counts[ids].astype("float64")
    total = weights.sum(axis=1)
    weighted = sum(weights[i] * float(cats[i]["value"]) for i in ids)
    return (weighted / total.where(total >= max(floor, 1))).round(defn["decimals"])


@dataclass
class CensusMetrics:
    """metrics.json values: per level {metric id: list aligned to the level's codes}, the
    Scotland value of each metric, and per-LA OA values for export."""
    values: dict[str, dict[str, list]] = field(default_factory=dict)
    national: dict[str, float | None] = field(default_factory=dict)
    oa: pd.DataFrame = field(default_factory=pd.DataFrame)   # index OA code, columns metric ids
    datasets: dict[str, dict[str, Any]] = field(default_factory=dict)
    levels: list[str] = field(default_factory=list)
    metric_dataset: dict[str, str] = field(default_factory=dict)   # metric id -> dataset id


def jsonable(series: pd.Series) -> list:
    values = series.to_numpy(dtype="float64", na_value=float("nan")).tolist()
    return [None if v != v else (int(v) if v.is_integer() else v) for v in values]   # v != v: NaN


def build_census_metrics(levels: dict[str, pd.DataFrame], oa: pd.DataFrame, datasets: dict[str, dict[str, Any]],
                         census_cfg: dict[str, Any]) -> CensusMetrics:
    """Read every ready dataset and compute its metrics at each level, Scotland and OA."""
    groups = {lv: f for lv, f in census_cfg["groups"].items() if lv in levels}
    res = CensusMetrics(values={lv: {} for lv in groups}, levels=list(groups))
    oa_cols: dict[str, pd.Series] = {}
    oa_codes = set(oa["code"])
    for ds in (d for d in datasets.values() if is_ready(d)):
        table = read_source(ds)
        unknown, absent = set(table.index) - oa_codes, oa_codes - set(table.index)
        if unknown or absent:
            raise ConfigError(f"{ds['id']}: {len(unknown)} CSV codes not in the OA layer, "
                              f"{len(absent)} OAs missing from the CSV")
        counts = category_counts(ds, table)
        per_level = aggregate(counts, oa, groups)
        national = counts.sum().to_frame().T
        cats = {c["id"]: c for c in resolve_categories(ds, list(table.columns))}
        defs = metric_defs(ds)
        for d in defs:
            for lv, summed in per_level.items():
                res.values[lv][d["id"]] = jsonable(evaluate(d, ds, cats, summed).reindex(levels[lv]["code"]))
            nat = evaluate(d, ds, cats, national).iloc[0]
            res.national[d["id"]] = None if pd.isna(nat) else float(nat)
            oa_cols[d["id"]] = evaluate(d, ds, cats, counts)
            res.metric_dataset[d["id"]] = ds["id"]
        res.datasets[ds["id"]] = {"title": ds["title"], "table": ds["table"], "universe": ds["universe"]["label"],
                                  "citation": ds["source"]["citation"], "note": ds.get("note")}
        log.info("%s: %d metrics at %s, Scotland %d people/households, in %d OAs", ds["id"], len(defs),
                 list(per_level), int(national[DEN].iloc[0]), len(table))
    res.oa = pd.DataFrame(oa_cols)
    return res


def oa_values_by_la(res: CensusMetrics, oa: pd.DataFrame) -> dict[str, dict[str, dict[str, list]]]:
    """Columnar {codes, <metric id>: [...]} per council area and dataset, for the lazily loaded
    OA layer: {la code: {dataset id: columns}}."""
    if res.oa.empty:
        return {}
    frame = res.oa.reindex(oa["code"])
    by_dataset: dict[str, list[str]] = {}
    for column in frame.columns:
        by_dataset.setdefault(res.metric_dataset[column], []).append(column)
    out = {}
    for la, rows in oa.groupby("parent_code").indices.items():
        sub = frame.iloc[rows]
        codes = sub.index.tolist()
        out[la] = {ds: {"codes": codes, **{c: jsonable(sub[c]) for c in columns}}
                   for ds, columns in by_dataset.items()}
    return out
