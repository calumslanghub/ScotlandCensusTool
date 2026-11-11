// Entry point: wire modules to the store, load data, start.
import { dispatch, subscribe, getState } from "./state.js";
import { getManifest, getMetrics, getExplorer, getIndex, fetchJson, indexRecords } from "./api.js";
import { initMap } from "./map.js";
import { initLegend } from "./legend.js";
import { initNav } from "./nav.js";
import { initPanel } from "./panel.js";
import { initControls, startRouting } from "./controls.js";
import { initDeselect } from "./deselect.js";
import { initCompare } from "./compare.js";
import { initBaseline } from "./baseline.js";
import { initComposition } from "./composition.js";
import { initQuery } from "./query.js";
import * as sel from "./selectors.js";

// Load the files the view needs (lazily; api.js caches each file) whenever the view
// changes, and mark the start so map.js can measure the time to draw it.
// Deferred: dispatching from inside a listener would hand later listeners stale diffs.
function loadView() {
  queueMicrotask(startLoad);
}

function startLoad() {
  const s = getState();
  if (s.status !== "ready") return;
  const key = sel.viewKey(s);
  if (key === s.layer.key) return;
  performance.mark(`view-start:${key}`);
  dispatch({ type: "LAYER_LOADING", key });
  Promise.all(sel.requiredFiles(s).map(fetchJson))
    .then(() => {
      performance.measure(`view-data:${s.mapMode}:${sel.viewLevel(s)}`, `view-start:${key}`);
      dispatch({ type: "LAYER_LOADED", key });
    })
    .catch((err) => dispatch({ type: "LAYER_FAILED", key, error: err.message }));
}

async function start() {
  initNav();
  initControls();
  initLegend();
  initPanel();
  // Behaviours: each registers its own map extension and listeners before the map exists.
  initDeselect();
  initCompare();
  initBaseline();
  initComposition();
  initQuery();
  subscribe(loadView);

  const manifest = await getManifest();
  const [metrics, explorer, index] = await Promise.all(
    [getMetrics(manifest), getExplorer(manifest), getIndex(manifest)]);
  const places = Object.fromEntries(indexRecords(index).map((p) => [p.code, p]));
  dispatch({ type: "LOADED", manifest, metrics, explorer, places });
  await initMap(document.getElementById("map"));
  startRouting();
  const s = getState();
  console.info(`Census Explorer ready: ${Object.keys(places).length} places, ` +
               `${s.explorer.categories.length} tabs, indicator ${s.indicatorId}`);
}

start().catch((err) => {
  console.error(err);
  dispatch({ type: "FAILED", error: err.message });
});
