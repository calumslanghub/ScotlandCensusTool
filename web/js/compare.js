// Compare: a toggle in the breadcrumb bar. While on, clicking an area on the map or a chart
// mark adds or removes it from the compare set (explorer.compare.max_items, same level:
// only areas the view shows, e.g. the wards of the open council area, the output areas of
// the open ward and its neighbours, or council areas from the national view). Turning it on seeds the set with the current selection. The
// panel shows a table, charts show one coloured series per area, and the map outlines
// each area in its colour.
import { getState, dispatch, subscribe } from "./state.js";
import { extendMap, SOURCE, codeIs, line } from "./map.js";
import { formatNumber, withUnit, signedDiff, escapeHtml } from "./format.js";
import { COMPARE_COLOURS } from "./panel-parts.js";
import * as sel from "./selectors.js";

const $ = (id) => document.getElementById(id);
const config = (s) => s.explorer.compare;
const OUTLINE_WIDTH = 3.4;

// What a click does while compare is on (called by actions.activate).
export function compareClick(code) {
  const s = getState();
  const level = sel.viewLevel(s);
  if (!sel.childCodes(s).includes(code)) {
    const here = sel.openCode(s) ? ` in ${sel.placeName(s, sel.openCode(s))}` : "";
    dispatch({ type: "NOTICE", text: `Compare ${sel.levelPlural(s, level).toLowerCase()}${here}. Turn compare off to move around the map.` });
    return;
  }
  const max = config(s).max_items;
  if (!s.compare.codes.includes(code) && s.compare.codes.length >= max) {
    dispatch({ type: "NOTICE", text: `Compare up to ${max} areas. Click one to remove it.` });
    return;
  }
  dispatch({ type: "COMPARE_TOGGLE", code });
}

// --- right panel ---------------------------------------------------------------------

// Header, table and description replacing the summary cards while compare is on.
export function panelHtml(s) {
  const meta = sel.currentMetric(s);
  const level = sel.viewLevel(s);
  const plural = sel.levelPlural(s, level).toLowerCase();
  const n = s.compare.codes.length;
  const count = s.explorer.summary_cards.includes(meta.id);  // a count: no Scotland difference
  const scope = sel.openCode(s) ? `${sel.levelPlural(s, level)} in ${sel.placeName(s, sel.openCode(s))}` : sel.levelPlural(s, level);
  const rows = s.compare.codes.map((code, i) => {
    const v = sel.valueOf(s, code, meta.id);
    const diff = count ? "–" : signedDiff(v - sel.nationalValue(s, meta.id), meta);
    return `<tr><td><i class="c${i + 1}"></i>${escapeHtml(sel.placeName(s, code))}</td>
      <td>${formatNumber(sel.placeInfo(s, code)?.pop)}</td><td>${escapeHtml(withUnit(v, meta))}</td><td>${escapeHtml(diff)}</td></tr>`;
  }).join("");
  const table = n ? `<table class="cmp"><thead><tr><th>Area</th><th>Residents</th><th>${escapeHtml(meta.label)}</th>
    <th>vs Scotland</th></tr></thead><tbody>${rows}</tbody></table>` : "";
  const desc = n
    ? "Marks and bars take each area's colour. Click an area on the map, or a mark in a chart, to add or remove it."
    : `Click ${plural} on the map, or marks in a chart, to compare them.`;
  return `<h2 class="ptitle">Comparing ${n || ""} ${n === 1 ? sel.levelLabel(s, level).toLowerCase() : plural}</h2>
    <p class="psub">${escapeHtml(scope)} · up to ${config(s).max_items}</p>${table}<p class="desc">${escapeHtml(desc)}</p>`;
}

// --- breadcrumb toggle ------------------------------------------------------------------

function renderButton(s) {
  const btn = $("cmpBtn");
  btn.hidden = !config(s);
  btn.setAttribute("aria-pressed", String(s.compare.on));
  btn.textContent = `⇄ Compare${s.compare.on && s.compare.codes.length ? ` (${s.compare.codes.length})` : ""}`;
}

// --- map outlines ----------------------------------------------------------------------

const layerId = (i) => `compare-${i}`;

function layers() {
  return COMPARE_COLOURS.map((colour, i) => line(layerId(i), SOURCE.view, colour, OUTLINE_WIDTH, { filter: codeIs(null) }));
}

function renderOutlines(map, s, prev) {
  if (prev && prev.compare === s.compare) return;
  COMPARE_COLOURS.forEach((_, i) => map.setFilter(layerId(i), codeIs(s.compare.on ? s.compare.codes[i] ?? null : null)));
}

function render(s, prev) {
  if (s.status !== "ready") return;
  if (!prev || prev.status !== "ready" || prev.compare !== s.compare) renderButton(s);
}

export function initCompare() {
  $("cmpBtn").addEventListener("click", () =>
    dispatch({ type: "COMPARE_SET_ON", on: !getState().compare.on }));
  extendMap({ layers, render: renderOutlines });
  subscribe(render);
}
