// Baseline: with exactly one area selected (or one in the compare set) the panel offers
// "Use as baseline". The map then shades every other area of the view (all of Scotland for
// data zones; the open ward's and its neighbouring wards' output areas) by its difference
// to the baseline on a five-class diverging scale (baseline-core.js); the legend switches
// between explorer.baseline.modes; ranked charts get a dashed baseline line. The baseline
// clears when the view changes (state.js).
//
// Values come from metrics.json where it covers the view's level, otherwise from the
// feature properties already loaded for the view (e.g. output areas), using the census
// metric's formula. No extra file is fetched.
import { dispatch, subscribe } from "./state.js";
import { extendMap, SOURCE, codeIs, line } from "./map.js";
import { formatNumber, signedDiff, withUnit, escapeHtml } from "./format.js";
import { token } from "./tokens.js";
import * as core from "./baseline-core.js";
import * as sel from "./selectors.js";

const $ = (id) => document.getElementById(id);
const config = (s) => s.explorer.baseline;
const CLASS_TOKENS = ["div-below-2", "div-below-1", "div-mid", "div-above-1", "div-above-2"];
const MODE_LABEL = { [core.RELATIVE]: "Relative %", [core.DIFFERENCE]: "Difference" };
const OUTLINE_WIDTH = 3.2;

// --- the comparison ------------------------------------------------------------------

export const active = (s) => Boolean(s.baseline) && sel.levelOf(s, s.baseline) === sel.viewLevel(s);

// Rows for the view's areas: {code, value, denominator}.
function viewRows(s, features) {
  const level = sel.viewLevel(s);
  const metric = sel.currentMetric(s);
  const field = config(s).min_denominator?.field ?? null;
  if (!metric.levels.includes(level)) return core.rowsFromFeatures(features, metric, field);
  const values = sel.viewValues(s, level, metric.id);
  return features.map(({ properties: p }) => ({
    code: p.code, value: values.get(p.code) ?? null, denominator: field ? p[field] ?? null : null }));
}

const memo = new WeakMap();  // the view's feature list -> Map(key -> comparison); derived, not state

// The comparison for the current view, or null (no baseline, or features not loaded yet).
export function comparison(s) {
  if (!active(s)) return null;
  const fc = sel.viewFeatures(s);
  if (!fc.length) return null;
  if (!memo.has(fc)) memo.set(fc, new Map());
  const key = `${s.baseline}|${s.baselineMode}|${sel.currentMetricId(s)}`;
  const cache = memo.get(fc);
  if (!cache.has(key)) {
    cache.set(key, core.compareWithBaseline(viewRows(s, fc), {
      baseCode: s.baseline, mode: s.baselineMode, minDenominator: config(s).min_denominator?.value ?? 0 }));
  }
  return cache.get(key);
}

// The area "Use as baseline" would pick: the one selected area of the view, if allowed.
export function candidate(s) {
  if (!config(s)) return null;
  const code = s.compare.on ? (s.compare.codes.length === 1 ? s.compare.codes[0] : null) : s.selected;
  if (!code || code === s.baseline) return null;
  const level = sel.levelOf(s, code);
  return level === sel.viewLevel(s) && config(s).levels.includes(level) ? code : null;
}

// --- formatting ----------------------------------------------------------------------

function formatDiff(s, diff) {
  if (!Number.isFinite(diff)) return "–";
  if (s.baselineMode === core.RELATIVE) {
    const sign = diff > 0 ? "+" : diff < 0 ? "−" : "";
    return `${sign}${formatNumber(Math.abs(diff), Math.abs(diff) < 10 ? 1 : 0)}%`;
  }
  const meta = sel.currentMetric(s);
  return signedDiff(diff, { ...meta, decimals: Math.min(meta.decimals, 2) });
}

const unsigned = (text) => text.replace(/^[+−]/, "");

// "vs baseline" line for the shared tooltip, or "".
export function tooltipLine(s, code) {
  const c = comparison(s);
  const entry = c?.byCode.get(code);
  if (!entry || entry.kind === core.BASE) return entry ? "<br><span>Baseline area</span>" : "";
  if (entry.kind === core.EXCLUDED) return "<br><span>vs baseline:</span> too few residents to compare";
  return `<br><span>vs baseline:</span> ${escapeHtml(formatDiff(s, entry.diff))}`;
}

// Dashed baseline line for ranked charts: {kind, value, name}, or null.
export function rankedLine(s, metricId) {
  if (!active(s)) return null;
  const value = sel.valueOf(s, s.baseline, metricId);
  return Number.isFinite(value) ? { kind: "baseline", value, name: `Baseline ${sel.placeName(s, s.baseline)}` } : null;
}

// --- legend ----------------------------------------------------------------------------

function swatch(tokenName, text, cls = "") {
  return `<div class="row"><i class="${cls}" style="background:var(--${tokenName})"></i>${escapeHtml(text)}</div>`;
}

// Legend HTML while a baseline is active, else null (legend.js draws the choropleth).
export function legendHtml(s) {
  const c = comparison(s);
  if (!c) return null;
  const meta = sel.currentMetric(s);
  const name = sel.placeName(s, s.baseline);
  const head = `<b>Compared with ${escapeHtml(name)}</b><span class="u">${escapeHtml(meta.label)}: ${escapeHtml(withUnit(c.baseValue, meta))}</span>`;
  const kinds = new Set([...c.byCode.values()].map((e) => e.kind));
  let rows;
  if (!c.baseValue) {
    rows = swatch("no-data", "Baseline value is zero or missing: nothing to compare");
  } else {
    const [a, b, , d] = c.thresholds.map((t) => formatDiff(s, t));
    rows = [
      swatch(CLASS_TOKENS[0], `more than ${unsigned(a)} below`),
      swatch(CLASS_TOKENS[1], `${unsigned(b)} to ${unsigned(a)} below`),
      swatch(CLASS_TOKENS[2], `within ±${unsigned(b)}`),
      swatch(CLASS_TOKENS[3], `${unsigned(b)} to ${unsigned(d)} above`),
      swatch(CLASS_TOKENS[4], `more than ${unsigned(d)} above`),
    ].join("");
  }
  rows += `<div class="row"><i class="base"></i>Baseline area</div>`;
  const md = config(s).min_denominator;
  if (kinds.has(core.EXCLUDED)) rows += swatch("no-data", `Fewer than ${formatNumber(md.value)} ${md.field === "pop" ? "residents" : md.field}`);
  if (c.baseValue && kinds.has(core.NO_DATA)) rows += swatch("no-data", "No value");
  const modes = config(s).modes;
  const seg = modes.length > 1 ? `<div class="seg" role="group" aria-label="Difference as">${modes.map((m) =>
    `<button type="button" data-baseline-mode="${m}" aria-pressed="${m === s.baselineMode}">${MODE_LABEL[m]}</button>`).join("")}</div>` : "";
  return head + rows + seg;
}

// --- panel box and breadcrumb chip ----------------------------------------------------------

export function boxHtml(s) {
  const level = sel.viewLevel(s);
  const word = sel.levelLabel(s, level).toLowerCase();
  const cand = candidate(s);
  const offer = cand ? `<button class="tool2 sm" type="button" data-baseline-set="${escapeHtml(cand)}">Use ${escapeHtml(sel.placeName(s, cand))} as baseline</button>` : "";
  if (active(s)) {
    return `<div class="basebox"><b>Baseline: ${escapeHtml(sel.placeName(s, s.baseline))}</b>
      The map shows every other ${escapeHtml(word)} as above or below it.
      <button class="tool2 sm" type="button" data-baseline-clear>Clear baseline</button> ${offer}</div>`;
  }
  return cand ? `<div class="basebox">${offer} Colour the map by how far every other ${escapeHtml(word)} is above or below it.</div>` : "";
}

function renderChip(s) {
  $("baseChip").innerHTML = active(s)
    ? `<span class="chip base">Baseline: ${escapeHtml(sel.placeName(s, s.baseline))}
       <button type="button" data-baseline-clear aria-label="Clear baseline">×</button></span>` : "";
}

// --- map -------------------------------------------------------------------------------

const OUTLINE = "baseline-outline";

// Map colours for the view's areas (MapLibre needs colour values, not CSS variables).
function shade(s, level) {
  const c = level === sel.viewLevel(s) ? comparison(s) : null;
  if (!c) return null;
  const tokenFor = (kind) => (kind === core.BASE ? "baseline-fill"
    : typeof kind === "number" ? CLASS_TOKENS[kind] : "no-data");
  return new Map([...c.byCode].map(([code, e]) => [code, token(tokenFor(e.kind))]));
}

export function initBaseline() {
  extendMap({
    // A function, not a constant: map.js and this module import each other.
    layers: () => [line(OUTLINE, SOURCE.view, "baseline", OUTLINE_WIDTH, { filter: codeIs(null) })],
    shade,
    shadeKey: (s) => (active(s) ? `${s.baseline}|${s.baselineMode}` : ""),
    render: (map, s, prev) => {
      if (prev && prev.baseline === s.baseline && prev.path === s.path) return;
      map.setFilter(OUTLINE, codeIs(active(s) ? s.baseline : null));
    },
  });
  document.addEventListener("click", (e) => {
    const set = e.target.closest("[data-baseline-set]");
    if (set) return dispatch({ type: "SET_BASELINE", code: set.dataset.baselineSet });
    if (e.target.closest("[data-baseline-clear]")) return dispatch({ type: "CLEAR_BASELINE" });
    const mode = e.target.closest("[data-baseline-mode]");
    if (mode) dispatch({ type: "SET_BASELINE_MODE", mode: mode.dataset.baselineMode });
    return undefined;
  });
  subscribe((s, prev) => {
    if (s.status !== "ready") return;
    if (!prev || prev.status !== "ready" || prev.baseline !== s.baseline || prev.path !== s.path) renderChip(s);
  });
}

