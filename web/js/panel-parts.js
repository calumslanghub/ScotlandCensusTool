// Pieces shared by the right-panel chart builders (panel.js, composition.js): who a chart
// is about ("subjects"), its reference lines, legend items and series tooltips.
import { dispatch } from "./state.js";
import { withUnit, escapeHtml } from "./format.js";
import * as tooltip from "./tooltip.js";
import * as sel from "./selectors.js";

export const COMPARE_COLOURS = ["compare-1", "compare-2", "compare-3", "compare-4"];  // tokens

// Who series charts describe: the compare set (one colour each), else the selected
// feature (yellow, outlined), else Scotland.
export function subjects(s) {
  if (s.compare.on && s.compare.codes.length) {
    return s.compare.codes.map((code, i) => ({ code, name: sel.placeName(s, code),
      color: COMPARE_COLOURS[i], cls: `c${i + 1}`, outlined: false }));
  }
  const f = sel.focus(s);
  return f
    ? [{ code: f.code, name: sel.placeName(s, f.code), color: "chart-selected", cls: "sel", outlined: true }]
    : [{ code: null, name: "Scotland", color: "chart-mark", cls: "mark", outlined: false }];
}

// The level subjects sit at (NATIONAL for Scotland), for the reference-line rule.
export const subjectsLevel = (s, subs) => (subs[0].code ? sel.levelOf(s, subs[0].code) : sel.NATIONAL);

export const subjectValue = (s, subject, id) =>
  (subject.code ? sel.valueOf(s, subject.code, id) : sel.nationalValue(s, id));

// Subjects, reference lines and per-series values for a profile/composition panel.
export function seriesData(s, panel) {
  const subs = subjects(s);
  const lines = sel.referenceLines(s, panel, subjectsLevel(s, subs)).map((l) => ({
    ...l, values: panel.series.map((id) => sel.referenceValue(s, l, id)) }));
  const metas = panel.series.map((id) => sel.metricMeta(s, id));
  return { subs, lines, metas,
           values: subs.map((x) => panel.series.map((id) => subjectValue(s, x, id))) };
}

// --- legends -------------------------------------------------------------------------

export const legendItem = (cls, text, shape = "dot") =>
  `<span><i class="${shape} ${cls}"></i>${escapeHtml(text)}</span>`;

const LINE_CLASS = { [sel.NATIONAL]: "nat", [sel.LA_LINE]: "la", baseline: "base" };

// Dashed reference lines; with `meta`, each is named with its value.
export function lineLegend(s, lines, meta = null) {
  return lines.map((l) => legendItem(LINE_CLASS[l.kind],
    meta ? `${l.name ?? sel.referenceName(s, l)} ${withUnit(l.value, meta)}` : l.name ?? sel.referenceName(s, l),
    "dash")).join("");
}

export const subjectLegend = (subs) => subs.map((x) => legendItem(x.cls, x.name)).join("");

// --- tooltips --------------------------------------------------------------------------

export function seriesTip(s, data, i) {
  const meta = data.metas[i];
  const rows = data.subs.map((x, j) => `<br><span>${escapeHtml(x.name)}:</span> ${escapeHtml(withUnit(data.values[j][i], meta))}`);
  const refs = data.lines.map((l) => `<br><span>${escapeHtml(sel.referenceName(s, l))}:</span> ${escapeHtml(withUnit(l.values[i], meta))}`);
  return `<b>${escapeHtml(meta.label)}</b>${rows.join("")}${refs.join("")}`;
}

export const hoverSeries = (s, data, order = null) => (index, e) => (index == null ? tooltip.hide()
  : tooltip.showHtml(e.clientX, e.clientY, seriesTip(s, data, order ? order[index] : index)));

export const hoverFeature = (level) => (code, e) => {
  dispatch({ type: "HOVER", hover: code ? { level, code } : null });
  if (code) tooltip.showFeature(e.clientX, e.clientY, code);
  else tooltip.hide();
};

export const leaveFeature = () => {
  dispatch({ type: "HOVER", hover: null });
  tooltip.hide();
};
