// Right panel: title, summary cards (or the compare table), one-paragraph description,
// the drill-in and baseline buttons, then the current indicator's panels[] from
// explorer.json. Works at every level of every map mode (council area, ward, locality,
// output area, postcode, data zone). Rebuilt when the indicator, map category, view,
// selection, compare set or baseline changes; hover does not rebuild it. While "Find areas"
// is open, query.js owns the panel.
import { getState, subscribe } from "./state.js";
import { formatValue, formatNumber, signedDiff, escapeHtml } from "./format.js";
import { activate, open } from "./actions.js";
import { illustrativeBadge } from "./legend.js";
import { compositionPanel } from "./composition.js";
import { breakdownPanel } from "./breakdown.js";
import * as compare from "./compare.js";
import * as baseline from "./baseline.js";
import * as charts from "./charts.js";
import { seriesData, subjectLegend, lineLegend, legendItem, hoverSeries, hoverFeature, leaveFeature,
         COMPARE_COLOURS } from "./panel-parts.js";
import * as tooltip from "./tooltip.js";
import * as sel from "./selectors.js";

const SUMMARY_SLOTS = 4;

let live = [];  // Chart.js instances on screen (UI handles, not state)

const lower = (text) => text.toLowerCase();
const pct = (part, whole) => (part != null && whole ? formatNumber((part / whole) * 100, 1) : "–");
const popOf = (s, code) => sel.placeInfo(s, code)?.pop ?? null;

// The area a focus area sits in: the area opened before it (for a neighbouring area's child,
// its own parent), else its parent council area.
function parentOf(s, f) {
  const i = s.path.indexOf(f.code);
  const before = i > 0 ? s.path[i - 1] : i < 0 ? sel.pathTo(s, f.code).at(-1) : null;
  return before ?? sel.placeInfo(s, f.code)?.parent_code ?? null;
}

// --- header, cards, description -------------------------------------------------------

// The one council area every area of a national view lies in (e.g. community councils,
// Dumfries and Galloway only for now); null when the view spans several.
function viewCouncil(s) {
  if (sel.depth(s)) return null;
  const parents = new Set(sel.viewFeatures(s).map((x) => x.properties.parent_code));
  return parents.size === 1 ? [...parents][0] : null;
}

function header(s) {
  const f = sel.focus(s);
  let sub;
  if (f) {
    const parent = parentOf(s, f);
    const chain = [sel.levelLabel(s, f.level), parent && sel.placeName(s, parent), f.code].filter(Boolean);
    sub = chain.join(" · ");
  } else {
    const la = viewCouncil(s);
    sub = `${la ? sel.placeName(s, la) : "National view"} · ${formatNumber(sel.childCodes(s).length)} ` +
      lower(sel.levelPlural(s, sel.viewLevel(s)));
  }
  return `<h2 class="ptitle">${escapeHtml(f ? sel.placeName(s, f.code) : "Scotland")}</h2>
    <p class="psub">${escapeHtml(sub)}</p>`;
}

function card(label, value, detail = "", badge = "") {
  return `<div class="card"><div class="k">${escapeHtml(label)}</div><div class="v">${value}</div>
    <div class="d">${detail}${badge}</div></div>`;
}

function valueHtml(value, meta) {
  const text = formatValue(value, meta);
  if (text === "–" || !meta.unit) return text;
  return meta.unit === "%" ? `${text}%` : `${text} <small>${escapeHtml(meta.unit)}</small>`;
}

const focusValue = (s, f, id) => (f ? sel.valueOf(s, f.code, id) : sel.nationalValue(s, id));

// The card after the fixed summary cards: the mapped metric against Scotland; for a metric
// already shown above (a count), the area's share of its parent, or how many areas it holds.
function indicatorCard(s, f) {
  const meta = sel.currentMetric(s);
  if (!s.explorer.summary_cards.includes(meta.id)) {
    const value = focusValue(s, f, meta.id);
    const detail = !f ? "Scotland"
      : Number.isFinite(value) ? `${escapeHtml(signedDiff(value - sel.nationalValue(s, meta.id), meta))} vs Scotland`
        : `No data for ${escapeHtml(lower(sel.levelPlural(s, f.level)))}`;
    return card(meta.label, valueHtml(value, meta), detail, sel.isIllustrative(meta) ? ` ${illustrativeBadge()}` : "");
  }
  if (s.selected) {
    const parent = parentOf(s, f);
    return parent
      ? card(`Share of ${sel.placeName(s, parent)}`, `${pct(popOf(s, f.code), popOf(s, parent))}%`, "of residents")
      : card("Share of Scotland", `${pct(popOf(s, f.code), sel.nationalPop(s))}%`, "of residents");
  }
  return card(sel.levelPlural(s, sel.viewLevel(s)), formatNumber(sel.ownCodes(s).length),
    f ? `in ${escapeHtml(sel.placeName(s, f.code))}` : "in Scotland");
}

function cards(s) {
  const f = sel.focus(s);
  const fixed = s.explorer.summary_cards.slice(0, SUMMARY_SLOTS - 1).map((id) => {
    const meta = sel.metricMeta(s, id);
    return card(meta.label, valueHtml(focusValue(s, f, id), meta), "",
      sel.isIllustrative(meta) ? illustrativeBadge() : "");
  });
  return `<div class="cards">${[...fixed, indicatorCard(s, f)].join("")}</div>`;
}

function description(s) {
  const f = sel.focus(s);
  const view = sel.viewLevel(s);
  const n = sel.ownCodes(s).length;
  const viewWord = lower(n === 1 ? sel.levelLabel(s, view) : sel.levelPlural(s, view));
  if (!f) {
    const action = sel.canOpen(s) ? `to see its ${lower(sel.levelPlural(s, sel.nextLevel(s)))}` : "to select it";
    const la = viewCouncil(s);
    const residents = la ? sel.ownCodes(s).reduce((sum, c) => sum + (popOf(s, c) ?? 0), 0) : sel.nationalPop(s);
    return `${formatNumber(residents)} residents across ${formatNumber(n)} ${viewWord}` +
      `${la ? ` in ${sel.placeName(s, la)}` : ""}. ` +
      `Click a ${lower(sel.levelLabel(s, view))} on the map, or a mark in a chart, ${action}.`;
  }
  const parent = parentOf(s, f);
  const share = parent ? ` (${pct(popOf(s, f.code), popOf(s, parent))}% of ${sel.placeName(s, parent)})`
    : ` (${pct(popOf(s, f.code), sel.nationalPop(s))}% of Scotland)`;
  const name = sel.placeName(s, f.code);
  if (s.selected) {
    const more = sel.canOpen(s) ? ` Click it again to see its ${lower(sel.levelPlural(s, sel.nextLevel(s)))}.` : "";
    return `${name} is a ${lower(sel.levelLabel(s, f.level))}, home to ${formatNumber(popOf(s, f.code))} residents${share}.${more}`;
  }
  return `${name} has ${formatNumber(popOf(s, f.code))} residents${share}. It holds ${formatNumber(n)} ${viewWord}: ` +
    `click one on the map, or a mark in a chart, to select it.${neighbourNote(s)}`;
}

// "Also shown: ..." while the view includes the children of neighbouring areas.
function neighbourNote(s) {
  const n = sel.neighbourCodes(s).length;
  if (!n) return "";
  const word = lower(n === 1 ? sel.levelLabel(s, sel.openLevel(s)) : sel.levelPlural(s, sel.openLevel(s)));
  return ` The ${lower(sel.levelPlural(s, sel.viewLevel(s)))} of the ${formatNumber(n)} neighbouring ${word} are shown too.`;
}

function drillButton(s) {
  if (!s.selected || !sel.canOpen(s) || s.compare.on) return "";
  return `<button class="tool2 sm drill" type="button" data-open="${escapeHtml(s.selected)}">
    Show its ${escapeHtml(lower(sel.levelPlural(s, sel.nextLevel(s))))} ›</button>`;
}

function summary(s) {
  if (s.compare.on) return compare.panelHtml(s);
  return `${header(s)}${cards(s)}<p class="desc">${escapeHtml(description(s))} ${drillButton(s)}</p>`;
}

function panelMetricIds(s, panel) {
  return panel.type === "ranked" ? [sel.currentMetricId(s)] : panel.series;
}

function illustrativeNote(s, indicator) {
  const ids = [sel.currentMetricId(s), ...indicator.panels.flatMap((p) => panelMetricIds(s, p))];
  if (!ids.some((id) => sel.isIllustrative(sel.metricMeta(s, id)))) return "";
  return `<p class="illus-note">${illustrativeBadge()} ${escapeHtml(s.metrics.synthetic_note ?? "")}</p>`;
}

// --- panels --------------------------------------------------------------------------

// Highlight colour for a ranked mark: its compare colour, yellow when selected, or none.
function highlight(s, code) {
  if (s.compare.on) {
    const i = s.compare.codes.indexOf(code);
    return i >= 0 ? COMPARE_COLOURS[i] : null;
  }
  return code === s.selected ? "chart-selected" : null;
}

function rankedPanel(s, panel) {
  const metricId = sel.currentMetricId(s);
  const meta = sel.metricMeta(s, metricId);
  const level = sel.viewLevel(s);
  const items = sel.childCodes(s)
    .map((code) => ({ code, value: sel.valueOf(s, code, metricId), highlight: highlight(s, code) }))
    .filter((i) => Number.isFinite(i.value))
    .sort((a, b) => a.value - b.value);
  if (!items.length) {
    const why = s.layer.status === "ready" ? `No ${lower(meta.label)} values for ${lower(sel.levelPlural(s, level))}.` : "Loading…";
    return { legend: "", draw: null, note: why };
  }
  const lines = sel.referenceLines(s, panel)
    .map((l) => ({ ...l, value: sel.referenceValue(s, l, metricId) }))
    .filter((l) => Number.isFinite(l.value));
  const base = baseline.rankedLine(s, metricId);
  if (base) lines.push(base);
  const marked = s.compare.on
    ? s.compare.codes.map((code, i) => legendItem(`c${i + 1}`, sel.placeName(s, code))).join("")
    : items.filter((i) => i.highlight).map((i) => legendItem("sel", sel.placeName(s, i.code))).join("");
  const own = new Set(sel.ownCodes(s));
  const near = items.filter((i) => !own.has(i.code)).length;
  const nearNote = near ? ` (${formatNumber(near)} in neighbouring ${lower(sel.levelPlural(s, sel.openLevel(s)))})` : "";
  const spec = { items, metric: meta, mark: panel.mark, scale: panel.scale, lines,
                 note: `${formatNumber(items.length)} ${lower(sel.levelPlural(s, level))}${nearNote}, ranked low to high` };
  return {
    legend: legendItem("mark", sel.levelLabel(s, level)) + marked + lineLegend(s, lines, meta),
    draw: (canvas) => charts.ranked(canvas, spec, {
      hover: hoverFeature(level), click: (code) => activate(level, code), leave: leaveFeature }),
  };
}

function profilePanel(s, panel) {
  const data = seriesData(s, panel);
  if (!data.values.flat().some(Number.isFinite)) {
    return { legend: "", draw: null, note: `No values for ${lower(sel.levelPlural(s, sel.focus(s)?.level ?? sel.viewLevel(s)))}.` };
  }
  const spec = { labels: data.metas.map((m) => m.short), metric: data.metas[0], lines: data.lines,
                 subjects: data.subs.map((x, j) => ({ ...x, values: data.values[j] })) };
  return {
    legend: subjectLegend(data.subs) + lineLegend(s, data.lines),
    draw: (canvas) => charts.profile(canvas, spec, { hover: hoverSeries(s, data), leave: tooltip.hide }),
  };
}

const PANELS = { ranked: rankedPanel, profile: profilePanel, composition: compositionPanel,
                 breakdown: breakdownPanel };

function panelTitle(s, panel) {
  return panel.title.replace("{children}", lower(sel.levelLabel(s, sel.viewLevel(s))))
    .replace("{metric}", sel.currentMetric(s).label);
}

// Source line for a Census-table indicator: table, who is counted, and any assumption.
function datasetNote(s, indicator) {
  const ds = sel.datasetOf(s, indicator.metric);
  if (!ds) return "";
  const note = ds.note ? ` ${ds.note}` : "";
  return `<p class="foot">${escapeHtml(`${ds.table} ${ds.title}. Counts ${ds.universe.toLowerCase()}.${note} ${ds.citation}`)}</p>`;
}

// --- render --------------------------------------------------------------------------

const KEYS = ["indicatorId", "selectorChoice", "mapMode", "path", "selected", "layer", "compare",
              "baseline", "baselineMode"];

function render(s, prev) {
  if (s.status !== "ready") return;
  const first = !prev || prev.status !== "ready";
  const querying = s.query.open;
  if (!first && KEYS.every((k) => s[k] === prev[k]) && querying === prev.query.open) return;
  if (querying) {
    for (const c of live) c.destroy();
    live = [];
    return;
  }

  const indicator = sel.currentIndicator(s);
  const built = indicator.panels.map((p) => ({ panel: p, ...PANELS[p.type](s, p) }));
  for (const c of live) c.destroy();
  tooltip.hide();

  const sections = built.map((b, i) => {
    const synthetic = panelMetricIds(s, b.panel).some((id) => sel.isIllustrative(sel.metricMeta(s, id)));
    const height = b.height ? ` style="height:${b.height}px"` : "";
    const chart = b.draw
      ? `<div class="chart"${height}><canvas id="chart-${i}" role="img" aria-label="${escapeHtml(panelTitle(s, b.panel))}"></canvas></div>` : "";
    return `<section class="pnl"><h3>${escapeHtml(panelTitle(s, b.panel))}${synthetic ? illustrativeBadge() : ""}</h3>
      <div class="leg">${b.legend}</div>${chart}
      ${b.note ? `<p class="chart-note">${escapeHtml(b.note)}</p>` : ""}</section>`;
  }).join("");

  const panel = document.getElementById("panel");
  panel.innerHTML = `<div class="pin">${summary(s)}${baseline.boxHtml(s)}
    ${illustrativeNote(s, indicator)}${sections}${datasetNote(s, indicator)}
    <p class="foot">Dashed reference lines show only levels broader than the chart, and are left off counts. ${escapeHtml(s.metrics.note)}</p></div>`;
  live = built.map((b, i) => b.draw?.(document.getElementById(`chart-${i}`))).filter(Boolean);
}

export function initPanel() {
  const panel = document.getElementById("panel");
  subscribe(render);
  panel.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-open]");
    if (btn) open(btn.dataset.open);
  });
  // Leaving the panel always clears the shared tooltip and map hover.
  panel.addEventListener("mouseleave", () => getState().hover && leaveFeature());
}
