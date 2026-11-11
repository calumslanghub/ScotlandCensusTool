// "Find areas" data: which files a query needs, the areas in its scope, their values and
// the evaluated result. Pure functions of state and the files already loaded (api.js
// peekJson; query.js loads them), memoised on the loaded objects like selectors.js.
//
// A spec is {level, la, ward}: the builder's (state.query) or the last run's.
//   la      the council area (explorer.query.scopes[0]); areas whose parent_code is it
//   ward    a ward of it (scopes[1]); output areas whose ward field (manifest.oa_groups) is
//           it, or the areas holding any such output area
import { peekJson } from "./api.js";
import * as core from "./query-core.js";
import * as sel from "./selectors.js";

export const config = (s) => s.explorer.query;
export const scopeLevels = (s) => config(s)?.scopes ?? [];
export const needsScope = (s, spec) => (config(s).needs_scope ?? []).includes(spec.level) && !spec.la;

const EMPTY = [];

// --- files ---------------------------------------------------------------------------

const perLAFile = (s, level, la) => s.manifest.per_la[level]?.replace("{la_code}", la) ?? null;
const oaFile = (s, la) => perLAFile(s, sel.oaLevel(s), la);

// Council areas whose files a spec reads (every one for a per-LA level across Scotland).
function specLAs(s, spec) {
  return spec.la ? [spec.la] : s.manifest.la_codes;
}

// Value files of the Census tables a spec's criteria use, at its level (per council area for
// output areas). Metrics from no dataset are in metrics.json or computed from the features.
function valueFiles(s, spec) {
  const datasets = [...new Set((spec.criteria ?? []).map((c) => sel.datasetId(s, c.metricId)).filter(Boolean))];
  if (spec.level !== sel.oaLevel(s)) return datasets.map((ds) => sel.datasetValuesFile(s, spec.level, ds));
  return datasets.flatMap((ds) => specLAs(s, spec).map((la) => sel.oaValuesFile(s, ds, la)));
}

// Every file a spec needs, or [] when it cannot run (a level that needs a scope).
export function queryFiles(s, spec) {
  if (!spec.level || needsScope(s, spec)) return EMPTY;
  const national = sel.nationalFile(s, spec.level);
  const files = national ? [national] : specLAs(s, spec).map((la) => perLAFile(s, spec.level, la));
  files.push(...valueFiles(s, spec));
  if (spec.ward) files.push(oaFile(s, spec.la));
  return [...new Set(files.filter(Boolean))];
}

export const filesKey = (s, spec) => queryFiles(s, spec).join(",");
const loaded = (s, spec) => queryFiles(s, spec).length > 0 && queryFiles(s, spec).every((f) => peekJson(f));

// --- areas in scope --------------------------------------------------------------------

// The OA field naming a level's area (`code` for output areas themselves).
const groupField = (s, level) => (level === sel.oaLevel(s) ? null : s.manifest.oa_groups?.[level] ?? null);

function wardSet(s, spec) {
  const oas = peekJson(oaFile(s, spec.la) ?? "");
  if (!oas) return null;
  const wardField = s.manifest.oa_groups?.[scopeLevels(s)[1]];
  return sel.cached(oas, `ward|${spec.level}|${spec.ward}`, () =>
    core.wardMembers(oas.features.map((f) => f.properties), groupField(s, spec.level), wardField, spec.ward));
}

// Features of the spec's level in its scope (stable while the inputs are); [] until loaded.
export function queryFeatures(s, spec) {
  if (!loaded(s, spec)) return EMPTY;
  const national = sel.nationalFile(s, spec.level);
  const fcs = (national ? [national] : specLAs(s, spec).map((la) => perLAFile(s, spec.level, la))).map(peekJson);
  const key = `query|${spec.level}|${spec.la}|${spec.ward}|${fcs.length}`;
  return sel.cached(fcs[0], key, () => {
    let features = fcs.flatMap((fc) => fc.features);
    if (spec.la) features = features.filter((f) => f.properties.parent_code === spec.la);
    if (spec.ward) {
      const members = wardSet(s, spec);
      features = features.filter((f) => members?.has(f.properties.code));
    }
    return features;
  });
}

// --- values --------------------------------------------------------------------------

// Metrics a query can use at a level, as [{label, dataset, metrics: [meta]}]: the census base
// metrics (dataset null), then one group per dataset. Synthetic (illustrative) metrics are
// left out.
export function queryMetrics(s, level) {
  return sel.cached(s.metrics, `queryMetrics|${level}`, () => {
    const usable = s.metrics.metrics.filter((m) => !sel.isIllustrative(m) && (m.levels.includes(level) || m.numerator));
    const base = usable.filter((m) => !m.dataset);
    const groups = Object.entries(s.metrics.datasets ?? {}).map(([id, ds]) => ({
      label: `${ds.table} ${ds.title}`, dataset: id, metrics: usable.filter((m) => m.dataset === id) }));
    return [{ label: "Population and area", dataset: null, metrics: base }, ...groups].filter((g) => g.metrics.length);
  });
}

// The same groups sorted into the explorer's topics (its top tabs), as [{id, label, groups}].
export function queryTopics(s, level) {
  return sel.cached(s.metrics, `queryTopics|${level}`, () =>
    core.groupByTopic(s.explorer.categories, queryMetrics(s, level), "Other"));
}

// An area's value: the value files for its level (metrics.json or the metric's dataset), the
// dataset's OA file for output areas, else the metric's formula over the feature's
// properties (e.g. population density of an OA).
function valueOf(s, level, feature, meta) {
  const p = feature.properties;
  if (level === sel.oaLevel(s) && meta.levels.includes(level)) {
    const table = peekJson(sel.oaValuesFile(s, meta.dataset, p.parent_code) ?? "");
    if (!table) return null;
    const index = sel.cached(table, "index", () => new Map(table.codes.map((c, i) => [c, i])));
    const i = index.get(p.code);
    return i == null ? null : table[meta.id]?.[i] ?? null;
  }
  if (meta.levels.includes(level)) return sel.valuesAt(s, level, meta.id).get(p.code) ?? null;
  return sel.formulaValue(meta, p);
}

// Map(code -> value) of a metric over the spec's areas.
export function column(s, spec, metricId) {
  const features = queryFeatures(s, spec);
  const meta = sel.metricMeta(s, metricId);
  if (!meta) return new Map();
  return sel.cached(features, `column|${metricId}`, () =>
    new Map(features.map((f) => [f.properties.code, valueOf(s, spec.level, f, meta)])));
}

// --- result --------------------------------------------------------------------------

// The last run, evaluated (query-core.evaluate), or null until its files are loaded.
export function result(s) {
  const run = s.query.run;
  if (!run || !run.criteria.length) return null;
  const features = queryFeatures(s, run);
  if (!features.length && !loaded(s, run)) return null;
  return sel.cached(features, `result|${run.seq}`, () => {
    const columns = run.criteria.map((c) => column(s, run, c.metricId));
    return { features, columns, ...core.evaluate(features.map((f) => f.properties.code), columns, run.criteria) };
  });
}

// Whether the builder differs from what the map shows.
export function stale(s) {
  const { run, level, la, ward, criteria } = s.query;
  if (!run) return false;
  const strip = (cs) => JSON.stringify(cs.map(({ metricId, mode, min, max }) => [metricId, mode, min, max]));
  return run.level !== level || run.la !== la || run.ward !== ward || strip(run.criteria) !== strip(criteria);
}

// The scope in words: "Glasgow City", "Anderston/City/Yorkhill, Glasgow City" or "Scotland".
export function scopeName(s, spec) {
  if (spec.ward) return `${sel.placeName(s, spec.ward)}, ${sel.placeName(s, spec.la)}`;
  return spec.la ? sel.placeName(s, spec.la) : "Scotland";
}

// Bounds of a spec's areas: the ward or council area's box, else the boxes of the council
// areas holding its features (e.g. community councils: one council area), else Scotland.
export function scopeBounds(s, spec, features) {
  const code = spec.ward ?? spec.la;
  if (code) return sel.placeBounds(s, code);
  const las = [...new Set(features.map((f) => f.properties.parent_code))].filter((c) => s.places[c]?.bbox);
  if (!las.length) return sel.scotlandBounds(s);
  const boxes = las.map((c) => s.places[c].bbox);
  return [[Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1]))],
          [Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))]];
}
