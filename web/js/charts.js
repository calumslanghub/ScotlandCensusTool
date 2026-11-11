// Chart.js renderers for ranked and profile panels, plus helpers shared with
// composition.js. Reference lines are chartjs-plugin-annotation lines; nothing is
// hand-drawn. Each renderer takes a canvas and a plain spec built from state, and reports
// pointer input through callbacks, so it never reads or writes application state.
// Colours in specs are token names (css/tokens.css).
import { ChartJS } from "./vendor.js";
import { token, withAlpha } from "./tokens.js";
import { formatNumber } from "./format.js";

const DASH = [6, 4];
const MARK_ALPHA = 0.8;
export const FADED_ALPHA = 0.4;
const EDGE = "chart-selected-edge";
const LINE_COLOR = { national: "chart-national", la: "chart-la", baseline: "chart-baseline" };

let defaultsSet = false;
export function setDefaults() {
  if (defaultsSet) return;
  ChartJS.defaults.font.family = token("font");
  ChartJS.defaults.font.size = 10;
  ChartJS.defaults.color = token("chart-text");
  ChartJS.defaults.borderColor = token("chart-grid");
  defaultsSet = true;
}

export function axisTick(metric) {
  return (v) => formatNumber(v, Number.isInteger(v) ? 0 : Math.min(metric.decimals || 1, 2));
}

// Log axes: label 1, 2 and 5 times a power of ten; grid lines only at powers of ten.
const mantissa = (v) => v / 10 ** Math.floor(Math.log10(v));
const isNice = (v, allowed) => allowed.some((m) => Math.abs(mantissa(v) - m) < 1e-9);

function logTick(metric) {
  const fmt = axisTick(metric);
  return (v) => (isNice(v, [1, 2, 5]) ? fmt(v) : "");
}

function hLine(line) {
  return { type: "line", yMin: line.value, yMax: line.value, borderColor: token(LINE_COLOR[line.kind]),
           borderWidth: 1.6, borderDash: DASH, drawTime: "beforeDatasetsDraw" };
}

// Short dashed segment across one category: a reference value for one row or bar.
export function segment(line, value, index, horizontal) {
  const span = { [horizontal ? "yMin" : "xMin"]: index - 0.42, [horizontal ? "yMax" : "xMax"]: index + 0.42 };
  const at = horizontal ? { xMin: value, xMax: value } : { yMin: value, yMax: value };
  return { type: "line", ...span, ...at, borderColor: token(LINE_COLOR[line.kind]), borderWidth: 2,
           borderDash: [4, 3] };
}

export function annotations(list) {
  return Object.fromEntries(list.filter((a) => Number.isFinite(a.yMin ?? a.xMin)).map((a, i) => [`ref${i}`, a]));
}

export function pointer(chart, cb) {
  return {
    onHover: (evt, elements) => {
      const el = elements[0];
      chart().canvas.style.cursor = el && cb.click ? "pointer" : "default";
      cb.hover(el ?? null, evt.native);
    },
    onClick: (_evt, elements) => {
      // A click can re-render the panel and destroy this chart; let Chart.js finish the
      // event first.
      const el = elements[0];
      if (el && cb.click) setTimeout(() => cb.click(el), 0);
    },
  };
}

export function bindLeave(chart, leave) {
  chart.canvas.addEventListener("mouseleave", leave);
}

export const finite = (values) => values.filter(Number.isFinite);

// --- ranked: one mark per child of the view, low to high -------------------------------
//
// spec: {items: [{code, value, highlight}], mark: dot|bar, scale: linear|log, metric,
//        lines: [{kind, value}], note}
//   highlight: a colour token for marks drawn on top with a dark outline (the selected
//   feature, or a compare area), or null.
// cb:   {hover(code|null, nativeEvent), click(code), leave()}
export function ranked(canvas, spec, cb) {
  setDefaults();
  const { items, metric } = spec;
  const n = items.length;
  const isBar = spec.mark === "bar";
  const all = finite([...items.map((i) => i.value), ...spec.lines.map((l) => l.value)]);
  const lo = Math.min(...all), hi = Math.max(...all);
  const radius = n > 80 ? 2.1 : n > 32 ? 2.7 : 3.4;
  const top = items.map((item, x) => ({ ...item, x })).filter((i) => i.highlight);
  const codeAt = (el) => (el.datasetIndex === 1 ? top[el.index].code : items[el.index].code);

  const datasets = isBar
    ? [{ data: items.map((i) => i.value), order: 1,
         backgroundColor: items.map((i) => token(i.highlight ?? "chart-mark")),
         borderColor: token(EDGE), borderWidth: items.map((i) => (i.highlight ? 1.5 : 0)),
         barPercentage: 0.9, categoryPercentage: 1 }]
    : [{ data: items.map((i, x) => ({ x, y: i.value })), order: 1,
         pointRadius: radius, pointHoverRadius: radius + 1.5,
         pointBackgroundColor: withAlpha("chart-mark", MARK_ALPHA), pointBorderWidth: 0 },
       { data: top.map((i) => ({ x: i.x, y: i.value })), order: 0,
         pointRadius: radius + 2.6, pointHoverRadius: radius + 3.2,
         pointBackgroundColor: top.map((i) => token(i.highlight)), pointBorderColor: token(EDGE),
         pointBorderWidth: 1.5 }];

  const y = spec.scale === "log"
    ? { type: "logarithmic", min: 10 ** Math.floor(Math.log10(Math.max(lo, 1e-3))),
        max: 10 ** Math.ceil(Math.log10(hi)), ticks: { callback: logTick(metric), autoSkip: false } }
    : isBar ? { type: "linear", beginAtZero: true, suggestedMax: hi, grace: "4%", ticks: { callback: axisTick(metric), maxTicksLimit: 6 } }
      : { type: "linear", beginAtZero: false, suggestedMin: lo, suggestedMax: hi, grace: "8%",
          ticks: { callback: axisTick(metric), maxTicksLimit: 6 } };
  y.grid = { color: spec.scale === "log"
    ? (c) => (isNice(c.tick.value, [1]) ? token("chart-grid") : withAlpha("chart-grid", 0))
    : token("chart-grid") };
  y.border = { color: token("chart-axis") };

  const x = {
    type: isBar ? "category" : "linear", min: isBar ? undefined : -0.5, max: isBar ? undefined : n - 0.5,
    ticks: { display: false }, grid: { display: false }, border: { color: token("chart-axis") },
    title: { display: true, text: spec.note, align: "start", color: token("chart-text"), padding: { top: 4 } },
  };

  let chart;
  chart = new ChartJS(canvas, {
    type: isBar ? "bar" : "scatter",
    data: { labels: isBar ? items.map((i) => i.code) : undefined, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      scales: { x, y },
      plugins: { legend: { display: false }, tooltip: { enabled: false },
                 annotation: { annotations: annotations(spec.lines.map(hLine)) } },
      ...pointer(() => chart, { hover: (el, e) => cb.hover(el ? codeAt(el) : null, e),
                                click: (el) => cb.click(codeAt(el)) }),
    },
  });
  bindLeave(chart, cb.leave);
  return chart;
}

// --- profile: each subject's value for each series --------------------------------------
//
// spec: {labels: [...], subjects: [{name, color, outlined, values: []}], metric,
//        lines: [{kind, values: []}]}
// cb:   {hover(index|null, nativeEvent), leave()}
export function profile(canvas, spec, cb) {
  setDefaults();
  const { subjects, metric } = spec;
  const all = finite([...subjects.flatMap((x) => x.values), ...spec.lines.flatMap((l) => l.values)]);
  let chart;
  chart = new ChartJS(canvas, {
    type: "bar",
    data: {
      labels: spec.labels,
      datasets: subjects.map((x) => ({
        data: x.values, label: x.name,
        backgroundColor: token(x.color), borderColor: token(EDGE), borderWidth: x.outlined ? 1.5 : 0,
        barPercentage: subjects.length > 1 ? 0.9 : 0.72, categoryPercentage: subjects.length > 1 ? 0.8 : 1,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { display: false }, border: { color: token("chart-axis") },
             ticks: { color: token("chart-label"), autoSkip: false, maxRotation: 0 } },
        y: { beginAtZero: true, suggestedMax: Math.max(...all), grace: "8%", grid: { color: token("chart-grid") },
             border: { display: false }, ticks: { callback: axisTick(metric), maxTicksLimit: 6 } },
      },
      plugins: {
        legend: { display: false }, tooltip: { enabled: false },
        annotation: { annotations: annotations(spec.lines.flatMap((l) =>
          l.values.map((v, i) => segment(l, v, i, false)))) },
      },
      ...pointer(() => chart, { hover: (el, e) => cb.hover(el ? el.index : null, e) }),
    },
  });
  bindLeave(chart, cb.leave);
  return chart;
}
