// Composition chart and category selector. `type: composition` draws one row per category:
// each subject's % as a bar (the selected area, or one colour per compare area), the
// Scotland and council-area averages as dashed ticks, rows sorted by the first subject's
// value. Clicking a row, or the map's Show dropdown (map.selector: category), sets which
// category shades the map.
import { dispatch, subscribe } from "./state.js";
import { ChartJS } from "./vendor.js";
import { token, withAlpha } from "./tokens.js";
import { escapeHtml } from "./format.js";
import { setDefaults, axisTick, segment, annotations, pointer, bindLeave, finite, FADED_ALPHA } from "./charts.js";
import { seriesData, subjectLegend, lineLegend, hoverSeries } from "./panel-parts.js";
import * as tooltip from "./tooltip.js";
import * as sel from "./selectors.js";

const ROW_HEIGHT = 18;      // px per bar within a row
const ROW_PADDING = 10;     // px between rows
const CHART_PADDING = 28;
const EDGE = "chart-selected-edge";

const setCategory = (metricId) => dispatch({ type: "SET_SELECTOR", metricId });

// --- chart -----------------------------------------------------------------------------
//
// spec: {rows: [{id, label, current}], subjects: [{name, color, outlined, values: []}],
//        metric, lines: [{kind, values: []}]}   (values in row order)
// cb:   {hover(index|null, nativeEvent), click(index), leave()}
function draw(canvas, spec, cb) {
  setDefaults();
  const { rows, subjects, metric } = spec;
  const all = finite([...subjects.flatMap((x) => x.values), ...spec.lines.flatMap((l) => l.values)]);
  let chart;
  chart = new ChartJS(canvas, {
    type: "bar",
    data: {
      labels: rows.map((r) => r.label),
      datasets: subjects.map((x) => ({
        data: x.values, label: x.name,
        backgroundColor: rows.map((r) => (r.current ? token(x.color) : withAlpha(x.color, FADED_ALPHA))),
        borderColor: token(EDGE), borderWidth: rows.map((r) => (x.outlined && r.current ? 1.5 : 0)),
        barPercentage: 0.82, categoryPercentage: 0.9,
      })),
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", axis: "y", intersect: false },
      scales: {
        x: { beginAtZero: true, suggestedMax: Math.max(...all), grace: "6%", grid: { color: token("chart-grid") },
             border: { display: false }, ticks: { callback: axisTick(metric), maxTicksLimit: 6 } },
        y: { grid: { display: false }, border: { color: token("chart-axis") },
             ticks: { autoSkip: false, font: (c) => ({ size: 11, weight: rows[c.index]?.current ? "bold" : "normal" }),
                      color: (c) => token(rows[c.index]?.current ? "blue" : "ink") } },
      },
      plugins: {
        legend: { display: false }, tooltip: { enabled: false },
        annotation: { annotations: annotations(spec.lines.flatMap((l) =>
          l.values.map((v, i) => segment(l, v, i, true)))) },
      },
      ...pointer(() => chart, { hover: (el, e) => cb.hover(el ? el.index : null, e),
                                click: (el) => cb.click(el.index) }),
    },
  });
  bindLeave(chart, cb.leave);
  return chart;
}

// --- panel -------------------------------------------------------------------------------

// Builder for panel.js: {legend, draw(canvas), height, note}.
export function compositionPanel(s, panel) {
  const data = seriesData(s, panel);
  if (!data.values.flat().some(Number.isFinite)) {
    const level = sel.focus(s)?.level ?? sel.viewLevel(s);
    return { legend: "", draw: null, note: `No values for ${sel.levelPlural(s, level).toLowerCase()}.` };
  }
  const first = data.values[0];
  const order = panel.series.map((_, i) => i).sort((a, b) => (first[b] ?? -Infinity) - (first[a] ?? -Infinity));
  const current = sel.topMetricId(s, sel.currentMetricId(s));  // a sub-category lights its parent's row
  const spec = {
    rows: order.map((i) => ({ id: panel.series[i], label: data.metas[i].label, current: panel.series[i] === current })),
    subjects: data.subs.map((x, j) => ({ ...x, values: order.map((i) => data.values[j][i]) })),
    lines: data.lines.map((l) => ({ ...l, values: order.map((i) => l.values[i]) })),
    metric: data.metas[0],
  };
  return {
    legend: subjectLegend(data.subs) + lineLegend(s, data.lines),
    draw: (canvas) => draw(canvas, spec, {
      hover: hoverSeries(s, data, order), leave: tooltip.hide,
      click: (i) => setCategory(spec.rows[i].id) }),
    height: order.length * (data.subs.length * ROW_HEIGHT + ROW_PADDING) + CHART_PADDING,
    note: "Click a row to map it.",
  };
}

// --- the map's Show dropdown ------------------------------------------------------------------

function renderSelector(s) {
  const indicator = sel.currentIndicator(s);
  const series = sel.selectorSeries(indicator);
  const box = document.getElementById("selbox");
  box.hidden = !series;
  if (!series) return;
  const current = sel.currentMetricId(s);
  const option = (id, label = sel.metricMeta(s, id).label) =>
    `<option value="${escapeHtml(id)}"${id === current ? " selected" : ""}>${escapeHtml(label)}</option>`;
  // A category with sub-categories becomes a group: itself first, then its children. Grouped
  // children (e.g. age bands, from a breakdown pie) are listed only while one is mapped.
  const html = series.filter((id) => !sel.metricMeta(s, id).parent).map((id) => {
    const grouped = sel.metricMeta(s, current)?.parent === id && sel.metricMeta(s, current).group ? [current] : [];
    const children = [...sel.childMetricIds(s, id), ...grouped].filter((c) => series.includes(c));
    if (!children.length) return option(id);
    return `<optgroup label="${escapeHtml(sel.metricMeta(s, id).label)}">${option(id, `All ${sel.metricMeta(s, id).label.toLowerCase()}`)}${children.map((c) => option(c)).join("")}</optgroup>`;
  }).join("");
  box.innerHTML = `<label for="selSel">Show</label><select id="selSel">${html}</select>`;
}

export function initComposition() {
  document.getElementById("selbox").addEventListener("change", (e) => {
    if (e.target.id === "selSel") setCategory(e.target.value);
  });
  subscribe((s, prev) => {
    if (s.status !== "ready") return;
    const first = !prev || prev.status !== "ready";
    if (first || s.indicatorId !== prev.indicatorId || s.selectorChoice !== prev.selectorChoice) renderSelector(s);
  });
}
