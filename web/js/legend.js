// Map legend for the level on screen: metric, unit, class breaks (low to high), an
// "Illustrative data" badge for synthetic metrics, and a toggle per overlay in this view
// (e.g. output areas outside any locality).
import { dispatch, subscribe } from "./state.js";
import { formatValue, formatNumber, escapeHtml } from "./format.js";
import { legendHtml as baselineLegend } from "./baseline.js";
import { legendHtml as queryLegend } from "./query.js";
import * as sel from "./selectors.js";

const CLASS_NAMES = { 4: "quartiles", 5: "quintiles", 10: "deciles" };

export const illustrativeBadge = () =>
  '<span class="illus" title="Invented values that show the layout, not Census 2022 figures">Illustrative data</span>';

function methodText(classes, requested) {
  if (classes.method === "jenks") return "natural breaks";
  return CLASS_NAMES[requested] ?? `${requested} quantile classes`;
}

function html(s) {
  const metric = sel.currentMetric(s);
  const level = sel.viewLevel(s);
  const plural = sel.levelPlural(s, level).toLowerCase();
  const head = `<b>${escapeHtml(metric.label)}</b>${sel.isIllustrative(metric) ? illustrativeBadge() : ""}`;
  const classes = sel.classesFor(s, level);
  if (!classes) {
    return `${head}<span class="u">No values for ${escapeHtml(plural)}</span>
      <div class="row"><i style="background:var(--no-data)"></i>No data at this level</div>`;
  }
  const rows = classes.bins.map((b) => `<div class="row"><i style="background:${b.color}"></i>
    ${formatValue(b.from, metric)} – ${formatValue(b.to, metric)}</div>`).join("");
  const unit = metric.unit ? `${escapeHtml(metric.unit)} · ` : "";
  const scope = `${formatNumber(classes.count)} ${plural}${classes.where === "Scotland" ? "" : ` in ${classes.where}`}`;
  return `${head}<span class="u">${unit}${methodText(classes, sel.currentIndicator(s).map.classes)} of all ${escapeHtml(scope)}</span>${rows}`;
}

// A checkbox row per overlay the mode offers at this view, with what it currently shows.
function overlayRows(s) {
  return (sel.mapMode(s).overlays ?? []).filter((id) => sel.overlayDef(s, id).at === sel.viewLevel(s)).map((id) => {
    const o = sel.overlayDef(s, id);
    const features = sel.overlayFeatures(s, id);
    const pop = features.reduce((sum, f) => sum + (f.properties.pop ?? 0), 0);
    const detail = s.overlays[id] && s.layer.status === "ready"
      ? ` <span class="u-inline">${formatNumber(features.length)} ${escapeHtml(sel.levelPlural(s, o.level).toLowerCase())}, ${formatNumber(pop)} residents</span>` : "";
    return `<label class="ovl"><input type="checkbox" data-overlay="${escapeHtml(id)}"${s.overlays[id] ? " checked" : ""}>
      <i class="outside"></i>${escapeHtml(o.label)}${detail}</label>`;
  }).join("");
}

const KEYS = ["indicatorId", "selectorChoice", "mapMode", "path", "baseline", "baselineMode", "layer", "overlays", "query"];

function render(s, prev) {
  if (s.status !== "ready") return;
  const first = !prev || prev.status !== "ready";
  if (!first && KEYS.every((k) => s[k] === prev[k])) return;
  const el = document.getElementById("legend");
  const query = queryLegend(s);
  el.innerHTML = query ?? (baselineLegend(s) ?? html(s)) + overlayRows(s);
  el.hidden = false;
}

export function initLegend() {
  const el = document.getElementById("legend");
  el.addEventListener("change", (e) => {
    if (e.target.dataset.overlay) dispatch({ type: "TOGGLE_OVERLAY", id: e.target.dataset.overlay });
  });
  subscribe(render);
}
