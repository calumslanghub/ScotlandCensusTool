// Breakdown chart. `type: breakdown` is a pie of the sub-categories of the category chosen on
// the map (a composition row or the Show dropdown): flat -> purpose-built / converted /
// commercial. The category's `series` lists the parents that have children; the chosen
// category is its own parent when it has children, else its parent's. Clicking a slice
// maps that sub-category. Shows the selected area (or Scotland); slices are % of the
// whole universe, so they add up to the parent's share. `group` (e.g. age) shows the
// parent's children in that category group instead of its sub-types.
import { dispatch } from "./state.js";
import { ChartJS } from "./vendor.js";
import { token } from "./tokens.js";
import { setDefaults, finite } from "./charts.js";
import * as tooltip from "./tooltip.js";
import { escapeHtml, withUnit } from "./format.js";
import { subjects, subjectValue } from "./panel-parts.js";
import * as sel from "./selectors.js";

const SLICE_TOKENS = ["compare-1", "compare-2", "compare-3", "compare-4", "chart-mark", "slate"];
const HEIGHT = 230;

const setCategory = (metricId) => dispatch({ type: "SET_SELECTOR", metricId });

function draw(canvas, spec, cb) {
  setDefaults();
  let chart;
  chart = new ChartJS(canvas, {
    type: "doughnut",
    data: {
      labels: spec.labels,
      datasets: [{ data: spec.values, backgroundColor: spec.values.map((_, i) => token(SLICE_TOKENS[i % SLICE_TOKENS.length])),
                   borderColor: token("map-edge"), borderWidth: 1 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, cutout: "45%",
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      onHover: (e, els) => {
        e.native.target.style.cursor = els.length ? "pointer" : "";
        if (els.length) cb.hover(els[0].index, e.native);
        else cb.leave();
      },
      onClick: (e, els) => els.length && cb.click(els[0].index),
    },
  });
  chart.canvas.addEventListener("mouseleave", cb.leave);
  return chart;
}

// Builder for panel.js: {legend, draw(canvas), height, note}.
export function breakdownPanel(s, panel) {
  const parentId = sel.topMetricId(s, sel.currentMetricId(s));
  const childIds = panel.series.includes(parentId) ? sel.childMetricIds(s, parentId, panel.group) : [];
  if (!childIds.length) {
    const what = panel.group ? `a category with a breakdown by ${panel.group}` : "a category with sub-types";
    return { legend: "", draw: null, note: `Choose ${what} on the map (or in the chart above) to break it down.` };
  }
  const [subject] = subjects(s);
  const metas = childIds.map((id) => sel.metricMeta(s, id));
  const values = childIds.map((id) => subjectValue(s, subject, id));
  if (!finite(values).length) return { legend: "", draw: null, note: `No values for ${subject.name}.` };
  const legend = metas.map((m, i) =>
    `<span><i class="dot" style="background:${token(SLICE_TOKENS[i % SLICE_TOKENS.length])}"></i>${escapeHtml(m.short)} ${escapeHtml(withUnit(values[i], m))}</span>`).join("");
  const spec = { labels: metas.map((m) => m.short), values: values.map((v) => (Number.isFinite(v) ? v : 0)) };
  return {
    legend,
    height: HEIGHT,
    draw: (canvas) => draw(canvas, spec, {
      hover: (i, e) => tooltip.showHtml(e.clientX, e.clientY,
        `<b>${escapeHtml(metas[i].label)}</b><br><span>${escapeHtml(subject.name)}:</span> ${escapeHtml(withUnit(values[i], metas[i]))}`),
      leave: tooltip.hide,
      click: (i) => setCategory(childIds[i]),
    }),
    note: `${sel.metricMeta(s, parentId).label}: click a slice to map it.`,
  };
}
