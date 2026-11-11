// "Find areas": a button in the top bar swaps the left sidebar for a query builder (level,
// scope, criteria with a range each) and the right panel for the results. Run shades the
// map's areas of that level by how many criteria each meets (explorer.query.scheme; all of
// them strongest and outlined, none grey). Closing it restores the explorer view untouched.
//
// A second mode, "Cluster" (cluster.js, explorer.cluster), feeds the same level, scope and
// variables to k-means instead and colours the map by cluster.
//
// State lives in state.query (state.js); maths in query-core.js; data in query-data.js.
// While results are on screen the map extension is exclusive: the explorer's layers are
// hidden and only the query's areas are drawn and clickable.
import { getState, dispatch, subscribe } from "./state.js";
import { fetchJson } from "./api.js";
import { extendMap, line } from "./map.js";
import { formatNumber, withUnit, escapeHtml } from "./format.js";
import { token } from "./tokens.js";
import { palette } from "./classify.js";
import * as tooltip from "./tooltip.js";
import * as core from "./query-core.js";
import * as qd from "./query-data.js";
import * as ui from "./query-ui.js";
import * as cl from "./cluster.js";
import * as sel from "./selectors.js";

const $ = (id) => document.getElementById(id);
const SOURCE = "query";
const EMPTY = { type: "FeatureCollection", features: [] };
const SLIDER_STEPS = 1000;
const LIST_MAX = 250;
const FIT_PADDING = 36;
const ZOOM_MS = 800;
const NONE = "";
const FIND = "find";

let mapRef = null;     // the MapLibre instance (UI handle, not state)
let drawn = null;      // features handed to the query source (UI bookkeeping)
let painted = null;    // map view last painted
let fitted = null;     // view seq last fitted to
let builderKey = null; // structure of the builder as last rendered

const { lower, plural, option } = ui;
const metaOf = (s, id) => sel.metricMeta(s, id);
// Cluster mode is on only where it is enabled and the device can run it; otherwise Find.
const clustering = (s) => s.query.mode === cl.CLUSTER && cl.enabled(s) && !cl.incapable(s);

// --- opening and data --------------------------------------------------------------------

function toggle() {
  const s = getState();
  if (s.query.open) return dispatch({ type: "QUERY_CLOSE" });
  const levels = qd.config(s).levels;
  const level = levels.includes(sel.viewLevel(s)) ? sel.viewLevel(s) : levels[0];
  return dispatch({ type: "QUERY_OPEN", level, la: sel.laCode(s) });
}

// Load the builder's files whenever its level, scope or criteria's Census tables change
// (deferred, like main.js).
function startLoad() {
  const s = getState();
  if (s.status !== "ready" || !s.query.open || !s.query.level) return;
  const key = qd.filesKey(s, s.query);
  if (key === s.query.data.key) return;
  dispatch({ type: "QUERY_DATA_LOADING", key });
  Promise.all(qd.queryFiles(s, s.query).map(fetchJson))
    .then(() => dispatch({ type: "QUERY_DATA_LOADED", key }))
    .catch((err) => dispatch({ type: "QUERY_DATA_FAILED", key, error: err.message }));
}

const ready = (s) => s.query.data.status === "ready" && s.query.data.key === qd.filesKey(s, s.query);

// --- criteria: bounds, presets, modes ---------------------------------------------------------

const band = (s) => qd.config(s).preset_band;

// Bounds of a preset in the criterion's mode (value mode: the values at those percentiles).
function presetBounds(s, c, preset) {
  const [min, max] = core.presetRange(preset, band(s));
  if (c.mode === core.PERCENTILE || !ready(s)) return { mode: core.PERCENTILE, min, max };
  const b = core.convertBounds(qd.column(s, s.query, c.metricId), { mode: core.PERCENTILE, min, max }, core.VALUE);
  return Number.isFinite(b.min) ? b : { mode: core.PERCENTILE, min, max };
}

// The slider's range: 0..100 for percentiles, the values in scope otherwise.
function domain(s, c) {
  if (c.mode === core.PERCENTILE) return [0, 100];
  const sorted = ready(s) ? core.sortedValues(qd.column(s, s.query, c.metricId)) : [];
  return sorted.length ? [Math.min(sorted[0], c.min), Math.max(sorted.at(-1), c.max)] : [c.min, c.max];
}

const decimalsOf = (s, c) => (c.mode === core.PERCENTILE ? 0 : metaOf(s, c.metricId)?.decimals ?? 1);
const roundTo = (x, d) => Number(x.toFixed(d));

function toSlider(s, c, x) {
  const [lo, hi] = domain(s, c);
  return hi > lo ? Math.round(((x - lo) / (hi - lo)) * SLIDER_STEPS) : 0;
}

function fromSlider(s, c, t) {
  const [lo, hi] = domain(s, c);
  return roundTo(lo + (t / SLIDER_STEPS) * (hi - lo), Math.max(decimalsOf(s, c), 1));
}

// A new criterion carries both a range (find) and a transform and weight (cluster).
function addCriterion(metricId) {
  const s = getState();
  const [min, max] = core.presetRange(core.HIGH, band(s));
  dispatch({ type: "QUERY_ADD", criterion: { metricId, mode: core.PERCENTILE, preset: core.HIGH, min, max,
                                             ...cl.criterionDefaults() } });
}

function setMode(key, mode) {
  const s = getState();
  const c = s.query.criteria.find((x) => x.key === key);
  if (!c || c.mode === mode || !ready(s)) return;
  const b = core.convertBounds(qd.column(s, s.query, c.metricId), c, mode);
  const fallback = mode === core.PERCENTILE ? [0, 100] : domain(s, { ...c, mode });
  dispatch({ type: "QUERY_UPDATE", key, patch: { mode,
    min: Number.isFinite(b.min) ? b.min : fallback[0], max: Number.isFinite(b.max) ? b.max : fallback[1] } });
}

function setPreset(key, preset) {
  const s = getState();
  const c = s.query.criteria.find((x) => x.key === key);
  if (c) dispatch({ type: "QUERY_UPDATE", key, patch: { preset, ...presetBounds(s, c, preset) } });
}

function setBounds(key, min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  dispatch({ type: "QUERY_UPDATE", key, patch: { min: Math.min(min, max), max: Math.max(min, max), preset: core.CUSTOM } });
}

// --- sidebar builder ---------------------------------------------------------------------

function placesAt(s, level, parent = null) {
  return Object.values(s.places).filter((p) => p.level === level && (!parent || p.parent_code === parent))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Find | Cluster toggle, when clustering is enabled; Cluster is disabled on small devices.
function modeHtml(s) {
  if (!cl.enabled(s)) return "";
  const why = cl.incapable(s);
  const btn = (id, label, disabled = false) => `<button type="button" data-q-setmode="${id}" aria-pressed="${s.query.mode === id}"${disabled ? " disabled" : ""}>${label}</button>`;
  return `<div class="qsec qmodes"><div class="seg" role="group" aria-label="Tool">${btn(FIND, "Find by ranges")}${btn(cl.CLUSTER, "Cluster (k-means)", Boolean(why))}</div>
    ${why ? `<p class="qnote">${escapeHtml(why)}</p>` : ""}</div>`;
}

function scopeHtml(s) {
  const q = s.query;
  const [laLv, wardLv] = qd.scopeLevels(s);
  const levels = qd.config(s).levels.map((lv) => option(lv, sel.levelPlural(s, lv), lv === q.level)).join("");
  const noLA = q.level === laLv;
  const las = placesAt(s, laLv).map((p) => option(p.code, p.name, p.code === q.la)).join("");
  const noWard = !q.la || q.level === laLv || q.level === wardLv;
  const wards = q.la ? placesAt(s, wardLv, q.la).map((p) => option(p.code, p.name, p.code === q.ward)).join("") : "";
  const need = qd.needsScope(s, q)
    ? `<p class="qnote warn">${escapeHtml(sel.levelPlural(s, q.level))} are loaded per ${escapeHtml(lower(sel.levelLabel(s, laLv)))}: choose one.</p>` : "";
  const wardNote = q.ward && q.level !== sel.oaLevel(s)
    ? `<p class="qnote">${escapeHtml(sel.levelPlural(s, q.level))} with any output area in the ${escapeHtml(lower(sel.levelLabel(s, wardLv)))}.</p>` : "";
  return `<div class="qsec">
    <label class="qfield">${clustering(s) ? "Cluster" : "Find"}<select id="qLevel">${levels}</select></label>
    <label class="qfield">In<select id="qLa"${noLA ? " disabled" : ""}>${option("", "All of Scotland", !q.la)}${las}</select></label>
    <label class="qfield">${escapeHtml(sel.levelLabel(s, wardLv))}<select id="qWard"${noWard ? " disabled" : ""}>${option("", `Whole ${lower(sel.levelLabel(s, laLv))}`, !q.ward)}${wards}</select></label>
    ${need}${wardNote}</div>`;
}

function criterionHtml(s, c) {
  const meta = metaOf(s, c.metricId);
  const presets = ui.seg("q-preset", c.key, [[core.HIGH, "High"], [core.LOW, "Low"], [core.CUSTOM, "Custom"]], c.preset);
  const modes = ui.seg("q-mode", c.key, [[core.PERCENTILE, "Percentile"], [core.VALUE, "Value"]], c.mode, !ready(s));
  return `<div class="qcrit" data-key="${c.key}">${ui.criterionHead(s, c)}
    <div class="qsegs">${presets}${modes}</div>
    <div class="qrange"><div class="qtrack"><div class="qfill"></div></div>
      <input type="range" min="0" max="${SLIDER_STEPS}" data-q-lo="${c.key}" aria-label="Lower bound">
      <input type="range" min="0" max="${SLIDER_STEPS}" data-q-hi="${c.key}" aria-label="Upper bound"></div>
    <div class="qnums"><input type="number" step="any" data-q-min="${c.key}" aria-label="From">
      <span>to</span><input type="number" step="any" data-q-max="${c.key}" aria-label="To">
      <span class="qunit">${c.mode === core.PERCENTILE ? "pctile" : escapeHtml(meta.unit === "%" ? "%" : meta.unit ?? "")}</span></div>
    <div class="qcount" aria-live="polite"></div></div>`;
}

function addHtml(s) {
  const q = s.query;
  const what = clustering(s) ? "variable" : "criterion";
  if (q.criteria.length >= qd.config(s).max_criteria) {
    return `<p class="qnote">Up to ${qd.config(s).max_criteria} ${clustering(s) ? "variables" : "criteria"}.</p>`;
  }
  const topics = qd.queryTopics(s, q.level);
  if (!topics.length) return `<p class="qnote">No Census metrics for ${plural(s, q.level)}.</p>`;
  const topic = topics.find((t) => t.id === q.topic) ?? topics[0];
  const count = (t) => t.groups.reduce((n, g) => n + g.metrics.length, 0);
  const topicOptions = topics.map((t) => option(t.id, `${t.label} (${count(t)})`, t === topic)).join("");
  const used = new Set(q.criteria.map((c) => c.metricId));
  const groups = topic.groups.map((g) => `<optgroup label="${escapeHtml(g.label)}">${g.metrics.map((m) =>
    option(m.id, m.unit && m.unit !== "%" ? `${m.label} (${m.unit})` : m.label, false, used.has(m.id))).join("")}</optgroup>`).join("");
  return `<div class="qadd"><b>Add a ${what}</b>
    <label class="qfield">Topic<select id="qTopic">${topicOptions}</select></label>
    <label class="qfield">Metric<select id="qAdd">${option("", "Choose a metric…", true)}${groups}</select></label></div>`;
}

function status(s) {
  const q = s.query;
  if (qd.needsScope(s, q)) return `Choose a ${lower(sel.levelLabel(s, qd.scopeLevels(s)[0]))} to query ${plural(s, q.level)}.`;
  if (q.data.status === "error") return `Could not load data: ${q.data.error}`;
  if (!ready(s)) return "Loading data…";
  if (!q.criteria.length) return "Add at least one criterion.";
  return qd.stale(s) ? "The query has changed: Run to update the map." : "";
}

const canRun = (s) => ready(s) && s.query.criteria.length > 0 && !qd.needsScope(s, s.query);

function structure(s) {
  const q = s.query;
  return JSON.stringify([q.open, q.mode, q.level, q.la, q.ward, q.data.status, q.data.key, q.topic,
    q.criteria.map((c) => [c.key, c.metricId, c.mode]), clustering(s) ? cl.structure(s) : null]);
}

const FIND_EMPTY = '<p class="qnote">Each criterion keeps areas in a range, e.g. the top 25% for economic activity and the top 25% for households with no car.</p>';
const CLUSTER_EMPTY = '<p class="qnote">Add two or more variables, e.g. economic activity, households with no car and general health. k-means groups areas with similar values.</p>';

function renderBuilder(s) {
  const el = $("queryBuilder");
  const key = structure(s);
  if (key !== builderKey) {
    builderKey = key;
    const cluster = clustering(s);
    const crits = s.query.criteria.map((c) => (cluster ? cl.criterionHtml(s, c) : criterionHtml(s, c))).join("");
    const foot = cluster ? cl.footHtml(s)
      : `<div class="qfoot"><div class="qbtns"><button type="button" class="qrun" data-q-run>Run query</button>
        <button type="button" class="tool2" data-q-clear>Clear</button></div><p class="qstatus" role="status"></p></div>`;
    el.innerHTML = `<div class="sbh">${cluster ? "Cluster areas" : "Find areas"}</div>${modeHtml(s)}${scopeHtml(s)}
      <div class="sbh">${cluster ? "Variables" : "Criteria"}</div><div class="qcrits">${crits || (cluster ? CLUSTER_EMPTY : FIND_EMPTY)}</div>
      <div class="qsec">${addHtml(s)}</div>${foot}`;
  }
  if (clustering(s)) cl.updateBuilder(s, el);
  else updateBuilder(s);
}

// Values that change while dragging, updated in place so a drag is never interrupted.
function updateBuilder(s) {
  const el = $("queryBuilder");
  const total = ready(s) ? qd.queryFeatures(s, s.query).length : 0;
  for (const c of s.query.criteria) {
    const card = el.querySelector(`.qcrit[data-key="${c.key}"]`);
    if (!card) continue;
    const lo = toSlider(s, c, c.min);
    const hi = toSlider(s, c, c.max);
    const loIn = card.querySelector("[data-q-lo]");
    const hiIn = card.querySelector("[data-q-hi]");
    if (document.activeElement !== loIn) loIn.value = lo;
    if (document.activeElement !== hiIn) hiIn.value = hi;
    const fill = card.querySelector(".qfill");
    fill.style.left = `${(lo / SLIDER_STEPS) * 100}%`;
    fill.style.width = `${((hi - lo) / SLIDER_STEPS) * 100}%`;
    const d = decimalsOf(s, c);
    for (const [attr, x] of [["q-min", c.min], ["q-max", c.max]]) {
      const input = card.querySelector(`[data-${attr}]`);
      if (document.activeElement !== input) input.value = roundTo(x, Math.max(d, c.mode === core.PERCENTILE ? 1 : d));
    }
    for (const b of card.querySelectorAll("[data-q-preset]")) b.setAttribute("aria-pressed", String(b.dataset.qPreset === c.preset));
    card.querySelector(".qcount").textContent = ready(s)
      ? `${formatNumber(core.countMatches(qd.column(s, s.query, c.metricId), c))} of ${formatNumber(total)} ${plural(s, s.query.level, total)} in range` : "";
  }
  const run = el.querySelector("[data-q-run]");
  if (run) run.disabled = !canRun(s);
  const st = el.querySelector(".qstatus");
  if (st) st.textContent = status(s);
}

function onBuilderInput(e) {
  const t = e.target;
  if (cl.onInput(t)) return;
  const s = getState();
  const key = t.dataset.qLo ?? t.dataset.qHi;
  if (key) {
    const c = s.query.criteria.find((x) => x.key === key);
    const card = t.closest(".qcrit");
    let lo = Number(card.querySelector("[data-q-lo]").value);
    let hi = Number(card.querySelector("[data-q-hi]").value);
    if (lo > hi) {  // handles cannot cross: the moving one stops at the other
      if (t.dataset.qLo) lo = hi; else hi = lo;
      t.value = t.dataset.qLo ? lo : hi;
    }
    setBounds(key, fromSlider(s, c, lo), fromSlider(s, c, hi));
  }
}

function onBuilderChange(e) {
  const t = e.target;
  const s = getState();
  if (t.id === "qLevel") return dispatch({ type: "QUERY_SET_LEVEL", level: t.value });
  if (t.id === "qLa") return dispatch({ type: "QUERY_SET_SCOPE", la: t.value || null, ward: null });
  if (t.id === "qWard") return dispatch({ type: "QUERY_SET_SCOPE", la: s.query.la, ward: t.value || null });
  if (t.id === "qTopic") return dispatch({ type: "QUERY_SET_TOPIC", topic: t.value });
  if (t.id === "qAdd" && t.value) return addCriterion(t.value);
  if (cl.onChange(t)) return undefined;
  const key = t.dataset.qMin ?? t.dataset.qMax;
  if (key) {
    const c = s.query.criteria.find((x) => x.key === key);
    const v = Number(t.value);
    return t.dataset.qMin ? setBounds(key, v, c.max) : setBounds(key, c.min, v);
  }
  return undefined;
}

function onBuilderClick(e) {
  const t = e.target.closest("button");
  if (!t || t.disabled) return undefined;
  if (t.dataset.qSetmode) return dispatch({ type: "QUERY_SET_MODE", mode: t.dataset.qSetmode });
  if (t.dataset.qRemove) return dispatch({ type: "QUERY_REMOVE", key: t.dataset.qRemove });
  if (cl.onClick(t)) return undefined;
  if (t.dataset.qPreset) {
    return t.dataset.qPreset === core.CUSTOM ? undefined : setPreset(t.dataset.key, t.dataset.qPreset);
  }
  if (t.dataset.qMode) return setMode(t.dataset.key, t.dataset.qMode);
  if (t.hasAttribute("data-q-run")) return dispatch({ type: "QUERY_RUN" });
  if (t.hasAttribute("data-q-clear")) return dispatch({ type: "QUERY_CLEAR" });
  return undefined;
}

// --- colours ---------------------------------------------------------------------------

// Colour per number of criteria met: [none, 1, ..., n]; n is the darkest step of the ramp.
// The ramp's lightest step is skipped: it is too close to the grey of "none".
function colours(s, n) {
  return [token("query-none"), ...(n ? palette(qd.config(s).scheme, n + 1).slice(1) : [])];
}

const colourOf = (s, r, entry) => (!entry || entry.nodata ? token("no-data") : colours(s, r.n)[entry.k]);

// --- right panel -------------------------------------------------------------------------

function criterionLabel(s, c) {
  const meta = metaOf(s, c.metricId);
  const fmt = (x) => (c.mode === core.PERCENTILE ? formatNumber(x, 0) : withUnit(x, meta));
  const range = c.mode === core.PERCENTILE ? `percentile ${fmt(c.min)}–${fmt(c.max)}` : `${fmt(c.min)} to ${fmt(c.max)}`;
  const word = c.preset === core.HIGH ? "High" : c.preset === core.LOW ? "Low" : "Range";
  return `${word} ${lower(meta.label)} (${range})`;
}

function rowsSorted(r) {
  return sel.cached(r, "rows", () => r.features.map((f) => ({ f, e: r.byCode.get(f.properties.code) }))
    .filter(({ e }) => e && !e.nodata && e.k > 0)
    .sort((a, b) => b.e.k - a.e.k || a.e.fit - b.e.fit));
}

function detailHtml(s, r) {
  const code = s.query.selected;
  const entry = code && r.byCode.get(code);
  if (!entry) return "";
  const run = s.query.run;
  const rows = run.criteria.map((c, i) => {
    const meta = metaOf(s, c.metricId);
    const med = core.median(core.sortedValues(r.columns[i]));
    const pct = entry.pcts[i];
    return `<tr class="${entry.hits[i] ? "hit" : ""}"><td>${entry.hits[i] ? "✓" : "–"} ${escapeHtml(meta.label)}</td>
      <td>${escapeHtml(withUnit(entry.values[i], meta))}</td><td>${pct == null ? "–" : formatNumber(pct, 0)}</td>
      <td>${escapeHtml(withUnit(med, meta))}</td></tr>`;
  }).join("");
  const pop = sel.placeInfo(s, code)?.pop ?? r.features.find((f) => f.properties.code === code)?.properties.pop;
  return `<div class="qdetail"><b>${escapeHtml(sel.placeName(s, code) || code)}</b>
    <span class="psub">${escapeHtml(sel.levelLabel(s, run.level))} · ${formatNumber(pop)} residents · meets ${entry.k} of ${r.n}</span>
    <table class="cmp"><thead><tr><th>Criterion</th><th>Value</th><th>Pctile</th><th>Median</th></tr></thead><tbody>${rows}</tbody></table>
    <button type="button" class="tool2 sm" data-q-explore="${escapeHtml(code)}">Show in explorer ›</button>
    <button type="button" class="tool2 sm" data-q-deselect>Clear selection</button></div>`;
}

function listHtml(s, r) {
  const rows = rowsSorted(r);
  const shown = rows.slice(0, LIST_MAX);
  const items = shown.map(({ f, e }) => {
    const code = f.properties.code;
    const vals = s.query.run.criteria.map((c, i) => withUnit(e.values[i], metaOf(s, c.metricId))).join(" · ");
    return `<button type="button" class="qrow" data-q-code="${escapeHtml(code)}" aria-current="${code === s.query.selected}">
      <i style="background:${colourOf(s, r, e)}"></i><span class="nm">${escapeHtml(f.properties.name ?? code)}
      <small>${escapeHtml(vals)}</small></span><span class="qk">${e.k}/${r.n}</span></button>`;
  }).join("");
  const more = rows.length > shown.length ? `<p class="chart-note">Showing the first ${LIST_MAX} of ${formatNumber(rows.length)}. Download the CSV for all.</p>` : "";
  return rows.length ? `<div class="qlist">${items}</div>${more}`
    : `<p class="desc">No ${plural(s, s.query.run.level)} meet any of the criteria.</p>`;
}

function panelHtml(s) {
  const q = s.query;
  if (!q.run) {
    return `<h2 class="ptitle">Find areas</h2><p class="psub">Build a query on the left, then Run.</p>
      <p class="desc">Choose the kind of area to find and, if you like, limit it to one council area or ward.
      Add criteria from any Census table and set each one's range: <b>High</b> keeps the top ${band(s)}% of the areas in scope,
      <b>Low</b> the bottom ${band(s)}%, or drag the slider. Switch a criterion to <b>Value</b> to set the range in its own units.
      The map then shades every area by how many criteria it meets.</p>`;
  }
  const r = qd.result(s);
  const title = `${qd.scopeName(s, q.run)} · ${sel.levelPlural(s, q.run.level)}`;
  if (!r) return `<h2 class="ptitle">Find areas</h2><p class="psub">${escapeHtml(title)}</p><p class="desc">Loading…</p>`;
  const full = r.counts[r.n] ?? 0;
  const total = r.features.length;
  const fullPop = r.features.filter((f) => r.byCode.get(f.properties.code)?.k === r.n)
    .reduce((sum, f) => sum + (f.properties.pop ?? 0), 0);
  const near = r.n > 1 ? r.counts[r.n - 1] : null;
  const staleNote = qd.stale(s) ? '<p class="qnote warn">The query has changed since this run: Run again to update the map.</p>' : "";
  const crits = q.run.criteria.map((c) => `<li>${escapeHtml(criterionLabel(s, c))}</li>`).join("");
  return `<h2 class="ptitle">${formatNumber(full)} of ${formatNumber(total)} ${escapeHtml(plural(s, q.run.level, total))} match ${r.n === 1 ? "the criterion" : `all ${r.n} criteria`}</h2>
    <p class="psub">${escapeHtml(title)}</p>${staleNote}
    <div class="cards">
      <div class="card"><div class="k">Full matches</div><div class="v">${formatNumber(full)}</div><div class="d">${total ? formatNumber((full / total) * 100, 1) : "–"}% of ${escapeHtml(plural(s, q.run.level, total))}</div></div>
      <div class="card"><div class="k">Residents</div><div class="v">${formatNumber(fullPop)}</div><div class="d">in full matches</div></div>
      ${near != null ? `<div class="card"><div class="k">Near misses</div><div class="v">${formatNumber(near)}</div><div class="d">meet ${r.n - 1} of ${r.n}</div></div>` : ""}
      ${r.nodata ? `<div class="card"><div class="k">No data</div><div class="v">${formatNumber(r.nodata)}</div><div class="d">no values</div></div>` : ""}
    </div>
    <ul class="qcritlist">${crits}</ul>
    ${detailHtml(s, r)}
    <section class="pnl"><h3>Areas by criteria met</h3>${listHtml(s, r)}
      <button type="button" class="tool2 sm" data-q-csv>Download CSV</button></section>
    <p class="foot">Percentiles rank the ${escapeHtml(plural(s, q.run.level))} in ${escapeHtml(qd.scopeName(s, q.run))} that have a value (0 lowest, 100 highest; ties share a rank).
      An area with no value for a criterion does not meet it.${q.run.ward && q.run.level !== sel.oaLevel(s) ? ` A ${escapeHtml(lower(sel.levelLabel(s, qd.scopeLevels(s)[1])))} scope keeps the ${escapeHtml(plural(s, q.run.level))} with any output area in it.` : ""}
      ${escapeHtml(s.metrics.note ?? "")}</p>`;
}

let panelKey = null;  // what the panel last showed (UI bookkeeping)

function renderPanel(s) {
  const q = s.query;
  const cluster = clustering(s);
  const key = cluster ? `cluster|${cl.panelKey(s)}`
    : JSON.stringify([q.run?.seq, q.selected, qd.stale(s), Boolean(qd.result(s)), s.query.data.status]);
  if (key === panelKey) return;
  panelKey = key;
  const panel = $("panel");
  panel.innerHTML = `<div class="pin">${cluster ? cl.panelHtml(s) : panelHtml(s)}</div>`;
  cl.afterPanel(panel);
  panel.querySelector(`.qrow[aria-current="true"]`)?.scrollIntoView({ block: "nearest" });
}

function onPanelClick(e) {
  const s = getState();
  if (!s.query.open) return undefined;
  if (clustering(s) && cl.onPanelClick(e, s)) return undefined;
  const row = e.target.closest("[data-q-code]");
  if (row) {
    dispatch({ type: "QUERY_SELECT", code: row.dataset.qCode });
    return zoomTo(row.dataset.qCode);
  }
  const explore = e.target.closest("[data-q-explore]");
  if (explore) return showInExplorer(explore.dataset.qExplore);
  if (e.target.closest("[data-q-deselect]")) return dispatch({ type: "QUERY_SELECT", code: null });
  if (e.target.closest("[data-q-csv]")) return downloadCsv(s);
  return undefined;
}

function onPanelHover(e) {
  const s = getState();
  if (!s.query.open) return;
  const row = e.target.closest("[data-q-code]");
  dispatch({ type: "QUERY_HOVER", code: row ? row.dataset.qCode : null });
}

// --- show in explorer ------------------------------------------------------------------

// The first map mode with a step at the level, and the drill path to the area: each step's
// link field upwards from the feature's properties, then the search index's parents.
function explorerTarget(s, level, props) {
  for (const mode of s.explorer.map_modes) {
    const d = mode.path.findIndex((st) => st.level === level);
    if (d < 0) continue;
    if (d === 0) return mode.path.length > 1 ? { mode: mode.id, path: [props.code], selected: null }
      : { mode: mode.id, path: [], selected: props.code };
    const path = [];
    let p = props;
    for (let i = d; i > 0 && p; i--) {
      const parent = p[mode.path[i].link];
      if (!parent) break;
      path.unshift(parent);
      p = s.places[parent];
    }
    if (path.length === d) return { mode: mode.id, path, selected: props.code };
  }
  return null;
}

// The indicator showing a metric (its headline or one of its map options).
function indicatorFor(s, metricId) {
  for (const c of s.explorer.categories) {
    for (const i of c.indicators) if (i.metric === metricId || sel.selectorSeries(i)?.includes(metricId)) return i;
  }
  return null;
}

function showInExplorer(code) {
  const s = getState();
  const view = mapView(s);
  const f = view?.features.find((x) => x.properties.code === code);
  const target = f && explorerTarget(s, view.spec.level, f.properties);
  if (!target) return;
  const metricId = view.spec.criteria[0]?.metricId;
  const indicator = metricId && indicatorFor(s, metricId);
  dispatch({ type: "QUERY_CLOSE" });
  dispatch({ type: "NAVIGATE", indicatorId: indicator?.id ?? s.indicatorId, mapMode: target.mode,
             path: target.path, selected: target.selected });
  if (indicator && indicator.metric !== metricId) dispatch({ type: "SET_SELECTOR", metricId });
}

// --- CSV ---------------------------------------------------------------------------------

function downloadCsv(s) {
  const r = qd.result(s);
  if (!r) return;
  const run = s.query.run;
  const metas = run.criteria.map((c) => metaOf(s, c.metricId));
  const head = ["code", "name", "level", "parent_code", "pop", "criteria_met", "criteria",
    ...metas.flatMap((m) => [`${m.label} (${m.unit ?? ""})`, `${m.label} percentile`])];
  const rows = r.features.map((f) => {
    const p = f.properties;
    const e = r.byCode.get(p.code);
    return [p.code, p.name, p.level, p.parent_code, p.pop, e.nodata ? "" : e.k, r.n,
      ...metas.flatMap((_, i) => [e.values[i], e.pcts[i] == null ? null : Number(e.pcts[i].toFixed(1))])];
  }).sort((a, b) => (b[5] || 0) - (a[5] || 0));
  ui.downloadCsv(`find-areas-${run.level}-${(run.ward ?? run.la ?? "scotland").toLowerCase()}.csv`, [head, ...rows]);
}

// --- legend ------------------------------------------------------------------------------

// Legend HTML while results are on the map, else null (legend.js draws its own).
export function legendHtml(s) {
  if (!s.query.open) return null;
  if (clustering(s)) return cl.legendHtml(s);
  if (!s.query.run) return null;
  const r = qd.result(s);
  if (!r) return `<b>Find areas</b><span class="u">Loading…</span>`;
  const c = colours(s, r.n);
  const row = (colour, text, count, cls = "") => `<div class="row"><i class="${cls}" style="background:${colour}"></i>${escapeHtml(text)}
    <span class="u-inline">${formatNumber(count)}</span></div>`;
  const rows = [];
  for (let k = r.n; k >= 1; k--) {
    const text = k === r.n ? (r.n === 1 ? "Meets the criterion" : `Meets all ${r.n}`) : `Meets ${k} of ${r.n}`;
    rows.push(row(c[k], text, r.counts[k], k === r.n ? "qall" : ""));
  }
  rows.push(row(c[0], "Meets none", r.counts[0]));
  if (r.nodata) rows.push(row(token("no-data"), "No data", r.nodata));
  return `<b>Find areas</b><span class="u">${escapeHtml(sel.levelPlural(s, s.query.run.level))} in ${escapeHtml(qd.scopeName(s, s.query.run))}</span>${rows.join("")}`;
}

// --- map -------------------------------------------------------------------------------

const codeIs = (code) => ["==", ["get", "code"], code ?? NONE];

function layers() {
  return [
    { id: "query-fill", type: "fill", source: SOURCE, paint: { "fill-color": token("no-data") } },
    line("query-line", SOURCE, "map-edge", 0.5),
    line("query-full", SOURCE, "query-outline", 1.8, { filter: ["in", ["get", "code"], ["literal", []]] }),
    line("query-selected-outer", SOURCE, "map-select-outer", 3.2, { filter: codeIs(null) }),
    line("query-selected-inner", SOURCE, "map-select-inner", 1.4, { filter: codeIs(null) }),
    line("query-hover", SOURCE, "map-hover", 2, { hoverOnly: true }),
  ];
}

// The find run as a map view: {seq, spec, features, colourOf(code), outlined}, or null.
function findView(s) {
  const r = qd.result(s);
  if (!r) return null;
  return sel.cached(r, "view", () => ({
    seq: s.query.run.seq, spec: s.query.run, features: r.features,
    colourOf: (code) => colourOf(s, r, r.byCode.get(code)),
    outlined: r.n > 0 ? r.features.map((f) => f.properties.code).filter((c) => r.byCode.get(c)?.k === r.n) : [],
  }));
}

// What the map shows for the open tool's mode, or null.
function mapView(s) {
  if (!s.query.open) return null;
  return clustering(s) ? cl.mapView(s) : findView(s);
}

const shows = (s) => s.query.open && (clustering(s) ? cl.shows(s) : Boolean(s.query.run));

function paintView(map, s, view) {
  const codes = view.features.map((f) => f.properties.code);
  map.setPaintProperty("query-fill", "fill-color", codes.length
    ? ["match", ["get", "code"], ...codes.flatMap((c) => [c, view.colourOf(c)]), token("no-data")]
    : token("no-data"));
  map.setPaintProperty("query-fill", "fill-opacity", s.explorer.basemap?.fill_opacity?.[view.spec.level] ?? 1);
  map.setFilter("query-full", ["in", ["get", "code"], ["literal", view.outlined]]);
}

function fitTo(map, bounds) {
  map.fitBounds(bounds, { padding: FIT_PADDING, duration: ZOOM_MS, maxZoom: 15 });
}

function zoomTo(code) {
  const f = mapView(getState())?.features.find((x) => x.properties.code === code);
  if (mapRef && f?.geometry) fitTo(mapRef, sel.geometryBounds(f.geometry));
}

function setHover(map, code, on) {
  if (code && map.getSource(SOURCE)) map.setFeatureState({ source: SOURCE, id: code }, { hover: on });
}

function renderMap(map, s, prev) {
  mapRef = map;
  if (s.status !== "ready") return;
  const view = shows(s) ? mapView(s) : null;
  const features = view?.features ?? null;
  if (features !== drawn) {
    drawn = features;
    map.getSource(SOURCE).setData(features ? { type: "FeatureCollection", features } : EMPTY);
  }
  if (view && view !== painted) {
    painted = view;
    paintView(map, s, view);
  }
  if (!view) painted = null;
  if (view && fitted !== view.seq) {
    fitted = view.seq;
    fitTo(map, qd.scopeBounds(s, view.spec, view.features));
  }
  if (!s.query.open) fitted = null;
  if (!prev || prev.query.selected !== s.query.selected || prev.query.run !== s.query.run ||
      prev.query.cluster.run !== s.query.cluster.run || prev.query.mode !== s.query.mode) {
    map.setFilter("query-selected-outer", codeIs(view ? s.query.selected : null));
    map.setFilter("query-selected-inner", codeIs(view ? s.query.selected : null));
  }
  if (prev && prev.query.hover !== s.query.hover) {
    setHover(map, prev.query.hover, false);
    setHover(map, s.query.hover, true);
  }
}

function tooltipHtml(s, code) {
  if (clustering(s)) return cl.tooltipHtml(s, code);
  const r = qd.result(s);
  const e = r?.byCode.get(code);
  if (!e) return "";
  const f = r.features.find((x) => x.properties.code === code);
  const lines = s.query.run.criteria.map((c, i) => {
    const meta = metaOf(s, c.metricId);
    return `<br>${e.hits[i] ? "✓" : "–"} <span>${escapeHtml(meta.label)}:</span> ${escapeHtml(withUnit(e.values[i], meta))}`;
  }).join("");
  const head = e.nodata ? "No data" : `Meets ${e.k} of ${r.n}`;
  return `<b>${escapeHtml(f?.properties.name ?? code)}</b> <span>${escapeHtml(sel.levelLabel(s, s.query.run.level))}</span><br>
    ${head}${lines}<br><span>Residents:</span> ${formatNumber(f?.properties.pop)}`;
}

function onMapHover(hit, x, y) {
  const s = getState();
  if (hit) {
    dispatch({ type: "QUERY_HOVER", code: hit.code });
    tooltip.showHtml(x, y, tooltipHtml(getState(), hit.code));
  } else if (s.query.hover) {
    dispatch({ type: "QUERY_HOVER", code: null });
    tooltip.hide();
  }
}

function onMapClick(hit) {
  const s = getState();
  dispatch({ type: "QUERY_SELECT", code: hit.code === s.query.selected ? null : hit.code });
}

// --- top bar, crumb bar, sidebar ----------------------------------------------------------------

function renderChrome(s) {
  const open = s.query.open;
  const btn = $("queryBtn");
  btn.hidden = !qd.config(s);
  btn.setAttribute("aria-pressed", String(open));
  $("sbExplore").hidden = open;
  $("queryBuilder").hidden = !open;
  $("crumbbar").classList.toggle("querying", open);
  $("mapbox").classList.toggle("querying", open);
  $("queryCrumb").hidden = !open;
  if (open) {
    const cluster = clustering(s);
    const what = cluster ? cl.crumbText(s)
      : s.query.run ? `${sel.levelPlural(s, s.query.run.level)} in ${qd.scopeName(s, s.query.run)}` : "Build a query, then Run";
    $("queryCrumb").innerHTML = `<b>${cluster ? "Cluster areas" : "Find areas"}</b> <span class="sep" aria-hidden="true">›</span> ${escapeHtml(what)}
      <button type="button" class="tool2 sm" data-q-close>Close</button>`;
  }
}

// --- render --------------------------------------------------------------------------

function render(s, prev) {
  if (s.status !== "ready" || !qd.config(s)) return;
  const first = !prev || prev.status !== "ready";
  if (first || s.query !== prev.query) queueMicrotask(startLoad);
  if (!first && s.query === prev.query) return;
  if (first || s.query.open !== prev.query.open || s.query.run !== prev.query.run || s.query.mode !== prev.query.mode ||
      s.query.cluster.run !== prev.query.cluster.run) renderChrome(s);
  if (!s.query.open) {
    builderKey = null;
    panelKey = null;
    return;
  }
  renderBuilder(s);
  renderPanel(s);
}

export function initQuery() {
  extendMap({
    sources: () => ({ [SOURCE]: { type: "geojson", data: EMPTY, promoteId: "code" } }),
    layers,
    exclusive: shows,
    pickLayers: ["query-fill"],
    click: onMapClick,
    hover: onMapHover,
    render: renderMap,
    blankClick: () => getState().query.selected && dispatch({ type: "QUERY_SELECT", code: null }),
  });
  $("queryBtn").addEventListener("click", toggle);
  $("queryCrumb").addEventListener("click", (e) => e.target.closest("[data-q-close]") && dispatch({ type: "QUERY_CLOSE" }));
  const builder = $("queryBuilder");
  builder.addEventListener("input", onBuilderInput);
  builder.addEventListener("change", onBuilderChange);
  builder.addEventListener("click", onBuilderClick);
  const panel = $("panel");
  panel.addEventListener("click", onPanelClick);
  panel.addEventListener("mouseover", onPanelHover);
  panel.addEventListener("mouseleave", () => getState().query.hover && dispatch({ type: "QUERY_HOVER", code: null }));
  subscribe(render);
}
