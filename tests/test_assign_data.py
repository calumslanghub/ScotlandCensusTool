"""Assignment checks on the real Census data (skipped if data/raw is absent).

The assignment summary for each LA geometry source is printed in the pytest
terminal summary (see conftest.py), so failures and their reasons are always visible.
"""
from __future__ import annotations

import copy

import pytest

from build.assign import AssignResult, assign, join_points
from build.config import is_derived, load_levels_config, resolve_path
from build.load import load_all

CFG = load_levels_config()
JOIN_LEVELS = [lv for lv, spec in CFG["levels"].items() if spec.get("parent_join")]
COUNCIL_LEVELS = [lv for lv, spec in CFG["levels"].items()
                  if not is_derived(spec) and spec["fields"]["parent_code"]]
DERIVED_LEVELS = [lv for lv, spec in CFG["levels"].items() if is_derived(spec)]
LA_LEVEL = CFG["assign"]["la_level"]

pytestmark = pytest.mark.skipif(
    not all(resolve_path(s["path"]).exists() for s in CFG["levels"].values() if not is_derived(s)),
    reason="raw Census data not present")


@pytest.fixture(scope="session")
def reports(pytestconfig) -> dict[str, AssignResult]:
    """Shared with conftest.pytest_terminal_summary via the pytest config."""
    pytestconfig.assign_reports = {}
    return pytestconfig.assign_reports


@pytest.fixture(scope="session")
def loaded():
    return load_all(CFG)


@pytest.fixture(scope="session", params=["dissolve_oa", "file"])
def result(request, loaded, reports) -> AssignResult:
    cfg = copy.deepcopy(CFG)
    cfg["assign"]["la_geometry"] = request.param
    res = assign(loaded, cfg)
    reports[request.param] = res
    return res


def failure_message(res: AssignResult, level: str) -> str:
    f = res.failures()
    f = f[f["level"] == level]
    return (f"{len(f)} {level} features failed: {f['status'].value_counts().to_dict()}; "
            f"examples: {f['code'].head(10).tolist()}")


@pytest.mark.parametrize("level", JOIN_LEVELS)
def test_join_levels_have_exactly_one_parent(result, level):
    gdf = result.levels[level]
    assert gdf["parent_code"].notna().all(), failure_message(result, level)
    assert result.failures().query("level == @level").empty, failure_message(result, level)


@pytest.mark.parametrize("level", JOIN_LEVELS + COUNCIL_LEVELS)
def test_parent_codes_exist_in_la_table(result, level):
    la_codes = set(result.levels[LA_LEVEL]["code"])
    unknown = set(result.levels[level]["parent_code"].dropna()) - la_codes
    assert not unknown, f"{level}: parent codes not in LA table: {sorted(unknown)[:10]}"


@pytest.mark.parametrize("level", COUNCIL_LEVELS)
def test_council_matches_representative_point_la(result, level):
    """The source council agrees with the LA its representative point falls in."""
    gdf = result.levels[level]
    by_point, _ = join_points(gdf, result.levels[LA_LEVEL])
    disagree = gdf.loc[by_point != gdf["parent_code"], "code"]
    assert disagree.empty, f"{level}: {len(disagree)} disagree, e.g. {disagree.head(10).tolist()}"


def test_every_la_has_a_locality(result):
    loc = result.levels[CFG["assign"]["locality_level"]]
    missing = set(result.levels[LA_LEVEL]["code"]) - set(loc["parent_code"])
    assert not missing, f"LAs with no locality: {sorted(missing)}"


def test_la_sources_agree(loaded, reports):
    """dissolve_oa and file produce the same parents for join levels."""
    cfg_file = copy.deepcopy(CFG)
    cfg_file["assign"]["la_geometry"] = "file"
    a = reports.get("dissolve_oa") or assign(loaded, CFG)
    b = reports.get("file") or assign(loaded, cfg_file)
    for level in JOIN_LEVELS:
        pa = a.levels[level].set_index("code")["parent_code"]
        pb = b.levels[level].set_index("code")["parent_code"]
        diff = pa[pa != pb]
        assert diff.empty, f"{level}: {len(diff)} differ between LA sources, e.g. {diff.index[:10].tolist()}"


# --- electoral wards (derived from OAs) and postcode -> OA links ---------------------------

@pytest.mark.parametrize("level", DERIVED_LEVELS)
def test_derived_levels_cover_every_member_and_have_a_parent(result, level):
    d = CFG["levels"][level]["derived"]
    members, derived = result.levels[d["from"]], result.levels[level]
    assert members[d["group_field"]].notna().all(), f"{d['from']} without {d['group_field']}"
    assert set(derived["code"]) == set(members[d["group_field"]])
    assert derived["parent_code"].notna().all()
    assert derived["pop"].sum() == members["pop"].sum()
    assert (derived["name"] != derived["code"]).all(), "every ward is named from the lookup"


def test_wards_do_not_straddle_council_areas(result):
    oa = result.levels["oa"]
    assert (oa.groupby("ward_code")["parent_code"].nunique() == 1).all()


@pytest.mark.parametrize("rule", CFG["assign"]["point_fields"], ids=lambda r: r["level"])
def test_point_links_resolve_and_inherit(result, rule):
    gdf, source = result.levels[rule["level"]], result.levels[rule["from"]]
    linked = gdf[rule["link_field"]]
    assert linked.notna().all(), f"{int(linked.isna().sum())} {rule['level']} without {rule['link_field']}"
    assert linked.isin(set(source["code"])).all()
    for f in rule["fields"]:
        expected = linked.map(source.set_index("code")[f])
        assert (gdf[f].astype(object) == expected.astype(object)).all()
