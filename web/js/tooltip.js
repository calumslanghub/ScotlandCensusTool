// One tooltip for map features and chart marks (#tip). Content comes from state; only the
// pointer position is passed in, since that is not application state.
import { getState } from "./state.js";
import { withUnit, formatNumber, escapeHtml } from "./format.js";
import { tooltipLine } from "./baseline.js";
import * as sel from "./selectors.js";

const OFFSET = 14;
const el = () => document.getElementById("tip");

function place(x, y) {
  const tip = el();
  tip.hidden = false;
  const { width, height } = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(x + OFFSET, innerWidth - width - 4)}px`;
  tip.style.top = `${y + OFFSET + height > innerHeight ? y - OFFSET - height : y + OFFSET}px`;
}

export function showHtml(x, y, html) {
  el().innerHTML = html;
  place(x, y);
}

// Feature tooltip: name, current metric value, residents.
export function showFeature(x, y, code) {
  const s = getState();
  const metric = sel.currentMetric(s);
  const info = sel.placeInfo(s, code);
  const value = sel.hasData(s, info?.level, metric.id)
    ? withUnit(sel.valueOf(s, code, metric.id), metric) : "no data at this level";
  const level = info ? sel.levelLabel(s, info.level) : "";
  showHtml(x, y, `<b>${escapeHtml(sel.placeName(s, code))}</b> <span>${escapeHtml(level)}</span><br>
    <span>${escapeHtml(metric.label)}:</span> ${escapeHtml(value)}<br>
    <span>Residents:</span> ${formatNumber(info?.pop)}${tooltipLine(s, code)}`);
}

// An overlay feature (not selectable): what it is and who lives there.
export function showOverlay(x, y, code) {
  const s = getState();
  const id = (sel.mapMode(s).overlays ?? []).find((o) => sel.overlayFeatures(s, o).some((f) => f.properties.code === code));
  const f = id && sel.overlayFeatures(s, id).find((g) => g.properties.code === code);
  if (!f) return hide();
  return showHtml(x, y, `<b>${escapeHtml(code)}</b> <span>${escapeHtml(sel.levelLabel(s, f.properties.level))}</span><br>
    <span>${escapeHtml(sel.overlayDef(s, id).label)}</span><br><span>Residents:</span> ${formatNumber(f.properties.pop)}`);
}

export function hide() {
  el().hidden = true;
}
