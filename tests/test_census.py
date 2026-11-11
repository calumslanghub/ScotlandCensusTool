from __future__ import annotations

import pandas as pd
import pytest

from build import census
from build.config import ConfigError, resolve_path

CSV = """Scotland's Census 2022 - National Records of Scotland
Table UV999 - Example
All people

,"All people","Young","Old","Total old and young","Group, with comma"
"S001",10,4,6,10,3
"S002",20,-,20,20,-
"S003",8,1,1,2,-
To find out more about disclosure control, see the website,,,,,
,,,,,
"""


def write_csv(tmp_path, text: str = CSV):
    path = tmp_path / "t.csv"
    path.write_text(text, encoding="utf-8")
    return path


def dataset(**over) -> dict:
    ds = {
        "id": "uv999_example", "status": "ready", "table": "UV999", "title": "Example", "scheme": "Blues",
        "source": {"file": "x.csv", "citation": "c"},
        "universe": {"label": "All people", "total_column": "All people"},
        "categories": [
            {"id": "young", "column": "Young", "value": 10},
            {"id": "old", "column": "Old", "value": 70},
            {"id": "everyone", "column": "Total old and young", "subtotal": True},
            {"id": "not_old", "rest_of": ["old"]},
        ],
        "means": [{"id": "mean_age", "label": "Mean age", "unit": "years"}],
    }
    return {**ds, **over}


# --- reading ----------------------------------------------------------------

def test_read_table_finds_header_skips_footers_and_reads_dash_as_zero(tmp_path):
    t = census.read_table(write_csv(tmp_path))
    assert list(t.index) == ["S001", "S002", "S003"]
    assert list(t.columns) == ["All people", "Young", "Old", "Total old and young", "Group, with comma"]
    assert t.loc["S002", "Young"] == 0 and t.loc["S002", "Old"] == 20
    assert t.dtypes.eq("int64").all()


def test_read_table_strips_header_whitespace(tmp_path):
    t = census.read_table(write_csv(tmp_path, CSV.replace('"Young"', '"\tYoung "')))
    assert "Young" in t.columns


def test_read_table_rejects_other_symbols(tmp_path):
    with pytest.raises(ConfigError, match="non-numeric"):
        census.read_table(write_csv(tmp_path, CSV.replace('"S001",10,4,6,10,3', '"S001",10,*,6,10,3')))


TWO_ROW = """Table UV999b - Example by age
All people

,"All people","All people","All people","Walk","Walk","Walk"
,"All people","16 to 24","25 and over","All people","16 to 24","25 and over"
"S001",10,4,6,3,1,2
"S002",20,5,15,8,2,6
"S003",8,1,7,1,-,1
Crown copyright,,,,,,
"""


def test_read_table_combines_two_header_rows(tmp_path):
    t = census.read_table(write_csv(tmp_path, TWO_ROW))
    assert list(t.columns) == ["All people", "All people - 16 to 24", "All people - 25 and over",
                               "Walk", "Walk - 16 to 24", "Walk - 25 and over"]
    assert list(t.index) == ["S001", "S002", "S003"] and t.loc["S003", "Walk - 16 to 24"] == 0


THREE_ROW = """Table UV999b - Example by sex by age
All people

,"All people","All people","All people","All people","Walk","Walk","Walk","Walk"
,"All people","All people","Female","Female","All people","All people","Female","Female"
,"Total","16 to 24","Total","16 to 24","Total","16 to 24","Total","16 to 24"
"S001",10,4,6,2,3,1,2,1
"S002",20,5,15,3,8,2,6,-
"""


def test_read_table_combines_three_header_rows(tmp_path):
    t = census.read_table(write_csv(tmp_path, THREE_ROW))
    assert list(t.columns) == ["All people - Total", "All people - 16 to 24", "All people - Female - Total",
                               "All people - Female - 16 to 24", "Walk - Total", "Walk - 16 to 24",
                               "Walk - Female - Total", "Walk - Female - 16 to 24"]
    assert t.loc["S002", "Walk - Female - 16 to 24"] == 0


def test_read_table_skips_a_blank_header_row_and_reads_unquoted_padded_files(tmp_path):
    text = ("Table UV999b - Example,,,,\nAll people,,,,\n,,,,\n,All people,All people,Walk,Walk\n"
            ",All people,16 to 24,All people,16 to 24\nS001,10,4,3,1\nS002,20,5,8,-\nCrown copyright,,,,\n")
    t = census.read_table(write_csv(tmp_path, text))
    assert list(t.columns) == ["All people", "All people - 16 to 24", "Walk", "Walk - 16 to 24"]
    assert list(t.index) == ["S001", "S002"]


def test_read_table_rejects_duplicate_headers(tmp_path):
    with pytest.raises(ConfigError, match="not unique.*Young"):
        census.read_table(write_csv(tmp_path, CSV.replace('"Old"', '"Young"')))


def test_table_headers_prints_a_categories_skeleton(tmp_path):
    from build.table_headers import skeleton
    out = skeleton(write_csv(tmp_path))
    assert out.startswith("# Scotland's Census 2022 - National Records of Scotland\n# Table UV999 - Example")
    assert "# 3 output areas, 5 columns" in out
    assert 'universe: {label: "All people", total_column: "All people"}' in out
    assert '  - {id: group_with_comma, column: "Group, with comma", label: "Group, with comma"}' in out


# --- splits ---------------------------------------------------------------------

def split_dataset(**split_over) -> dict:
    split = {"group": "age", "prefix": "B", "column": "{header} - {band}",
             "bands": [{"id": "a16_24", "header": "16 to 24", "label": "aged 16 to 24"},
                       {"id": "a25p", "header": "25 and over", "short": "25+"}],
             "parents": {"old": "Walk"}}
    return dataset(source={"file": "x.csv", "citation": "c", "extra": [{"file": "b.csv", "prefix": "B"}]},
                   categories=[{"id": "young", "column": "Young"}, {"id": "old", "column": "Old", "label": "Old people"}],
                   means=[], splits=[{**split, **split_over}])


def test_splits_expand_to_grouped_categories():
    ds = census.expand_splits(split_dataset(), "uv999_example")
    census.validate_dataset(ds, "uv999_example")
    added = ds["categories"][2:]
    assert added == [
        {"id": "old_a16_24", "column": "B: Walk - 16 to 24", "parent": "old", "group": "age",
         "label": "Old people, aged 16 to 24", "short": "16 to 24"},
        {"id": "old_a25p", "column": "B: Walk - 25 and over", "parent": "old", "group": "age",
         "label": "Old people, 25 and over", "short": "25+"}]
    defs = {d["local"]: d for d in census.metric_defs(ds)}
    assert defs["old_a25p"]["parent"] == "uv999_example__old" and defs["old_a25p"]["group"] == "age"


def test_split_columns_are_read_from_the_extra_table(tmp_path):
    main, extra = tmp_path / "main.csv", tmp_path / "extra.csv"
    main.write_text(CSV, encoding="utf-8")
    extra.write_text(TWO_ROW, encoding="utf-8")
    ds = split_dataset()
    ds["source"] = {"file": str(main), "citation": "c", "extra": [{"file": str(extra), "prefix": "B"}]}
    ds = census.expand_splits(ds, "uv999_example")
    counts = census.category_counts(ds, census.read_source(ds))
    assert counts["old_a25p"].tolist() == [2, 6, 1]
    assert counts[census.DEN].tolist() == [10, 20, 2]                # the split is never in the denominator


def test_split_of_the_main_table_needs_no_prefix_and_stays_out_of_the_denominator(tmp_path):
    ds = dataset(categories=[{"id": "young", "column": "Young"}, {"id": "old", "column": "Old"}], means=[],
                 splits=[{"group": "kind", "column": "{band}", "parents": {"old": "Old"},
                          "bands": [{"id": "comma", "header": "Group, with comma"}]}])
    ds = census.expand_splits(ds, "uv999_example")
    assert ds["categories"][-1]["column"] == "Group, with comma"
    counts = census.category_counts(ds, table(tmp_path))
    assert counts["old_comma"].tolist() == [3, 0, 0]
    assert counts[census.DEN].tolist() == [10, 20, 2]                # young + old only


@pytest.mark.parametrize("mutate, message", [
    (lambda sp: sp.update(prefix="Z"), r"prefix 'Z' is not a source.extra prefix"),
    (lambda sp: sp.update(parents={"nope": "Walk"}), r"parents \['nope'\] are not categories"),
    (lambda sp: sp.update(bands=[{"id": "a"}]), r"every band needs id and header"),
    (lambda sp: sp.pop("column"), r"missing \['column'\]"),
])
def test_invalid_splits(mutate, message):
    ds = split_dataset()
    mutate(ds["splits"][0])
    with pytest.raises(ConfigError, match=message):
        census.expand_splits(ds, "uv999_example")


def test_only_top_level_categories_can_be_split():
    ds = split_dataset()
    ds["categories"][1]["parent"] = "young"
    with pytest.raises(ConfigError, match=r"\['old'\] are sub-categories"):
        census.expand_splits(ds, "uv999_example")


def test_extra_source_is_joined_and_never_in_the_denominator(tmp_path):
    main, extra = tmp_path / "main.csv", tmp_path / "extra.csv"
    main.write_text(CSV, encoding="utf-8")
    extra.write_text(TWO_ROW, encoding="utf-8")
    ds = dataset(source={"file": str(main), "citation": "c", "extra": [{"file": str(extra), "prefix": "B"}]},
                 categories=[{"id": "young", "column": "Young"}, {"id": "old", "column": "Old"},
                             {"id": "old_walk", "column": "B: Walk - 25 and over", "parent": "old", "group": "age"}],
                 means=[])
    t = census.read_source(ds)
    counts = census.category_counts(ds, t)
    assert counts["old_walk"].tolist() == [2, 6, 1]
    assert counts[census.DEN].tolist() == [10, 20, 2]                # young + old only
    defs = {d["local"]: d for d in census.metric_defs(ds)}
    assert defs["old_walk"]["group"] == "age" and defs["old"]["group"] is None


def test_extra_source_must_cover_the_same_output_areas(tmp_path):
    main, extra = tmp_path / "main.csv", tmp_path / "extra.csv"
    main.write_text(CSV, encoding="utf-8")
    extra.write_text(TWO_ROW.replace('"S003",8,1,7,1,-,1\n', ""), encoding="utf-8")
    ds = dataset(source={"file": str(main), "citation": "c", "extra": [{"file": str(extra), "prefix": "B"}]})
    with pytest.raises(ConfigError, match="other OA codes"):
        census.read_source(ds)


def test_read_table_needs_a_header(tmp_path):
    with pytest.raises(ConfigError, match="no header row"):
        census.read_table(write_csv(tmp_path, "just text\n1,2,3\n"))


# --- counts, denominators, derived categories ----------------------------------

def table(tmp_path):
    return census.read_table(write_csv(tmp_path))


def test_denominator_is_leaf_sum_and_subtotals_are_excluded(tmp_path):
    counts = census.category_counts(dataset(), table(tmp_path))
    assert counts[census.DEN].tolist() == [10, 20, 2]            # young + old, not the total columns
    assert counts["not_old"].tolist() == [4, 0, 1]               # rest_of: denominator - old


def test_total_column_denominator(tmp_path):
    ds = dataset(universe={"label": "x", "total_column": "All people", "denominator": "total_column"})
    assert census.category_counts(ds, table(tmp_path))[census.DEN].tolist() == [10, 20, 8]


def test_unknown_column_names_dataset(tmp_path):
    ds = dataset()
    ds["categories"][0]["column"] = "Youngg"
    with pytest.raises(ConfigError, match="uv999_example.*Youngg"):
        census.category_counts(ds, table(tmp_path))


def test_numeric_columns_and_range(tmp_path):
    text = ',"All people","Under 1","1","2","3"\n"S001",9,1,2,3,3\n'
    ds = dataset(universe={"label": "x", "total_column": "All people", "min_denominator": 1},
                 numeric_columns={"prefix": "age", "offset": 0.5, "aliases": {"Under 1": 0}},
                 categories=[{"id": "young", "range": [0, 1]}, {"id": "older", "range": [2, 9]}],
                 means=[{"id": "mean_age", "label": "Mean age"}])
    counts = census.category_counts(ds, census.read_table(write_csv(tmp_path, text)))
    assert counts.loc["S001", ["young", "older"]].tolist() == [3, 6]
    cats = {c["id"]: c for c in census.resolve_categories(ds, ["All people", "Under 1", "1", "2", "3"])}
    d = census.metric_defs(ds)[0]
    # (0.5*1 + 1.5*2 + 2.5*3 + 3.5*3) / 9
    assert census.evaluate(d, ds, cats, counts).iloc[0] == pytest.approx(2.39, abs=0.005)


# --- measures -------------------------------------------------------------------

def evaluated(tmp_path, ds=None):
    ds = ds or dataset()
    t = table(tmp_path)
    counts = census.category_counts(ds, t)
    cats = {c["id"]: c for c in census.resolve_categories(ds, list(t.columns))}
    return {d["local"]: (d, census.evaluate(d, ds, cats, counts)) for d in census.metric_defs(ds)}, counts, ds, cats


def test_share_and_mean(tmp_path):
    out, *_ = evaluated(tmp_path, dataset(universe={"label": "x", "total_column": "All people", "min_denominator": 1}))
    assert out["old"][1].tolist() == [60.0, 100.0, 50.0]
    assert out["mean_age"][1].tolist() == [46.0, 70.0, 40.0]      # (10*young + 70*old) / (young + old)


def test_small_denominators_are_missing_not_zero(tmp_path):
    out, *_ = evaluated(tmp_path)                                   # default floor of 20 people
    assert out["old"][1].isna().tolist() == [True, False, True]
    assert out["mean_age"][1].isna().tolist() == [True, False, True]


def test_count_metric(tmp_path):
    ds = dataset(counts=["old"])
    t = table(tmp_path)
    counts = census.category_counts(ds, t)
    cats = {c["id"]: c for c in census.resolve_categories(ds, list(t.columns))}
    defn = next(d for d in census.metric_defs(ds) if d["id"] == "uv999_example__old__n")
    assert defn["kind"] == "count" and defn["unit"] == "people"
    assert census.evaluate(defn, ds, cats, counts).tolist() == [6, 20, 1]


def test_metric_ids_and_parents():
    ds = dataset(categories=[{"id": "a", "column": "Young", "subtotal": True},
                             {"id": "b", "column": "Old", "parent": "a"}])
    defs = {d["local"]: d for d in census.metric_defs(ds)}
    assert defs["b"]["id"] == "uv999_example__b"
    assert defs["b"]["parent"] == "uv999_example__a" and defs["a"]["parent"] is None
    assert defs["mean_age"]["kind"] == "mean"


# --- aggregation: sums first, then measures ------------------------------------------

def test_aggregate_sums_counts_and_leaves_ungrouped_oas_out_of_that_level_only(tmp_path):
    counts = census.category_counts(dataset(), table(tmp_path))
    oa = pd.DataFrame({"code": ["S001", "S002", "S003"], "parent_code": ["A", "A", "B"],
                       "locality_code": ["L1", None, None]})
    out = census.aggregate(counts, oa, {"la": "parent_code", "locality": "locality_code"})
    assert out["la"].loc["A", "old"] == 26 and out["la"].loc["B", "old"] == 1
    assert list(out["locality"].index) == ["L1"]
    assert out["la"].sum().equals(counts.sum())                     # conservation: nothing lost at LA level
    assert out["locality"].loc["L1", "old"] < counts["old"].sum()   # S002 and S003 are in no locality


def test_percentages_are_computed_after_summing(tmp_path):
    ds = dataset(universe={"label": "x", "total_column": "All people", "min_denominator": 1})
    out, counts, _, cats = evaluated(tmp_path, ds)
    oa = pd.DataFrame({"code": ["S001", "S002", "S003"], "parent_code": ["A", "A", "A"]})
    summed = census.aggregate(counts, oa, {"la": "parent_code"})["la"]
    share = census.evaluate(out["old"][0], ds, cats, summed).iloc[0]
    assert share == pytest.approx(100 * 27 / 32, abs=0.05)          # not the mean of 60, 100, 50


def test_oa_values_by_la_are_columnar_and_complete():
    res = census.CensusMetrics(
        oa=pd.DataFrame({"t__m": [1.0, None, 3.0], "u__n": [0.5, 2.0, None]}, index=["S1", "S2", "S3"]),
        metric_dataset={"t__m": "t", "u__n": "u"})
    oa = pd.DataFrame({"code": ["S1", "S2", "S3"], "parent_code": ["A", "B", "A"]})
    out = census.oa_values_by_la(res, oa)
    assert out["A"] == {"t": {"codes": ["S1", "S3"], "t__m": [1, 3]},      # one table per dataset
                        "u": {"codes": ["S1", "S3"], "u__n": [0.5, None]}}
    assert out["B"]["t"] == {"codes": ["S2"], "t__m": [None]}


# --- config validation ------------------------------------------------------------------

@pytest.mark.parametrize("mutate, message", [
    (lambda d: d["categories"][0].update(parent="nope"), r"parent 'nope'"),
    (lambda d: d["categories"][3].update(rest_of=["later"]), r"\['later'\] must be declared"),
    (lambda d: d["categories"][0].update(of=["old"]), r"exactly one of"),
    (lambda d: d["categories"].append({"id": "young", "column": "Young"}), r"unique"),
    (lambda d: d.update(scheme="Rainbow"), r"unknown scheme"),
    (lambda d: d["universe"].update(denominator="total_column", total_column=None), r"total_column"),
    (lambda d: d.update(counts=["nope"]), r"counts name unknown categories"),
    (lambda d: d["categories"][0].update(group="age"), r"a group needs a parent"),
    (lambda d: d["source"].update(extra=[{"file": "b.csv"}]), r"source.extra needs file and prefix"),
])
def test_invalid_dataset_config(mutate, message):
    ds = dataset()
    mutate(ds)
    with pytest.raises(ConfigError, match=message):
        census.validate_dataset(ds, "uv999_example")


def test_dataset_id_must_match_file_name():
    with pytest.raises(ConfigError, match="id must equal the file name"):
        census.validate_dataset(dataset(), "other_name")


def test_drafts_are_not_validated_beyond_their_id():
    census.validate_dataset({"id": "uv000", "status": "draft", "categories": "TODO"}, "uv000")


# --- the real tables ------------------------------------------------------------------------

READY = {k: d for k, d in census.load_datasets().items() if census.is_ready(d)}


def test_every_requested_table_is_ready():
    """Every published Output Area table except UV608, whose file is a truncated download."""
    assert len(READY) == 52
    assert not census.is_ready(census.load_datasets()["uv608_ns_sec_hrp"])


def test_every_raw_table_belongs_to_a_dataset():
    folder = resolve_path("data/raw/Census/Census2022OutputAreaUV")
    if not folder.exists():
        pytest.skip("raw tables not present")
    used = {resolve_path(f["file"]).name for ds in census.load_datasets().values()
            for f in [ds["source"], *ds["source"].get("extra", [])]}
    assert sorted(p.name for p in folder.glob("*.csv") if p.name not in used) == []


@pytest.mark.parametrize("dataset_id", sorted(READY))
def test_real_table_reads_and_shares_are_sane(dataset_id):
    ds = READY[dataset_id]
    paths = [resolve_path(f["file"]) for f in [ds["source"], *ds["source"].get("extra", [])]]
    if not all(p.exists() for p in paths):
        pytest.skip(f"{', '.join(p.name for p in paths)} not all present")
    t = census.read_source(ds)
    assert len(t) == 46363 and not t.index.duplicated().any()
    counts = census.category_counts(ds, t)
    cats = {c["id"]: c for c in census.resolve_categories(ds, list(t.columns))}
    # a few OAs have nobody in a narrow universe (4 have no one in employment, 160 of 46,363
    # no one studying): kept, shown as no data
    assert (counts[census.DEN] == 0).mean() < 0.005
    national = counts.sum().to_frame().T
    for d in census.metric_defs(ds):
        value = census.evaluate(d, ds, cats, national).iloc[0]
        assert pd.notna(value), d["id"]
        if d["kind"] == "share":
            assert 0 <= value <= 100, d["id"]
    if ds["universe"].get("denominator", "leaves") == "leaves":
        # exclusive tables whose leaves are all published: leaf shares add up to 100 (rounding
        # aside). Tables that publish groups of hidden raw columns instead (uv601) are left out.
        leaves = [i for i, c in cats.items() if c["leaf"] and c.get("emit", True)]
        every_leaf_emitted = all(c.get("emit", True) for c in cats.values() if c["leaf"])
        if leaves and not ds.get("numeric_columns") and every_leaf_emitted:
            total = sum(census.evaluate(next(x for x in census.metric_defs(ds) if x["local"] == i),
                                        ds, cats, national).iloc[0] for i in leaves)
            assert total == pytest.approx(100, abs=0.5), dataset_id


@pytest.mark.parametrize("dataset_id", sorted(d for d in READY if any(c.get("group") for c in READY[d]["categories"])))
def test_real_breakdowns_add_up_to_their_parent(dataset_id):
    """Each group's children (e.g. age bands from the "by age" table, or the sexes) add up to
    their parent, up to disclosure control in the separately published table: within 2%, or
    within 150 people for a small category."""
    ds = READY[dataset_id]
    if not all(resolve_path(f["file"]).exists() for f in [ds["source"], *ds["source"].get("extra", [])]):
        pytest.skip("source tables not present")
    national = census.category_counts(ds, census.read_source(ds)).sum()
    splits = {(c["parent"], c["group"]) for c in ds["categories"] if c.get("group")}
    assert splits
    for parent, group in sorted(splits):
        kids = [c["id"] for c in ds["categories"] if c.get("parent") == parent and c.get("group") == group]
        assert national[kids].sum() == pytest.approx(national[parent], rel=0.02, abs=150), (parent, group)
