// Top tabs, left indicator list, map-view toggle and the notice. Everything is built from
// explorer.json and metrics.json; no indicator, label or chart type is named here.
import { getState, dispatch, subscribe } from "./state.js";
import { escapeHtml } from "./format.js";
import * as sel from "./selectors.js";

const $ = (id) => document.getElementById(id);
const NOTICE_MS = 3800;

function renderTabs(s) {
  $("cats").innerHTML = s.explorer.categories.map((c) =>
    `<button class="cat" role="tab" type="button" aria-selected="${c.id === s.categoryId}"
       data-category="${escapeHtml(c.id)}">${escapeHtml(c.label)}</button>`).join("");
}

function indicatorSubtitle(s, indicator) {
  if (sel.selectorSeries(indicator)) return "choose a category on the map";
  const m = sel.metricMeta(s, indicator.metric);
  return m.unit ? `${m.label} · ${m.unit}` : m.label;
}

function renderList(s) {
  const category = sel.currentCategory(s);
  $("sbCat").textContent = category.label;
  $("sbList").innerHTML = category.indicators.map((i) =>
    `<button class="item" type="button" aria-current="${i.id === s.indicatorId}" data-indicator="${escapeHtml(i.id)}">
       ${escapeHtml(i.label)}<small>${escapeHtml(indicatorSubtitle(s, i))}</small></button>`).join("");
}

function renderModes(s) {
  $("modes").innerHTML = (s.explorer.map_modes ?? []).map((m) =>
    `<button class="geo-btn" type="button" aria-pressed="${m.id === s.mapMode}"
       data-mode="${escapeHtml(m.id)}">${escapeHtml(m.label)}</button>`).join("");
}

function renderBadge(s) {
  const synthetic = s.metrics.metrics.some(sel.isIllustrative);
  $("dataBadge").textContent = synthetic
    ? "Census 2022 boundaries. Values marked Illustrative data are invented."
    : "Census 2022";
}

let noticeTimer;  // UI timer handle, not state
function renderNotice(s) {
  const el = $("notice");
  const text = s.status === "error" ? `Could not load data: ${s.error}`
    : s.layer.status === "error" ? `Could not load map data: ${s.layer.error}`
    : s.notice?.text ?? "";
  el.textContent = text;
  el.hidden = !text;
  clearTimeout(noticeTimer);
  if (s.notice && text === s.notice.text) {
    noticeTimer = setTimeout(() => dispatch({ type: "NOTICE", text: null }), NOTICE_MS);
  }
}

function render(s, prev) {
  if (s.status === "error" || prev?.notice !== s.notice || prev?.layer !== s.layer) renderNotice(s);
  if (s.status !== "ready") return;
  const first = !prev || prev.status !== "ready";
  if (first) {
    renderModes(s);
    renderBadge(s);
  }
  if (first || s.categoryId !== prev.categoryId) renderTabs(s);
  if (first || s.categoryId !== prev.categoryId || s.indicatorId !== prev.indicatorId) renderList(s);
  if (first || s.mapMode !== prev.mapMode) renderModes(s);
}

function onClick(e) {
  const tab = e.target.closest("[data-category]");
  if (tab) return dispatch({ type: "SELECT_CATEGORY", categoryId: tab.dataset.category });
  const item = e.target.closest("[data-indicator]");
  if (item) return dispatch({ type: "SELECT_INDICATOR", indicatorId: item.dataset.indicator });
  const mode = e.target.closest("[data-mode]");
  if (mode) return dispatch({ type: "SET_MAP_MODE", mode: mode.dataset.mode });
  return undefined;
}

export function initNav() {
  for (const id of ["cats", "sbList", "modes"]) $(id).addEventListener("click", onClick);
  subscribe(render);
}
