// "Cluster areas": the k-means mode of the Find areas builder (query.js). The same level,
// scope and Topic -> Metric picker choose the variables; each gets a transform (z-score or
// rank) and a weight. "Compute elbow" runs k = 1..k_max in a Web Worker (cluster-worker.js)
// and charts the within-cluster sum of squares with a suggested k; "Run k-means" colours the
// map by cluster and profiles each cluster in the panel.
//
// Offered only when explorer.cluster.enabled and on a capable device (cores, memory, a screen
// wider than a phone). Worker results live in state.query.cluster; everything else is derived
// from state and the loaded files (query-data.js), memoised on immutable objects.
import { getState, dispatch } from "./state.js";
import { ChartJS, chromatic } from "./vendor.js";
import { setDefaults } from "./charts.js";
import { formatNumber, withUnit, escapeHtml } from "./format.js";
import { token, withAlpha } from "./tokens.js";
import * as core from "./cluster-core.js";
import * as qd from "./query-data.js";
import * as ui from "./query-ui.js";
import * as sel from "./selectors.js";

export const CLUSTER = "cluster";
const ELBOW = "elbow";
const RUN = "run";
const DEFAULT_K = 4;
const WEIGHT_MAX = 3;
const WEIGHT_STEP = 0.25;
const PALETTE = chromatic.schemeTableau10;

const workers = { [ELBOW]: null, [RUN]: null };  // running Web Workers (UI handles, not state)
let live = [];                                    // Chart.js instances on screen (UI handles)

export const config = (s) => s.explorer.cluster;
export const enabled = (s) => Boolean(config(s)?.enabled && qd.config(s));
const metaOf = (s, id) => sel.metricMeta(s, id);
const weightOf = (c) => c.weight ?? 1;
const transformOf = (c) => c.transform ?? core.ZSCORE;
// A metric's label without its bracketed note: "Average health score (1 very good ...)" -> "Average health score".
const plainLabel = (s, id) => metaOf(s, id).label.replace(/\s*\(.*\)$/, "");

// --- device check ----------------------------------------------------------------------

// Why this device cannot cluster, or null when it can.
export function incapable(s) {
  const cfg = config(s);
  const cores = navigator.hardwareConcurrency ?? 0;
  const memory = navigator.deviceMemory;  // GB, Chromium only; undefined elsewhere
  if (globalThis.matchMedia?.("(max-width: 900px)").matches) return "Clustering needs a desktop or laptop screen.";
  if (cores < cfg.min_cores) return `Clustering needs at least ${cfg.min_cores} processor cores (this device reports ${cores}).`;
  if (memory != null && memory < cfg.min_memory_gb) return `Clustering needs at least ${cfg.min_memory_gb} GB of memory.`;
  return null;
}

// --- the matrix ------------------------------------------------------------------------------

// What a job depends on: the scope and each variable with its transform and weight.
export function jobKey(spec) {
  return JSON.stringify([spec.level, spec.la, spec.ward,
    spec.criteria.map((c) => [c.metricId, transformOf(c), weightOf(c)])]);
}

// Standardised, weighted matrix of the spec's areas (cluster-core.buildMatrix); areas with
// fewer than cluster.min_pop residents, or a missing value, are left out.
function matrix(s, spec) {
  const features = qd.queryFeatures(s, spec);
  return sel.cached(features, `matrix|${jobKey(spec)}`, () => {
    const pop = new Map(features.map((f) => [f.properties.code, f.properties.pop]));
    const minPop = config(s).min_pop;
    const keep = (code) => !(Number.isFinite(pop.get(code)) && pop.get(code) < minPop);
    const columns = spec.criteria.map((c) => qd.column(s, spec, c.metricId));
    return core.buildMatrix(features.map((f) => f.properties.code), columns,
      spec.criteria.map((c) => ({ transform: transformOf(c), weight: weightOf(c) })), keep);
  });
}

const builderSpec = (s) => s.query;
const workOf = (s, m) => {
  const cfg = config(s);
  return core.workEstimate(m.n, m.d, cfg.k_max, cfg.restarts, cfg.max_iter);
};
const opts = (s) => ({ seed: config(s).seed, restarts: config(s).restarts, maxIter: config(s).max_iter,
                       sample: config(s).silhouette_sample });

// --- jobs ------------------------------------------------------------------------------

function startWorker(task, message, onDone) {
  workers[task]?.terminate();
  const worker = new Worker(new URL("./cluster-worker.js", import.meta.url), { type: "module" });
  workers[task] = worker;
  const { key, seq } = message.ids;
  const finish = () => { worker.terminate(); if (workers[task] === worker) workers[task] = null; };
  worker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      dispatch({ type: "QUERY_CLUSTER_PROGRESS", task, key, seq, progress: data.done / data.total });
    } else if (data.type === "done") {
      finish();
      dispatch({ type: "QUERY_CLUSTER_DONE", task, key, seq, result: onDone(data) });
    } else {
      finish();
      dispatch({ type: "QUERY_CLUSTER_FAILED", task, key, seq, error: data.message });
    }
  };
  worker.onerror = (e) => {
    finish();
    dispatch({ type: "QUERY_CLUSTER_FAILED", task, key, seq, error: e.message || "worker failed" });
  };
  const X = message.m.X.slice();  // a copy: the memoised matrix must not be detached
  worker.postMessage({ task, X, n: message.m.n, d: message.m.d, kMax: message.kMax, k: message.k, opts: message.opts },
    [X.buffer]);
}

function computeElbow() {
  const s = getState();
  if (!canElbow(s)) return;
  const m = matrix(s, builderSpec(s));
  const key = jobKey(builderSpec(s));
  dispatch({ type: "QUERY_CLUSTER_ELBOW", key, n: m.n });
  startWorker(ELBOW, { ids: { key }, m, kMax: config(s).k_max, opts: opts(s) },
    (data) => ({ series: data.series, knee: data.knee }));
}

function runKmeans() {
  const s = getState();
  if (!canRun(s)) return;
  const spec = builderSpec(s);
  const m = matrix(s, spec);
  const key = jobKey(spec);
  const k = chosenK(s);
  dispatch({ type: "QUERY_CLUSTER_RUN", key, k });
  const { seq } = getState().query.cluster.run;
  startWorker(RUN, { ids: { key, seq }, m, k, opts: opts(s) }, (data) => {
    const labels = Array.from(data.labels);
    return { result: { codes: m.codes, labels, k: data.k, sizes: data.sizes, wcss: data.wcss,
      silhouette: data.silhouette, n: m.n, excluded: m.excluded.length,
      profiles: core.profiles(m.raw, m.n, m.d, Int32Array.from(labels), data.k, m.stats),
      stats: m.stats } };
  });
}

// --- builder state ------------------------------------------------------------------------

const dataReady = (s) => s.query.data.status === "ready" && s.query.data.key === qd.filesKey(s, s.query);
const chosenK = (s) => s.query.cluster.k ?? Math.min(DEFAULT_K, config(s).k_max);

function blocker(s) {
  const q = s.query;
  const why = incapable(s);
  if (why) return why;
  if (qd.needsScope(s, q)) return `Choose a ${ui.lower(sel.levelLabel(s, qd.scopeLevels(s)[0]))} to cluster ${ui.plural(s, q.level)}.`;
  if (q.data.status === "error") return `Could not load data: ${q.data.error}`;
  if (!dataReady(s)) return "Loading data…";
  if (!q.criteria.length) return "Add at least one variable.";
  const m = matrix(s, builderSpec(s));
  if (m.n < 3) return `Too few ${ui.plural(s, q.level)} with values to cluster.`;
  if (workOf(s, m) > config(s).max_work) return "Too large to cluster on this device: choose a smaller area.";
  return null;
}

const running = (job) => job?.status === "running";
const canElbow = (s) => !blocker(s) && !(running(s.query.cluster.elbow) && s.query.cluster.elbow.key === jobKey(builderSpec(s)));
const canRun = (s) => !blocker(s) && !running(s.query.cluster.run) && matrix(s, builderSpec(s)).n >= chosenK(s);
export const elbowStale = (s) => Boolean(s.query.cluster.elbow) && s.query.cluster.elbow.key !== jobKey(builderSpec(s));
export const runStale = (s) => {
  const run = s.query.cluster.run;
  return Boolean(run) && (run.key !== jobKey(builderSpec(s)) || run.k !== chosenK(s));
};

function statusText(s) {
  const b = blocker(s);
  if (b) return b;
  const { elbow, run } = s.query.cluster;
  if (running(elbow)) return `Computing the elbow… ${formatNumber(elbow.progress * 100)}%`;
  if (running(run)) return "Running k-means…";
  if (elbow?.status === "error") return `Elbow failed: ${elbow.error}`;
  if (run?.status === "error") return `k-means failed: ${run.error}`;
  if (elbowStale(s)) return "The variables have changed: compute the elbow again.";
  if (!elbow) return "Compute the elbow to choose k, or run k-means straight away.";
  return runStale(s) || !run ? "Run k-means to colour the map." : "";
}

// --- sidebar ---------------------------------------------------------------------------------

export function criterionHtml(s, c) {
  const transform = ui.seg("c-transform", c.key, [[core.ZSCORE, "Z-score"], [core.RANK, "Rank"]], transformOf(c));
  return `<div class="qcrit" data-key="${c.key}">${ui.criterionHead(s, c)}
    <div class="qsegs">${transform}</div>
    <label class="qweight">Weight<input type="range" min="0" max="${WEIGHT_MAX}" step="${WEIGHT_STEP}" value="${weightOf(c)}"
      data-c-weight="${c.key}" aria-label="Weight"><span class="qwval"></span></label>
    <div class="qcount" aria-live="polite"></div></div>`;
}

export function footHtml(s) {
  const kMax = config(s).k_max;
  const ks = Array.from({ length: kMax - 1 }, (_, i) => i + 2)
    .map((k) => ui.option(k, `${k} clusters`, k === chosenK(s))).join("");
  return `<div class="qfoot"><button type="button" class="tool2 qelbow" data-c-elbow>Compute elbow</button>
    <label class="qfield">Clusters<select id="cK">${ks}</select></label>
    <div class="qbtns"><button type="button" class="qrun" data-c-run>Run k-means</button>
      <button type="button" class="tool2" data-q-clear>Clear</button></div><p class="qstatus" role="status"></p></div>`;
}

// Values that change without a re-render: weights, per-variable spread, buttons, status.
export function updateBuilder(s, el) {
  const ready = dataReady(s);
  for (const c of s.query.criteria) {
    const card = el.querySelector(`.qcrit[data-key="${c.key}"]`);
    if (!card) continue;
    const input = card.querySelector("[data-c-weight]");
    if (document.activeElement !== input) input.value = weightOf(c);
    card.querySelector(".qwval").textContent = weightOf(c) ? `×${formatNumber(weightOf(c), 2)}` : "off";
    for (const b of card.querySelectorAll("[data-c-transform]")) b.setAttribute("aria-pressed", String(b.dataset.cTransform === transformOf(c)));
    const meta = metaOf(s, c.metricId);
    const { mean, sd } = ready ? core.meanSd([...qd.column(s, s.query, c.metricId).values()]) : {};
    card.querySelector(".qcount").textContent = ready && Number.isFinite(mean)
      ? `Mean ${withUnit(mean, meta)} · SD ${withUnit(sd, meta)}` : "";
  }
  const k = el.querySelector("#cK");
  if (k && document.activeElement !== k) k.value = chosenK(s);
  const elbowBtn = el.querySelector("[data-c-elbow]");
  if (elbowBtn) elbowBtn.disabled = !canElbow(s);
  const runBtn = el.querySelector("[data-c-run]");
  if (runBtn) runBtn.disabled = !canRun(s);
  const st = el.querySelector(".qstatus");
  if (st) st.textContent = statusText(s);
}

// Structure of the builder in cluster mode (anything that needs a full re-render).
export const structure = (s) => [s.query.criteria.map((c) => transformOf(c))];

export function onClick(t) {
  if (t.dataset.cTransform) {
    dispatch({ type: "QUERY_UPDATE", key: t.dataset.key, patch: { transform: t.dataset.cTransform } });
    return true;
  }
  if (t.hasAttribute("data-c-elbow")) { computeElbow(); return true; }
  if (t.hasAttribute("data-c-run")) { runKmeans(); return true; }
  return false;
}

export function onChange(t) {
  if (t.id === "cK") { dispatch({ type: "QUERY_CLUSTER_SET_K", k: Number(t.value) }); return true; }
  return false;
}

export function onInput(t) {
  if (t.dataset.cWeight) {
    dispatch({ type: "QUERY_UPDATE", key: t.dataset.cWeight, patch: { weight: Number(t.value) } });
    return true;
  }
  return false;
}

// Defaults a new criterion carries for clustering.
export const criterionDefaults = () => ({ weight: 1, transform: core.ZSCORE });

// --- results ----------------------------------------------------------------------------

const resultOf = (s) => (s.query.cluster.run?.status === "ready" ? s.query.cluster.run : null);

export const colourOf = (label) => (label == null || label < 0 ? token("no-data") : PALETTE[label % PALETTE.length]);

function labelsByCode(run) {
  return sel.cached(run.result, "byCode", () => new Map(run.result.codes.map((c, i) => [c, run.result.labels[i]])));
}

// What the map shows: {seq, spec, features, colourOf(code), outlined: [codes]}, or null.
export function mapView(s) {
  const run = resultOf(s);
  if (!run) return null;
  const features = qd.queryFeatures(s, run);
  if (!features.length) return null;
  const focus = s.query.cluster.focus;
  return sel.cached(run.result, `view|${focus}`, () => {
    const byCode = labelsByCode(run);
    return { seq: run.seq, spec: run, features, colourOf: (code) => colourOf(byCode.get(code)),
             outlined: focus == null ? [] : run.result.codes.filter((c) => byCode.get(c) === focus) };
  });
}

export const shows = (s) => Boolean(s.query.cluster.run);

// The variable whose cluster mean differs most, as words: "higher X (+1.2 SD), lower Y (−0.8 SD)".
function describe(s, run, p) {
  return run.criteria.map((c, j) => ({ c, z: p.z[j] }))
    .filter(({ z }) => Math.abs(z) >= 0.25)
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 3)
    .map(({ c, z }) => `${z > 0 ? "higher" : "lower"} ${ui.lower(plainLabel(s, c.metricId))} (${z > 0 ? "+" : "−"}${formatNumber(Math.abs(z), 1)} SD)`)
    .join(", ") || "close to the average on every variable";
}

const zClass = (z) => (z <= -1 ? "zm2" : z < -0.25 ? "zm1" : z <= 0.25 ? "z0" : z < 1 ? "zp1" : "zp2");

function profileHtml(s, run) {
  const r = run.result;
  const heads = run.criteria.map((c) => `<th title="${escapeHtml(metaOf(s, c.metricId).label)}">${escapeHtml(plainLabel(s, c.metricId))}</th>`).join("");
  const rows = r.profiles.map((p, c) => {
    const cells = run.criteria.map((cr, j) => `<td class="${zClass(p.z[j])}" title="${p.z[j] >= 0 ? "+" : "−"}${formatNumber(Math.abs(p.z[j]), 2)} SD from the mean">${escapeHtml(withUnit(p.means[j], metaOf(s, cr.metricId)))}</td>`).join("");
    return `<tr data-c-focus="${c}" aria-current="${s.query.cluster.focus === c}"><th><i style="background:${colourOf(c)}"></i>${c + 1}<small>${formatNumber(p.size)}</small></th>${cells}</tr>`;
  }).join("");
  const all = run.criteria.map((cr, j) => `<td>${escapeHtml(withUnit(r.stats[j].mean, metaOf(s, cr.metricId)))}</td>`).join("");
  return `<div class="cprof-wrap"><table class="cprof"><thead><tr><th>Cluster</th>${heads}</tr></thead>
    <tbody>${rows}<tr class="call"><th>All<small>${formatNumber(r.n)}</small></th>${all}</tr></tbody></table></div>
    <div class="leg zleg"><span><i class="zm2"></i>much lower</span><span><i class="zm1"></i>lower</span><span><i class="z0"></i>about average</span><span><i class="zp1"></i>higher</span><span><i class="zp2"></i>much higher</span></div>`;
}

function descriptionsHtml(s, run) {
  return `<ul class="cdesc">${run.result.profiles.map((p, c) =>
    `<li><i style="background:${colourOf(c)}"></i><b>Cluster ${c + 1}</b> (${formatNumber(p.size)} ${escapeHtml(ui.plural(s, run.level, p.size))}): ${escapeHtml(describe(s, run, p))}.</li>`).join("")}</ul>`;
}

function detailHtml(s, run) {
  const code = s.query.selected;
  if (!code) return "";
  const label = labelsByCode(run).get(code);
  const f = qd.queryFeatures(s, run).find((x) => x.properties.code === code);
  if (!f) return "";
  const rows = run.criteria.map((c, j) => {
    const meta = metaOf(s, c.metricId);
    const v = qd.column(s, run, c.metricId).get(code);
    const cm = label == null ? null : run.result.profiles[label].means[j];
    return `<tr><td>${escapeHtml(meta.label)}</td><td>${escapeHtml(withUnit(v, meta))}</td>
      <td>${escapeHtml(withUnit(cm, meta))}</td><td>${escapeHtml(withUnit(run.result.stats[j].mean, meta))}</td></tr>`;
  }).join("");
  const which = label == null ? "Not clustered (missing value or too few residents)"
    : `<i class="cdot" style="background:${colourOf(label)}"></i>Cluster ${label + 1}`;
  return `<div class="qdetail"><b>${escapeHtml(f.properties.name ?? code)}</b>
    <span class="psub">${escapeHtml(sel.levelLabel(s, run.level))} · ${formatNumber(f.properties.pop)} residents · ${which}</span>
    <table class="cmp"><thead><tr><th>Variable</th><th>Value</th><th>Cluster</th><th>All</th></tr></thead><tbody>${rows}</tbody></table>
    <button type="button" class="tool2 sm" data-q-explore="${escapeHtml(code)}">Show in explorer ›</button>
    <button type="button" class="tool2 sm" data-q-deselect>Clear selection</button></div>`;
}

function elbowHtml(s) {
  const e = s.query.cluster.elbow;
  if (!e) return "";
  const stale = elbowStale(s) ? '<p class="qnote warn">The variables have changed since this elbow was computed.</p>' : "";
  let body;
  if (e.status === "running") body = `<p class="desc">Computing k = 1 to ${config(s).k_max}… ${formatNumber(e.progress * 100)}%</p>`;
  else if (e.status === "error") body = `<p class="qnote warn">${escapeHtml(e.error)}</p>`;
  else {
    body = `<div class="chart" style="height:190px"><canvas id="elbowChart" role="img" aria-label="Elbow chart"></canvas></div>
      <p class="chart-note">Suggested k = <b>${e.knee}</b>, where the curve bends most. Silhouette (dashed, right axis): higher means better-separated clusters.
      Click a point to choose k.</p>`;
  }
  return `<section class="pnl"><h3>Choosing k: the elbow</h3>${stale}${body}</section>`;
}

export function panelHtml(s) {
  const q = s.query;
  const run = q.cluster.run;
  const intro = `<p class="desc">k-means groups the ${escapeHtml(ui.plural(s, q.level))} into k clusters of areas with similar values.
    Choose the variables on the left (each is scaled to a z-score, or a rank for skewed shares, then weighted).
    <b>Compute elbow</b> shows how much each extra cluster helps; pick k where the curve flattens, then <b>Run k-means</b>.</p>`;
  if (!run) {
    return `<h2 class="ptitle">Cluster areas</h2><p class="psub">${escapeHtml(qd.scopeName(s, q))} · ${escapeHtml(sel.levelPlural(s, q.level))}</p>
      ${q.cluster.elbow ? "" : intro}${elbowHtml(s)}${foot(s)}`;
  }
  const scope = `${qd.scopeName(s, run)} · ${sel.levelPlural(s, run.level)}`;
  if (run.status !== "ready") {
    const what = run.status === "error" ? `<p class="qnote warn">${escapeHtml(run.error)}</p>` : '<p class="desc">Running k-means…</p>';
    return `<h2 class="ptitle">Cluster areas</h2><p class="psub">${escapeHtml(scope)}</p>${what}${elbowHtml(s)}`;
  }
  const r = run.result;
  const stale = runStale(s) ? '<p class="qnote warn">The variables or k have changed since this run: Run k-means again to update the map.</p>' : "";
  return `<h2 class="ptitle">${r.k} clusters of ${formatNumber(r.n)} ${escapeHtml(ui.plural(s, run.level, r.n))}</h2>
    <p class="psub">${escapeHtml(scope)}</p>${stale}
    <div class="cards">
      <div class="card"><div class="k">Clustered</div><div class="v">${formatNumber(r.n)}</div><div class="d">${escapeHtml(ui.plural(s, run.level, r.n))}</div></div>
      <div class="card"><div class="k">Silhouette</div><div class="v">${r.silhouette == null ? "–" : formatNumber(r.silhouette, 2)}</div><div class="d">−1 to 1; higher is better separated</div></div>
      ${r.excluded ? `<div class="card"><div class="k">Left out</div><div class="v">${formatNumber(r.excluded)}</div><div class="d">missing values or under ${formatNumber(config(s).min_pop)} residents</div></div>` : ""}
    </div>
    ${detailHtml(s, run)}
    <section class="pnl"><h3>Cluster profiles</h3><p class="chart-note">Each cluster's average; colour shows how far it is from all clustered areas. Click a cluster to outline it.</p>
      ${profileHtml(s, run)}${descriptionsHtml(s, run)}
      <button type="button" class="tool2 sm" data-c-csv>Download CSV</button></section>
    ${elbowHtml(s)}${foot(s)}`;
}

function foot(s) {
  return `<p class="foot">k-means (k-means++ seeding, best of ${config(s).restarts} seeded runs) on standardised values within
    ${escapeHtml(qd.scopeName(s, s.query.cluster.run ?? s.query))}, so clusters are relative to that area. It ignores location: clusters need not be
    joined-up places. Several shares from one table (e.g. every tenure type) add up to 100% and count that table more than once.
    The silhouette uses a sample of up to ${formatNumber(config(s).silhouette_sample)} areas. ${escapeHtml(s.metrics.note ?? "")}</p>`;
}

export function panelKey(s) {
  const { elbow, run, k, focus } = s.query.cluster;
  return JSON.stringify([elbow?.key, elbow?.status, Math.round((elbow?.progress ?? 0) * 20), run?.seq, run?.status,
    k, focus, s.query.selected, elbowStale(s), runStale(s), s.query.level, s.query.la, s.query.ward]);
}

// Charts after the panel's HTML is in place; previous ones are destroyed.
export function afterPanel(panel) {
  for (const c of live) c.destroy();
  live = [];
  const s = getState();
  const e = s.query.cluster.elbow;
  const canvas = panel.querySelector("#elbowChart");
  if (!canvas || e?.status !== "ready") return;
  setDefaults();
  const k = chosenK(s);
  const pointColour = (p) => (p.k === k ? token("chart-selected") : p.k === e.knee ? token("chart-la") : token("chart-mark"));
  const chart = new ChartJS(canvas, {
    type: "line",
    data: {
      labels: e.series.map((p) => p.k),
      datasets: [
        { label: "Within-cluster sum of squares", data: e.series.map((p) => p.wcss), yAxisID: "y",
          borderColor: token("chart-mark"), backgroundColor: e.series.map(pointColour),
          pointBorderColor: e.series.map((p) => (p.k === k ? token("chart-selected-edge") : pointColour(p))),
          pointRadius: e.series.map((p) => (p.k === k || p.k === e.knee ? 6 : 3)), pointHoverRadius: 7, tension: 0 },
        { label: "Silhouette", data: e.series.map((p) => p.silhouette), yAxisID: "y1", borderColor: withAlpha("chart-la", 0.8),
          borderDash: [5, 4], pointRadius: 2, pointBackgroundColor: token("chart-la"), spanGaps: true, tension: 0 },
      ],
    },
    options: {
      animation: false, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: true, labels: { boxWidth: 12, boxHeight: 2 } },
                 tooltip: { callbacks: { title: (items) => `k = ${items[0].label}` } } },
      scales: {
        x: { title: { display: true, text: "Number of clusters (k)" }, grid: { display: false } },
        y: { title: { display: true, text: "WCSS" }, beginAtZero: true, ticks: { callback: (v) => formatNumber(v) } },
        y1: { position: "right", min: 0, max: 1, title: { display: true, text: "Silhouette" }, grid: { display: false } },
      },
      onHover: (evt, els) => { evt.native.target.style.cursor = els.length ? "pointer" : "default"; },
      onClick: (_evt, els) => {
        const kk = els[0] && e.series[els[0].index].k;
        if (kk >= 2) setTimeout(() => dispatch({ type: "QUERY_CLUSTER_SET_K", k: kk }), 0);
      },
    },
  });
  live.push(chart);
}

export function onPanelClick(e, s) {
  const row = e.target.closest("[data-c-focus]");
  if (row) {
    const c = Number(row.dataset.cFocus);
    dispatch({ type: "QUERY_CLUSTER_FOCUS", cluster: s.query.cluster.focus === c ? null : c });
    return true;
  }
  if (e.target.closest("[data-c-csv]")) { downloadCsv(s); return true; }
  return false;
}

// --- legend, tooltip, CSV ------------------------------------------------------------------------

export function legendHtml(s) {
  const run = s.query.cluster.run;
  if (!run) return null;
  if (run.status !== "ready") return `<b>Cluster areas</b><span class="u">${run.status === "error" ? "Failed" : "Running k-means…"}</span>`;
  const r = run.result;
  const rows = r.sizes.map((n, c) => `<div class="row${s.query.cluster.focus === c ? " cfocus" : ""}"><i style="background:${colourOf(c)}"></i>Cluster ${c + 1}
    <span class="u-inline">${formatNumber(n)}</span></div>`).join("");
  const out = r.excluded ? `<div class="row"><i style="background:${token("no-data")}"></i>Not clustered<span class="u-inline">${formatNumber(r.excluded)}</span></div>` : "";
  return `<b>Cluster areas (k = ${r.k})</b><span class="u">${escapeHtml(sel.levelPlural(s, run.level))} in ${escapeHtml(qd.scopeName(s, run))}</span>${rows}${out}`;
}

export function tooltipHtml(s, code) {
  const run = resultOf(s);
  if (!run) return "";
  const f = qd.queryFeatures(s, run).find((x) => x.properties.code === code);
  const label = labelsByCode(run).get(code);
  const lines = run.criteria.map((c) => {
    const meta = metaOf(s, c.metricId);
    return `<br><span>${escapeHtml(meta.label)}:</span> ${escapeHtml(withUnit(qd.column(s, run, c.metricId).get(code), meta))}`;
  }).join("");
  return `<b>${escapeHtml(f?.properties.name ?? code)}</b> <span>${escapeHtml(sel.levelLabel(s, run.level))}</span><br>
    ${label == null ? "Not clustered" : `Cluster ${label + 1}`}${lines}<br><span>Residents:</span> ${formatNumber(f?.properties.pop)}`;
}

function downloadCsv(s) {
  const run = resultOf(s);
  if (!run) return;
  const byCode = labelsByCode(run);
  const metas = run.criteria.map((c) => metaOf(s, c.metricId));
  const columns = run.criteria.map((c) => qd.column(s, run, c.metricId));
  const head = ["code", "name", "level", "parent_code", "pop", "cluster", ...metas.map((m) => `${m.label} (${m.unit ?? ""})`)];
  const rows = qd.queryFeatures(s, run).map((f) => {
    const p = f.properties;
    const label = byCode.get(p.code);
    return [p.code, p.name, p.level, p.parent_code, p.pop, label == null ? null : label + 1, ...columns.map((col) => col.get(p.code))];
  }).sort((a, b) => (a[5] ?? 99) - (b[5] ?? 99));
  ui.downloadCsv(`clusters-k${run.result.k}-${run.level}-${(run.ward ?? run.la ?? "scotland").toLowerCase()}.csv`, [head, ...rows]);
}

export const crumbText = (s) => {
  const run = s.query.cluster.run;
  return run ? `${sel.levelPlural(s, run.level)} in ${qd.scopeName(s, run)}` : "Choose variables, compute the elbow, then run";
};
