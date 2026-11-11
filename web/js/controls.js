// Breadcrumb bar (Back + Scotland › each opened area › the selection), the map hint, and
// URL hash sync (#indicator=<id>&mode=<id>&path=<code>/<code>&selected=<code>) so browser
// Back/Forward also work.
import { getState, dispatch, subscribe } from "./state.js";
import { escapeHtml } from "./format.js";
import { back } from "./actions.js";
import * as sel from "./selectors.js";

const $ = (id) => document.getElementById(id);
let routing = false;  // the URL is only written once it has been read (startRouting)

function renderCrumbs(s) {
  const parts = [{ name: "Scotland", depth: 0 }];
  s.path.forEach((code, i) => parts.push({ name: sel.placeName(s, code), depth: i + 1 }));
  if (s.selected) parts.push({ name: sel.placeName(s, s.selected) });
  $("crumbs").innerHTML = parts.map((p, i) => {
    const here = i === parts.length - 1;
    return `${i ? '<span class="sep" aria-hidden="true">›</span>' : ""}<button class="crumb" type="button"
      ${here ? 'aria-current="page"' : `data-depth="${p.depth}"`}>${escapeHtml(p.name)}</button>`;
  }).join("");
  $("back").hidden = !s.path.length && !s.selected;
}

function renderHint(s) {
  const level = sel.viewLevel(s);
  const plural = sel.levelPlural(s, level).toLowerCase();
  let text;
  if (s.query.open && s.query.mode === "cluster") {
    text = s.query.cluster.run ? "Each colour is a cluster of similar areas. Click an area for its values."
      : "Cluster areas: choose variables on the left, compute the elbow, then run k-means.";
  } else if (s.query.open) {
    text = s.query.run ? "Darker areas meet more criteria; outlined ones meet all. Click one for its values."
      : "Find areas: build a query on the left, then Run.";
  } else if (s.compare.on) text = "Compare is on: click areas to add or remove them. Blank map clears.";
  else if (s.baseline) text = "Blue is above the baseline area, orange below. Grey: no comparison.";
  else if (sel.depth(s) === 0 && sel.canOpen(s)) {
    text = `Click a ${sel.levelLabel(s, level).toLowerCase()} to see its ${sel.levelPlural(s, sel.nextLevel(s)).toLowerCase()}.`;
  } else if (sel.canOpen(s)) {
    text = `Click one of the ${plural} to select it, again to see its ${sel.levelPlural(s, sel.nextLevel(s)).toLowerCase()}. Grey areas open others.`;
  } else text = `Click one of the ${plural} to select it.`;
  $("hint").textContent = text;
}

function render(s, prev) {
  if (s.status !== "ready") return;
  const first = !prev || prev.status !== "ready";
  if (first || s.path !== prev.path || s.selected !== prev.selected || s.mapMode !== prev.mapMode ||
      s.layer !== prev.layer) renderCrumbs(s);
  if (first || s.path !== prev.path || s.mapMode !== prev.mapMode || s.compare.on !== prev.compare.on ||
      s.baseline !== prev.baseline || s.query.open !== prev.query.open || s.query.run !== prev.query.run ||
      s.query.mode !== prev.query.mode || s.query.cluster.run !== prev.query.cluster.run) renderHint(s);
}

function onCrumb(e) {
  const crumb = e.target.closest("[data-depth]");
  if (crumb) dispatch({ type: "OPEN", path: getState().path.slice(0, Number(crumb.dataset.depth)) });
}

// --- URL hash ------------------------------------------------------------------

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { indicator: p.get("indicator"), mode: p.get("mode"),
           path: (p.get("path") ?? "").split("/").filter(Boolean), selected: p.get("selected") };
}

function hashFor(s) {
  const p = new URLSearchParams({ indicator: s.indicatorId, mode: s.mapMode });
  if (s.path.length) p.set("path", s.path.join("/"));
  if (s.selected) p.set("selected", s.selected);
  return `#${p}`;
}

// The URL is checked as far as the index can (council areas, wards, localities, data
// zones); deeper codes are checked when their files load.
function applyHash() {
  const s = getState();
  if (s.status !== "ready") return;
  const { indicator, mode, path, selected } = readHash();
  const modeId = s.explorer.map_modes.some((m) => m.id === mode) ? mode : s.mapMode;
  const steps = s.explorer.map_modes.find((m) => m.id === modeId).path;
  const valid = path.slice(0, steps.length - 1);
  const known = valid.findIndex((code, i) => s.places[code] && s.places[code].level !== steps[i].level);
  dispatch({ type: "NAVIGATE", indicatorId: indicator ?? s.indicatorId, mapMode: modeId,
             path: known >= 0 ? valid.slice(0, known) : valid, selected: known >= 0 ? null : selected });
}

function writeHash(s, prev) {
  if (!routing || s.status !== "ready" || prev.status !== "ready") return;
  const hash = hashFor(s);
  if (hash === location.hash) return;
  const moved = s.path !== prev.path || s.selected !== prev.selected || s.mapMode !== prev.mapMode;
  if (moved) history.pushState(null, "", hash);  // browser Back returns here
  else history.replaceState(null, "", hash);
}

// --------------------------------------------------------------------------------

export function initControls() {
  $("back").addEventListener("click", back);
  $("crumbs").addEventListener("click", onCrumb);
  window.addEventListener("popstate", applyHash);
  subscribe(render);
  subscribe(writeHash);
}

// Call once data has loaded: adopt the URL, then record it.
export function startRouting() {
  applyHash();
  routing = true;
  history.replaceState(null, "", hashFor(getState()));
}
