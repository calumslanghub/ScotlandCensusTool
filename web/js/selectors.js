// Pure functions deriving view data from state and the data files already loaded (api.js
// peekJson; loading itself is main.js's job). Results are memoised on immutable inputs
// (the metrics object, or a loaded FeatureCollection), so map, legend, panel and charts
// share one classification and one filtered feature list.
import { peekJson } from "./api.js";
import { classify } from "./classify.js";
import { token } from "./tokens.js";

const memo = new WeakMap();  // immutable object -> Map(key -> derived value)

export function cached(obj, key, compute) {
  if (!memo.has(obj)) memo.set(obj, new Map());
  const m = memo.get(obj);
  if (!m.has(key)) m.set(key, compute());
  return m.get(key);
}

export const NATIONAL = "national";  // reference-line id for Scotland
export const LA_LINE = "la";         // reference-line id for the open council area

// --- levels and the drill path ---------------------------------------------------------

export const laLevel = (s) => s.manifest.la_level;
export const levelLabel = (s, level) => s.manifest.levels[level]?.label ?? level;
export const levelPlural = (s, level) => s.manifest.levels[level]?.plural ?? `${levelLabel(s, level)}s`;

export const mapMode = (s) => s.explorer.map_modes.find((m) => m.id === s.mapMode);
export const steps = (s) => mapMode(s).path;
export const depth = (s) => s.path.length;
export const viewLevel = (s) => steps(s)[depth(s)].level;
// Whether the view's areas can be opened (another step follows).
export const canOpen = (s) => depth(s) + 1 < steps(s).length;
export const nextLevel = (s) => (canOpen(s) ? steps(s)[depth(s) + 1].level : null);
export const openCode = (s) => s.path.at(-1) ?? null;
export const openLevel = (s) => (depth(s) ? steps(s)[depth(s) - 1].level : null);
// The open council area, when the mode's first step is council areas.
export const laCode = (s) => (steps(s)[0].level === laLevel(s) ? s.path[0] ?? null : null);

// Breadth: national 0, then each step of the mode in order. A reference line is drawn only
// for a level broader than what a chart shows.
function levelRank(s, level) {
  if (level === NATIONAL) return 0;
  const i = steps(s).findIndex((st) => st.level === level);
  return i >= 0 ? i + 1 : Infinity;
}

// --- data files and features -----------------------------------------------------------

export function nationalFile(s, level) {
  return level === laLevel(s) ? s.manifest.la_file : s.manifest.national?.[level] ?? null;
}

export function perLAFile(s, level, la = laCode(s)) {
  const template = s.manifest.per_la[level];
  return template && la ? template.replace("{la_code}", la) : null;
}

const fileForStep = (s, d) => (d === 0 ? nationalFile(s, steps(s)[0].level) : perLAFile(s, steps(s)[d].level));

// --- Census table values -----------------------------------------------------------------
// metrics.json holds every metric's definition and the values of the metrics that come from
// no dataset. A Census table's values are columnar files ({codes, <metric id>: [...]}), one
// per dataset: per level for the levels the tables are summed to (manifest.oa_groups), and
// per council area for output areas. They load with the view (requiredFiles).

export const oaLevel = (s) => s.manifest.oa_level;

// The dataset a metric's values are filed under, or null (metrics.json holds them).
export const datasetId = (s, metricId) => metricMeta(s, metricId)?.dataset ?? null;

export function datasetValuesFile(s, level, dataset) {
  const template = s.manifest.dataset_values;
  return template && dataset && s.manifest.oa_groups?.[level]
    ? template.replace("{level}", level).replace("{dataset}", dataset) : null;
}

export function oaValuesFile(s, dataset, la = laCode(s)) {
  const template = s.manifest.oa_values;
  return template && dataset && la ? template.replace("{la_code}", la).replace("{dataset}", dataset) : null;
}

// The level whose Census values a level shows: itself, or the output area a postcode sits in.
export function dataLevel(s, level) {
  const i = steps(s).findIndex((st) => st.level === level);
  return i > 0 && steps(s)[i - 1].level === oaLevel(s) ? oaLevel(s) : level;
}

// The table holding a metric's values at a level: its dataset's file once loaded (null
// until then), else metrics.json's.
function levelTable(s, level, metricId) {
  const dataset = datasetId(s, metricId);
  if (!dataset || !s.manifest.dataset_values) return s.metrics.values[level] ?? null;
  return peekJson(datasetValuesFile(s, level, dataset) ?? "");
}

// A council area's OA values of a metric's dataset once loaded (the open council area by
// default): {la, table, index: Map(code -> row)}.
function oaTable(s, metricId, la = laCode(s)) {
  const table = peekJson(oaValuesFile(s, datasetId(s, metricId), la) ?? "");
  return table && { la, table, index: cached(table, "index", () => new Map(table.codes.map((c, i) => [c, i]))) };
}

// An output area's value, from the file of the council area it lies in (neighbouring
// wards' output areas can lie in another one).
function oaValue(s, code, metricId) {
  const o = oaTable(s, metricId, featureOf(s, code)?.properties.parent_code ?? laCode(s));
  const i = o?.index.get(code);
  return i == null ? null : o.table[metricId]?.[i] ?? null;
}

// The output area a feature takes its values from: itself, or the area its link field names.
function sourceOA(s, level, code) {
  if (level === oaLevel(s)) return code;
  const i = steps(s).findIndex((st) => st.level === level);
  return dataLevel(s, level) === oaLevel(s) ? featureOf(s, code)?.properties[steps(s)[i].link] ?? null : null;
}

// Features of step d whose link field equals the code opened at step d - 1; null until
// the file has loaded.
export function stepFeatures(s, d) {
  const fc = peekJson(fileForStep(s, d) ?? "");
  if (!fc) return null;
  if (d === 0) return fc.features;
  const { link } = steps(s)[d];
  const parent = s.path[d - 1];
  return cached(fc, `${link}=${parent}`, () => fc.features.filter((f) => f.properties[link] === parent));
}

// --- neighbouring areas ----------------------------------------------------------------
// A step with `neighbours: true` also shows the features linked to the areas touching the
// open one (manifest.neighbours names the field listing them), e.g. the output areas of the
// wards around the open ward, in whichever council area they lie. They are full members of
// the view; the open area's own children are ownCodes().

const NO_CODES = [];

export const showsNeighbours = (s) => depth(s) > 0 && Boolean(steps(s)[depth(s)].neighbours);

// Codes of the areas touching the open area, read from its feature at the step before.
export function neighbourCodes(s) {
  if (!showsNeighbours(s)) return NO_CODES;
  const field = s.manifest.neighbours?.[openLevel(s)];
  const open = stepFeatures(s, depth(s) - 1)?.find((f) => f.properties.code === openCode(s));
  return (field && open?.properties[field]) || NO_CODES;
}

// Council areas, other than the open one, holding areas that touch the open area.
export function neighbourLAs(s) {
  const la = laCode(s);
  return [...new Set(neighbourCodes(s).map((c) => s.places[c]?.parent_code))].filter((c) => c && c !== la);
}

// The view level's features linked to a neighbouring area, from every loaded file.
function neighbourFeatures(s) {
  const codes = new Set(neighbourCodes(s));
  if (!codes.size) return [];
  const { level, link } = steps(s)[depth(s)];
  return [laCode(s), ...neighbourLAs(s)].flatMap((la) => {
    const fc = peekJson(perLAFile(s, level, la) ?? "");
    return fc ? cached(fc, `${link} near ${openCode(s)}`, () =>
      fc.features.filter((f) => codes.has(f.properties[link]))) : [];
  });
}

// The areas the view shows: the open area's children, then those of its neighbours. The
// array is stable while its inputs are (baseline.js memoises on it).
export function viewFeatures(s) {
  const own = stepFeatures(s, depth(s));
  if (!own) return [];
  const extra = neighbourFeatures(s);
  return extra.length ? cached(own, `with neighbours|${extra.length}`, () => [...own, ...extra]) : own;
}

export const ownCodes = (s) => (stepFeatures(s, depth(s)) ?? []).map((f) => f.properties.code);
// Siblings of the open area (other wards, other output areas...), drawn as grey context.
// At depth 1 the council-area layer itself is the context.
export const contextFeatures = (s) => (depth(s) >= 2 ? stepFeatures(s, depth(s) - 1) ?? [] : []);

export const overlayDef = (s, id) => s.explorer.overlays?.[id];

// Overlay features (e.g. OAs outside any locality), when shown in this view.
export function overlayFeatures(s, id) {
  const o = overlayDef(s, id);
  if (!o || !s.overlays[id] || !(mapMode(s).overlays ?? []).includes(id) || viewLevel(s) !== o.at) return [];
  const fc = peekJson(perLAFile(s, o.level) ?? "");
  if (!fc) return [];
  return cached(fc, `overlay|${o.field}`, () => fc.features.filter((f) => f.properties[o.field] == null));
}

// A dataset's value files for the view: one per level along the open path and for the view
// itself (the panel describes the open area, reference lines the council area); the output
// areas' files of the open council area and of those holding neighbours where a level takes
// its values from output areas.
function datasetFiles(s, dataset) {
  const files = [];
  for (let d = 0; d <= depth(s); d++) {
    const level = dataLevel(s, steps(s)[d].level);
    if (level !== oaLevel(s)) files.push(datasetValuesFile(s, level, dataset));
    else for (const la of [laCode(s), ...neighbourLAs(s)]) files.push(oaValuesFile(s, dataset, la));
  }
  return files;
}

// Every file the current view needs, for main.js to load.
export function requiredFiles(s) {
  const files = [fileForStep(s, 0)];
  for (let d = Math.max(1, depth(s) - 1); d <= depth(s) && d > 0; d++) files.push(fileForStep(s, d));
  for (const id of mapMode(s).overlays ?? []) {
    const o = overlayDef(s, id);
    if (s.overlays[id] && viewLevel(s) === o.at) files.push(perLAFile(s, o.level));
  }
  for (const la of neighbourLAs(s)) files.push(perLAFile(s, viewLevel(s), la));
  for (const dataset of indicatorDatasets(s)) files.push(...datasetFiles(s, dataset));
  return [...new Set(files.filter(Boolean))];
}

export const viewKey = (s) => `${s.mapMode}|${s.path.join("/")}|${requiredFiles(s).join(",")}`;

// code -> feature for everything loaded along the path (open areas, context, view and its
// neighbours).
function loadedFeatures(s) {
  const out = new Map();
  for (let d = 0; d < depth(s); d++) for (const f of stepFeatures(s, d) ?? []) out.set(f.properties.code, f);
  for (const f of viewFeatures(s)) out.set(f.properties.code, f);
  return out;
}

export function featureOf(s, code) {
  const fcs = Array.from({ length: depth(s) + 1 }, (_, d) => peekJson(fileForStep(s, d) ?? "")).filter(Boolean);
  const key = `features|${s.mapMode}|${s.path.join("/")}|${neighbourFeatures(s).length}`;
  return fcs.length ? cached(fcs.at(-1), key, () => loadedFeatures(s)).get(code) ?? null : null;
}

// --- places ---------------------------------------------------------------------------

// {code, name, level, parent_code, pop}: the search index, or a loaded feature's properties
// (output areas and postcodes are not in the national index).
export function placeInfo(s, code) {
  return s.places[code] ?? featureOf(s, code)?.properties ?? null;
}

export const placeName = (s, code) => placeInfo(s, code)?.name ?? code;
export const levelOf = (s, code) => placeInfo(s, code)?.level ?? null;
export const childCodes = (s) => viewFeatures(s).map((f) => f.properties.code);

// The opened areas above a view area: the current path, or for a neighbour's child the path
// to its own parent (each step's link field upwards, then the search index's parents).
export function pathTo(s, code) {
  if (!showsNeighbours(s) || ownCodes(s).includes(code)) return s.path;
  const out = [...s.path];
  let child = featureOf(s, code)?.properties;
  for (let d = depth(s); d > 0 && child; d--) {
    const parent = child[steps(s)[d].link];
    if (!parent) return s.path;
    out[d - 1] = parent;
    child = placeInfo(s, parent);
  }
  return out;
}

// The area the panel describes: the selection, else the open area, else null (Scotland).
export function focus(s) {
  if (s.selected) return { code: s.selected, level: viewLevel(s) };
  const code = openCode(s);
  return code ? { code, level: openLevel(s) } : null;
}

export function codesAt(s, level) {
  return s.metrics.values[level]?.codes ?? [];
}

export function nationalPop(s) {
  return cached(s.metrics, "nationalPop", () =>
    codesAt(s, laLevel(s)).reduce((sum, c) => sum + (s.places[c]?.pop ?? 0), 0));
}

// --- explorer config -----------------------------------------------------------------

export const currentCategory = (s) => s.explorer.categories.find((c) => c.id === s.categoryId);
export const currentIndicator = (s) => currentCategory(s).indicators.find((i) => i.id === s.indicatorId);

// Metric ids the map can show for an indicator with map.selector: the dataset's means and
// categories (map.options), else the first panel's series.
export function selectorSeries(indicator) {
  if (!indicator.map?.selector) return null;
  return indicator.map.options ?? indicator.panels.find((p) => p.series?.length)?.series ?? null;
}

export function currentMetricId(s) {
  const indicator = currentIndicator(s);
  const choice = s.selectorChoice[indicator.id];
  return choice && selectorSeries(indicator)?.includes(choice) ? choice : indicator.metric;
}

// Datasets whose values the current indicator shows: those of its metric, its map options
// and its panels' series (a dataset's sub-categories are filed with it).
export function indicatorDatasets(s) {
  const indicator = currentIndicator(s);
  return cached(indicator, "datasets", () => {
    const ids = [indicator.metric, ...(indicator.map?.options ?? []), ...indicator.panels.flatMap((p) => p.series ?? [])];
    return [...new Set(ids.map((id) => datasetId(s, id)).filter(Boolean))];
  });
}

// --- metrics -------------------------------------------------------------------------

export function metricMeta(s, id) {
  return cached(s.metrics, "meta", () => new Map(s.metrics.metrics.map((m) => [m.id, m]))).get(id);
}

export const currentMetric = (s) => metricMeta(s, currentMetricId(s));
export const isIllustrative = (meta) => meta?.source === "synthetic";
export const nationalValue = (s, id) => metricMeta(s, id)?.national ?? null;
// The value files (metrics.json or the metric's dataset files) cover the level, or the
// metric has a formula over feature properties.
export const inMetricsFile = (s, level, id) => Boolean(metricMeta(s, id)?.levels.includes(level));
export const hasData = (s, level, id) =>
  inMetricsFile(s, dataLevel(s, level), id) || Boolean(metricMeta(s, id)?.numerator);

// Hierarchy of a dataset's categories (e.g. flat -> its sub-types): `parent` is a metric id.
// `group` (e.g. age) picks a second split of the parent; without it, its sub-types.
export const childMetricIds = (s, id, group = null) =>
  cached(s.metrics, `children|${id}|${group}`, () =>
    s.metrics.metrics.filter((m) => m.parent === id && (m.group ?? null) === group).map((m) => m.id));
export const topMetricId = (s, id) => metricMeta(s, id)?.parent ?? id;

// The dataset (title, table, universe, citation, note) a metric comes from, if any.
export const datasetOf = (s, id) => s.metrics.datasets?.[metricMeta(s, id)?.dataset] ?? null;

// code -> value for a metric at a level, from its dataset's file or metrics.json (empty when
// not covered, or while the file loads).
export function valuesAt(s, level, metricId) {
  const cols = levelTable(s, level, metricId);
  if (!cols) return NO_VALUES;
  return cached(cols, `values|${metricId}`, () => {
    const vals = cols[metricId];
    const out = new Map();
    if (vals) cols.codes.forEach((code, i) => out.set(code, vals[i]));
    return out;
  });
}

const NO_VALUES = new Map();

// A census metric from feature properties: numerator / denominator * scale.
export function formulaValue(meta, props) {
  if (!meta?.numerator || !props) return null;
  const num = props[meta.numerator];
  const den = meta.denominator ? props[meta.denominator] : 1;
  if (num == null || !den) return null;
  const v = (num / den) * (meta.scale ?? 1);
  return Number(v.toFixed(meta.decimals ?? 0));
}

export function valueOf(s, code, metricId) {
  const level = levelOf(s, code);
  if (!level) return null;
  if (dataLevel(s, level) === oaLevel(s)) {
    const oa = sourceOA(s, level, code);
    return oa && inMetricsFile(s, oaLevel(s), metricId) ? oaValue(s, oa, metricId) : null;
  }
  if (inMetricsFile(s, level, metricId)) return valuesAt(s, level, metricId).get(code) ?? null;
  return formulaValue(metricMeta(s, metricId), featureOf(s, code)?.properties);
}

// code -> value of the view's level, for a level the value files cover (baseline): output
// areas of the open council area and of those holding its neighbours.
export function viewValues(s, level, metricId) {
  if (level !== oaLevel(s)) return valuesAt(s, level, metricId);
  const tables = [laCode(s), ...neighbourLAs(s)].map((la) => oaTable(s, metricId, la)).filter(Boolean);
  const key = `view|${metricId}|${tables.map((o) => o.la).join(",")}`;
  return cached(tables[0]?.table ?? EMPTY_TABLE, key, () => new Map(tables.flatMap((o) =>
    o.table.codes.map((c, i) => [c, o.table[metricId]?.[i] ?? null]))));
}

const EMPTY_TABLE = {};

// --- classification ------------------------------------------------------------------

// Areas a level's map classes are drawn from, as {owner, values(), where}: every area in
// Scotland when the value files have the level; the open council area's output areas when
// the level takes its values from them; else every loaded area of the level in the open
// council area, from the metric's formula over feature properties. `owner` is the loaded
// table the classes are memoised on (an empty one while it loads).
export function classScope(s, level, metricId = currentMetricId(s)) {
  const lv = dataLevel(s, level);
  if (lv === oaLevel(s)) {
    const o = oaTable(s, metricId);
    return { owner: o?.table ?? EMPTY_TABLE, values: () => o?.table[metricId] ?? [], where: placeName(s, laCode(s)) };
  }
  if (inMetricsFile(s, lv, metricId)) {
    return { owner: levelTable(s, lv, metricId) ?? EMPTY_TABLE, where: "Scotland",
             values: () => codesAt(s, lv).map((c) => valuesAt(s, lv, metricId).get(c)) };
  }
  const features = peekJson(perLAFile(s, level) ?? "")?.features ?? [];
  const meta = metricMeta(s, metricId);
  return { owner: features, where: placeName(s, laCode(s)), values: () => features.map((f) => formulaValue(meta, f.properties)) };
}

// Map classes for a level (null when there is no data).
export function classesFor(s, level, metricId = currentMetricId(s)) {
  if (!hasData(s, level, metricId)) return null;
  const { scheme, classes, method = "quantile" } = currentIndicator(s).map;
  const scope = classScope(s, level, metricId);
  return cached(scope.owner, `classes|${level}|${metricId}|${scheme}|${classes}|${method}`, () => {
    const values = scope.values();
    const out = classify(values, { method, classes, scheme, noData: token("no-data") });
    return out && { ...out, count: values.length, where: scope.where };
  });
}

// --- reference lines ---------------------------------------------------------------------

// Reference lines a panel draws: only for levels broader than the chart shows, and the
// council-area line only once one is open. ranked charts show the view's areas; profile
// and composition charts show their subjects (`shown`: the subjects' level, or NATIONAL
// for Scotland; by default the focus feature).
export function referenceLines(s, panel, shown = null) {
  const f = focus(s);
  shown ??= panel.type === "ranked" ? viewLevel(s) : (f ? f.level : NATIONAL);
  const lines = [];
  for (const kind of panel.reference_lines) {
    if (kind === LA_LINE && !laCode(s)) continue;
    const level = kind === LA_LINE ? laLevel(s) : NATIONAL;
    if (levelRank(s, level) < levelRank(s, shown)) lines.push({ kind, code: kind === LA_LINE ? laCode(s) : null });
  }
  return lines;
}

export function referenceValue(s, line, metricId) {
  return line.kind === LA_LINE ? valueOf(s, line.code, metricId) : nationalValue(s, metricId);
}

export const referenceName = (s, line) => (line.kind === LA_LINE ? placeName(s, line.code) : "Scotland");

// --- bounds --------------------------------------------------------------------------

export function scotlandBounds(s) {
  return cached(s.metrics, "bounds", () => {
    const boxes = codesAt(s, laLevel(s)).map((c) => s.places[c].bbox);
    return [[Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1]))],
            [Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))]];
  });
}

// What the map fits when nothing is open: a national layer other than council areas (e.g.
// the community councils of one council area) fits its own features once loaded; null
// until then. Council areas fit Scotland.
export function homeBounds(s) {
  const level = steps(s)[0].level;
  if (level === laLevel(s)) return scotlandBounds(s);
  const fc = peekJson(nationalFile(s, level) ?? "");
  return fc && cached(fc, "bounds", () => {
    const boxes = fc.features.filter((f) => f.geometry).map((f) => geometryBounds(f.geometry));
    return [[Math.min(...boxes.map((b) => b[0][0])), Math.min(...boxes.map((b) => b[0][1]))],
            [Math.max(...boxes.map((b) => b[1][0])), Math.max(...boxes.map((b) => b[1][1]))]];
  });
}

export function geometryBounds(geometry) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => {
    if (typeof c[0] === "number") {
      x0 = Math.min(x0, c[0]); y0 = Math.min(y0, c[1]); x1 = Math.max(x1, c[0]); y1 = Math.max(y1, c[1]);
    } else c.forEach(walk);
  };
  walk(geometry.coordinates);
  return [[x0, y0], [x1, y1]];
}

export function placeBounds(s, code) {
  const b = s.places[code]?.bbox;
  if (b) return [[b[0], b[1]], [b[2], b[3]]];
  const f = featureOf(s, code);
  return f?.geometry ? geometryBounds(f.geometry) : scotlandBounds(s);
}
