// The one application state object. Modules read it with getState() and change it
// only through dispatch(action); nothing else keeps a copy. Each dispatch produces a
// new frozen object, and listeners receive (state, prev, action) so they can diff.
//
// Where the map is: `mapMode` picks an explorer.map_modes drill path; `path` holds the
// codes of the areas opened along it (path[i] is an area of step i), so the view shows
// the children at step path.length; `selected` is one of those children, or null.
//
// `query` is the "Find areas" tool (query.js): the builder (level, scope, criteria), the
// loading of the files it needs, and `run`, the snapshot the map shows since the last Run.
// In mode "cluster" (cluster.js) the same builder feeds k-means: `cluster.elbow` and
// `cluster.run` hold the worker's results, which cannot be derived synchronously.

const initial = {
  status: "loading",       // loading | ready | error
  error: null,
  manifest: null,          // data/manifest.json: every data path
  metrics: null,           // metrics.json: definitions + columnar values per level
  explorer: null,          // explorer.json: tabs, indicators, panels, map modes
  places: {},              // code -> {code, name, level, parent_code, pop, bbox} (index.json)
  categoryId: null,        // selected tab
  indicatorId: null,       // selected indicator in the left list
  selectorChoice: {},      // indicator id -> metric id chosen with map.selector
  mapMode: null,           // explorer.map_modes id
  path: [],                // codes of the opened areas, one per drill step
  selected: null,          // selected area among the view's children
  layer: { key: null, status: "idle" },  // data for the view: idle | loading | ready | error
  overlays: {},            // explorer.overlays id -> shown
  compare: { on: false, codes: [] },  // compare mode and its areas (same level, in order)
  baseline: null,          // code of the area the map is compared with
  baselineMode: null,      // explorer.baseline.modes entry: relative | difference
  hover: null,             // {level, code}: map feature or chart mark under the pointer
  notice: null,            // {text, seq}: transient message over the map
  query: {
    open: false,           // the builder replaces the sidebar; the map shows `run`
    mode: "find",          // find (ranges, query.js) | cluster (k-means, cluster.js)
    level: null,           // geography level queried
    la: null,              // scope: a council area (query.scopes[0]), or null for Scotland
    ward: null,            // scope: a ward of that council area (query.scopes[1]), or null
    criteria: [],          // [{key, metricId, mode, preset, min, max, weight, transform}]
                           // (ranges: query-core.js; weight and transform: cluster-core.js)
    topic: null,           // topic (explorer category) shown in the "add a criterion" picker
    data: { key: null, status: "idle", error: null },  // the builder's files: idle | loading | ready | error
    run: null,             // {level, la, ward, criteria, seq}: what the map shows
    selected: null,        // an area of the run's results
    hover: null,           // an area of the run's results under the pointer
    cluster: {
      k: null,             // number of clusters chosen (the elbow's suggestion until changed)
      focus: null,         // a cluster outlined on the map
      // {key, status: running | ready | error, progress, series: [{k, wcss, silhouette}], knee, n, error}
      elbow: null,
      // {key, level, la, ward, criteria, k, seq, status, progress, result, error}: what the map shows
      run: null,
    },
  },
};

let state = Object.freeze({ ...initial });
const listeners = new Set();
let noticeSeq = 0;
let querySeq = 0;  // criterion keys and run numbers

const indicatorsOf = (s, categoryId) =>
  s.explorer.categories.find((c) => c.id === categoryId)?.indicators ?? [];

const samePath = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);

// Opening another area (or going up) changes the view: the compare set and the baseline
// belong to the old view, so they clear.
function openPath(s, path, selected = null) {
  if (samePath(path, s.path)) return selected === s.selected ? s : { ...s, selected };
  return { ...s, path, selected, hover: null, baseline: null, compare: { ...s.compare, codes: [] } };
}

// The query's scope levels (explorer.query.scopes): a council area, then a ward in it.
const scopeLevels = (s) => s.explorer.query?.scopes ?? [];

// A level that equals (or contains) the scope makes no sense: drop that part of the scope.
function fitScope(s, q) {
  const [laLv, wardLv] = scopeLevels(s);
  if (q.level === laLv) return { ...q, la: null, ward: null };
  if (q.level === wardLv) return { ...q, ward: null };
  return q;
}

// Criteria whose metric has no values at the level are dropped.
function fitCriteria(s, q) {
  const has = (id) => {
    const m = s.metrics.metrics.find((x) => x.id === id);
    return Boolean(m && (m.levels.includes(q.level) || m.numerator));
  };
  const criteria = q.criteria.filter((c) => has(c.metricId));
  return criteria.length === q.criteria.length ? q : { ...q, criteria };
}

function reduceQuery(s, q, a) {
  switch (a.type) {
    case "QUERY_OPEN":
      return { ...q, open: true, level: q.level ?? a.level, la: q.level ? q.la : a.la ?? null };
    case "QUERY_CLOSE":
      return { ...q, open: false, hover: null };
    case "QUERY_SET_LEVEL":
      return fitCriteria(s, fitScope(s, { ...q, level: a.level, selected: null }));
    case "QUERY_SET_SCOPE":
      return fitScope(s, { ...q, la: a.la ?? null, ward: a.la ? a.ward ?? null : null, selected: null });
    case "QUERY_ADD":
      if (q.criteria.length >= (s.explorer.query?.max_criteria ?? Infinity)) return q;
      return { ...q, criteria: [...q.criteria, { key: `c${++querySeq}`, ...a.criterion }] };
    case "QUERY_UPDATE":
      return { ...q, criteria: q.criteria.map((c) => (c.key === a.key ? { ...c, ...a.patch } : c)) };
    case "QUERY_SET_TOPIC":
      return a.topic === q.topic ? q : { ...q, topic: a.topic };
    case "QUERY_REMOVE":
      return { ...q, criteria: q.criteria.filter((c) => c.key !== a.key) };
    case "QUERY_DATA_LOADING":
      return { ...q, data: { key: a.key, status: "loading", error: null } };
    case "QUERY_DATA_LOADED":
    case "QUERY_DATA_FAILED":
      if (a.key !== q.data.key) return q;  // the builder has moved on to other files
      return { ...q, data: { key: a.key, status: a.type === "QUERY_DATA_LOADED" ? "ready" : "error", error: a.error ?? null } };
    case "QUERY_SET_MODE":
      return a.mode === q.mode ? q : { ...q, mode: a.mode, selected: null, hover: null };
    case "QUERY_CLUSTER_ELBOW":
      return { ...q, cluster: { ...q.cluster, elbow: { key: a.key, status: "running", progress: 0, n: a.n } } };
    case "QUERY_CLUSTER_RUN":
      return { ...q, selected: null, hover: null, cluster: { ...q.cluster, focus: null,
        run: { key: a.key, level: q.level, la: q.la, ward: q.ward, criteria: q.criteria, k: a.k,
               seq: ++querySeq, status: "running", progress: 0 } } };
    case "QUERY_CLUSTER_PROGRESS":
    case "QUERY_CLUSTER_DONE":
    case "QUERY_CLUSTER_FAILED": {
      const job = q.cluster[a.task];
      if (!job || job.key !== a.key || (a.seq != null && job.seq !== a.seq)) return q;  // superseded
      const patch = a.type === "QUERY_CLUSTER_PROGRESS" ? { progress: a.progress }
        : a.type === "QUERY_CLUSTER_DONE" ? { status: "ready", progress: 1, ...a.result }
          : { status: "error", error: a.error };
      const k = a.type === "QUERY_CLUSTER_DONE" && a.task === "elbow" ? a.result.knee : q.cluster.k;
      return { ...q, cluster: { ...q.cluster, k, [a.task]: { ...job, ...patch } } };
    }
    case "QUERY_CLUSTER_SET_K":
      return a.k === q.cluster.k ? q : { ...q, cluster: { ...q.cluster, k: a.k } };
    case "QUERY_CLUSTER_FOCUS":
      return a.cluster === q.cluster.focus ? q : { ...q, cluster: { ...q.cluster, focus: a.cluster } };
    case "QUERY_RUN":
      return { ...q, selected: null, hover: null,
               run: { level: q.level, la: q.la, ward: q.ward, criteria: q.criteria, seq: ++querySeq } };
    case "QUERY_CLEAR":
      return { ...q, criteria: [], run: null, selected: null, hover: null,
               cluster: { k: null, focus: null, elbow: null, run: null } };
    case "QUERY_SELECT":
      return a.code === q.selected ? q : { ...q, selected: a.code };
    case "QUERY_HOVER":
      return a.code === q.hover ? q : { ...q, hover: a.code };
    default:
      throw new Error(`Unknown action ${a.type}`);
  }
}

function reduce(s, a) {
  if (a.type.startsWith("QUERY_")) {
    const query = reduceQuery(s, s.query, a);
    if (query === s.query) return s;
    // Opening the query turns compare off: map clicks go to the query's areas.
    const compare = a.type === "QUERY_OPEN" && s.compare.on ? { on: false, codes: [] } : s.compare;
    return { ...s, query, compare, hover: a.type === "QUERY_OPEN" ? null : s.hover };
  }
  switch (a.type) {
    case "LOADED": {
      const first = a.explorer.categories[0];
      const mode = a.explorer.map_modes.find((m) => m.default) ?? a.explorer.map_modes[0];
      const overlays = Object.fromEntries(Object.entries(a.explorer.overlays ?? {})
        .map(([id, o]) => [id, Boolean(o.enabled)]));
      return { ...s, status: "ready", manifest: a.manifest, metrics: a.metrics,
               explorer: a.explorer, places: a.places, categoryId: first.id,
               indicatorId: first.indicators[0].id, mapMode: mode.id, overlays,
               baselineMode: a.explorer.baseline?.modes[0] ?? null };
    }
    case "FAILED":
      return { ...s, status: "error", error: a.error };
    case "SELECT_CATEGORY": {
      if (a.categoryId === s.categoryId) return s;
      const [first] = indicatorsOf(s, a.categoryId);
      return first ? { ...s, categoryId: a.categoryId, indicatorId: first.id } : s;
    }
    case "SELECT_INDICATOR": {
      const category = s.explorer.categories.find((c) => c.indicators.some((i) => i.id === a.indicatorId));
      if (!category || a.indicatorId === s.indicatorId) return s;
      return { ...s, categoryId: category.id, indicatorId: a.indicatorId };
    }
    case "SET_SELECTOR":
      return { ...s, selectorChoice: { ...s.selectorChoice, [s.indicatorId]: a.metricId } };
    case "SET_MAP_MODE":
      if (a.mode === s.mapMode) return s;
      return { ...openPath(s, []), mapMode: a.mode, selected: null };
    case "OPEN":  // show the children of the area at the end of `path`
      return openPath(s, a.path, a.selected ?? null);
    case "SELECT":
      return a.code === s.selected ? s : { ...s, selected: a.code };
    case "DESELECT":  // blank map: no selection, empty compare set; the view stays
      if (!s.selected && !s.compare.codes.length) return s;
      return { ...s, selected: null, compare: { ...s.compare, codes: [] } };
    case "BACK":  // one level up: the selection, else the last opened area
      if (s.selected) return { ...s, selected: null };
      return s.path.length ? openPath(s, s.path.slice(0, -1)) : s;
    case "NAVIGATE": {  // from the URL: indicator, mode, path and selection in one step
      const withIndicator = reduce(s, { type: "SELECT_INDICATOR", indicatorId: a.indicatorId });
      const withMode = a.mapMode !== s.mapMode ? { ...openPath(withIndicator, []), mapMode: a.mapMode } : withIndicator;
      return openPath(withMode, a.path, a.selected);
    }
    case "LAYER_LOADING":
      return { ...s, layer: { key: a.key, status: "loading" } };
    case "LAYER_LOADED":
    case "LAYER_FAILED":
      if (a.key !== s.layer.key) return s;  // a newer view superseded this load
      return { ...s, layer: { key: a.key, status: a.type === "LAYER_LOADED" ? "ready" : "error", error: a.error } };
    case "TOGGLE_OVERLAY":
      return { ...s, overlays: { ...s.overlays, [a.id]: !s.overlays[a.id] } };
    case "COMPARE_SET_ON":  // turning on seeds the set with the current selection
      if (a.on === s.compare.on || (a.on && s.query.open)) return s;
      return { ...s, selected: null,
               compare: { on: a.on, codes: a.on && s.selected ? [s.selected] : [] } };
    case "COMPARE_TOGGLE": {
      const has = s.compare.codes.includes(a.code);
      const codes = has ? s.compare.codes.filter((c) => c !== a.code) : [...s.compare.codes, a.code];
      return { ...s, compare: { ...s.compare, codes } };
    }
    case "SET_BASELINE":
      return a.code === s.baseline ? s : { ...s, baseline: a.code };
    case "CLEAR_BASELINE":
      return s.baseline ? { ...s, baseline: null } : s;
    case "SET_BASELINE_MODE":
      return a.mode === s.baselineMode ? s : { ...s, baselineMode: a.mode };
    case "HOVER": {
      const h = a.hover;
      const same = h === s.hover || (h && s.hover && h.level === s.hover.level && h.code === s.hover.code);
      return same ? s : { ...s, hover: h };
    }
    case "NOTICE":
      return { ...s, notice: a.text ? { text: a.text, seq: ++noticeSeq } : null };
    default:
      throw new Error(`Unknown action ${a.type}`);
  }
}

export function getState() {
  return state;
}

export function dispatch(action) {
  const prev = state;
  const next = reduce(prev, action);
  if (next === prev) return;
  state = Object.freeze(next);
  for (const listener of listeners) listener(state, prev, action);
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
