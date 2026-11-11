// MapLibre map: renders state (the drill path, shading, selection, hover, overlays) and
// turns pointer input into actions. Geometry lives only in MapLibre sources; files come
// from api.js (loaded by main.js) and every decision from state and selectors, so
// render() can always re-run from scratch.
//
// Sources, bottom to top:
//   basemap  raster tiles (explorer.basemap), under everything
//   base     council areas, grey context while one is open (click: open another)
//   ctx      siblings of the open area below council-area level (click: open another)
//   view     the areas the view shows, shaded by the current metric
//   overlay  e.g. output areas outside any locality
//   frame    council-area outlines over modes whose first step is not council areas
//   basemap-labels  raster place labels over the fills, at levels the basemap shows through
import { getState, dispatch, subscribe } from "./state.js";
import { getLAs } from "./api.js";
import { token, withAlpha } from "./tokens.js";
import { activate } from "./actions.js";
import * as tooltip from "./tooltip.js";
import * as sel from "./selectors.js";

/* global maplibregl */

const SOURCE = { base: "base", ctx: "ctx", view: "view", overlay: "overlay", frame: "frame" };
const BASEMAP = "basemap";
const LABELS = "basemap-labels";
const EMPTY = { type: "FeatureCollection", features: [] };
const FIT_PADDING = 36;
const ZOOM_MS = 800;
const NONE = "";  // filter value matching no feature code

let map;          // the MapLibre instance (a UI handle, not state)
let fitPending;   // the open area's bounds were unknown at the last fit (UI bookkeeping)

// Behaviour modules (compare, baseline, deselect) extend the map without reaching into it:
//   layers()               extra layer specs, drawn above the built-in ones
//   shade(s, level)        Map(code -> colour) replacing the choropleth for the view, or null
//   shadeKey(s)            string that changes whenever shade() would
//   render(map, s, prev)   update the extension's own layers after each state change
//   blankClick()           a click with no feature under the cursor
//   sources()              extra GeoJSON sources {id: spec} for its layers
//   exclusive(s)           true hides the built-in layers (the extension draws the whole map;
//                          the basemap stays)
//   pickLayers             its clickable layer ids, picked before the built-in ones
//   click(hit)             a click on one of them: hit = {level, code}
//   hover(hit, x, y)       the pointer over one of them, or hit = null when it leaves them
const extensions = [];
export const extendMap = (ext) => extensions.push(ext);

const isHover = ["boolean", ["feature-state", "hover"], false];
const codeIs = (code) => ["==", ["get", "code"], code ?? NONE];

function line(id, source, color, width, { filter, hoverOnly } = {}) {
  const paint = { "line-color": token(color), "line-width": width };
  if (hoverOnly) paint["line-opacity"] = ["case", isHover, 1, 0];
  return { id, type: "line", source, paint, ...(filter ? { filter } : {}) };
}

export { SOURCE, codeIs, line };

const fill = (id, source) => ({ id, type: "fill", source, paint: { "fill-color": token("no-data") } });

// Raster sources for explorer.basemap: the tiles and, if configured, their labels.
function basemapSources(b) {
  if (!b) return {};
  const raster = (tiles) => ({ type: "raster", tiles, tileSize: b.tile_size ?? 256,
                               maxzoom: b.max_zoom ?? 19, attribution: b.attribution });
  return { [BASEMAP]: raster(b.tiles), ...(b.label_tiles ? { [LABELS]: raster(b.label_tiles) } : {}) };
}

// Fills, then the basemap labels (if any) so outlines stay on top of them, then lines.
function styleLayers(sources) {
  const labels = sources[LABELS]
    ? [{ id: LABELS, type: "raster", source: LABELS, layout: { visibility: "none" } }] : [];
  return [
    ...(sources[BASEMAP] ? [{ id: BASEMAP, type: "raster", source: BASEMAP }] : []),
    fill("base-fill", SOURCE.base),
    fill("ctx-fill", SOURCE.ctx),
    fill("view-fill", SOURCE.view),
    { id: "overlay-fill", type: "fill", source: SOURCE.overlay,
      paint: { "fill-color": withAlpha("outside", Number(token("outside-fill-alpha"))) } },
    ...labels,
    line("base-line", SOURCE.base, "map-edge", 0.8),
    line("ctx-line", SOURCE.ctx, "map-edge", 0.6),
    line("view-line", SOURCE.view, "map-edge", 0.5),
    line("overlay-line", SOURCE.overlay, "outside", 0.8),
    line("frame-line", SOURCE.frame, "slate", 0.7),
    line("base-open", SOURCE.base, "map-la-outline", 1.8, { filter: codeIs(null) }),
    line("ctx-open", SOURCE.ctx, "map-la-outline", 1.6, { filter: codeIs(null) }),
    line("view-selected-outer", SOURCE.view, "map-select-outer", 3.2, { filter: codeIs(null) }),
    line("view-selected-inner", SOURCE.view, "map-select-inner", 1.4, { filter: codeIs(null) }),
    line("base-hover", SOURCE.base, "map-hover", 2.2, { hoverOnly: true }),
    line("ctx-hover", SOURCE.ctx, "map-hover", 2, { hoverOnly: true }),
    line("view-hover", SOURCE.view, "map-hover", 2, { hoverOnly: true }),
  ];
}

// Built-in layers an exclusive extension hides (everything but the background and basemap).
const BUILT_IN = () => styleLayers({}).map((l) => l.id);
const exclusive = (s) => extensions.some((e) => e.exclusive?.(s));

function setExclusive(s) {
  const hide = exclusive(s);
  for (const id of BUILT_IN()) map.setLayoutProperty(id, "visibility", hide ? "none" : "visible");
  if (hide) {
    if (map.getLayer(LABELS)) map.setLayoutProperty(LABELS, "visibility", "none");
  } else {
    setOpacity(s);
    setSources(s);
  }
}

// --- shading ------------------------------------------------------------------

function choropleth(s, codes) {
  const classes = sel.classesFor(s, sel.viewLevel(s));
  if (!classes || !codes.length) return token("no-data");
  const metricId = sel.currentMetricId(s);
  return ["match", ["get", "code"],
    ...codes.flatMap((c) => [c, classes.colorFor(sel.valueOf(s, c, metricId))]), token("no-data")];
}

// An extension's colours for the view, as a match expression, or null.
function override(s, codes) {
  for (const ext of extensions) {
    const colours = ext.shade?.(s, sel.viewLevel(s));
    if (colours) return ["match", ["get", "code"], ...codes.flatMap((c) => [c, colours.get(c) ?? token("no-data")]), token("no-data")];
  }
  return null;
}

// Grey context: the open area light, the one under the pointer darker, the rest grey.
const contextFill = (open) => ["case", codeIs(open), token("selected-la-fill"), isHover, token("ctx-hover"), token("ctx")];

// Opacity of the view's fills where the basemap shows through them (explorer.basemap
// fill_opacity for the view's level), else null: opaque, no labels.
const seeThrough = (s) => s.explorer.basemap?.fill_opacity?.[sel.viewLevel(s)] ?? null;

function setOpacity(s) {
  const see = seeThrough(s);
  const context = see == null ? 1 : s.explorer.basemap.context_opacity ?? see;
  map.setPaintProperty("view-fill", "fill-opacity", see ?? 1);
  map.setPaintProperty("ctx-fill", "fill-opacity", context);
  map.setPaintProperty("base-fill", "fill-opacity", context);
  if (map.getLayer(LABELS)) map.setLayoutProperty(LABELS, "visibility", see == null || exclusive(s) ? "none" : "visible");
}

function paint(s) {
  const codes = sel.childCodes(s);
  map.setPaintProperty("view-fill", "fill-color", codes.length ? override(s, codes) ?? choropleth(s, codes) : token("no-data"));
  map.setPaintProperty("base-fill", "fill-color", contextFill(s.path[0]));
  map.setPaintProperty("ctx-fill", "fill-color", contextFill(sel.openCode(s)));
  setOpacity(s);
  map.setFilter("base-open", codeIs(sel.depth(s) >= 1 ? s.path[0] : null));
  map.setFilter("ctx-open", codeIs(sel.depth(s) >= 2 ? sel.openCode(s) : null));
}

// --- data ----------------------------------------------------------------------

const collection = (features) => ({ type: "FeatureCollection", features });

function setSources(s) {
  const d = sel.depth(s);
  const baseIsLA = sel.steps(s)[0].level === sel.laLevel(s);
  map.getSource(SOURCE.view).setData(collection(sel.viewFeatures(s)));
  map.getSource(SOURCE.base).setData(d >= 1 ? collection(sel.stepFeatures(s, 0) ?? []) : EMPTY);
  map.getSource(SOURCE.ctx).setData(collection(sel.contextFeatures(s)));
  const overlays = (sel.mapMode(s).overlays ?? []).flatMap((id) => sel.overlayFeatures(s, id));
  map.getSource(SOURCE.overlay).setData(collection(overlays));
  map.setLayoutProperty("frame-line", "visibility", baseIsLA || exclusive(s) ? "none" : "visible");
}

// Timings for each view (performance measures, read by tests and devtools):
//   view-data:<mode>:<level>:<n>    request -> files fetched, decompressed and parsed (main.js)
//   view-draw:<mode>:<level>:<n>    features handed to MapLibre -> map idle
//   view-render:<mode>:<level>:<n>  request -> map idle (includes the zoom animation)
function measureRender(s) {
  const start = `view-start:${s.layer.key}`;
  if (!performance.getEntriesByName(start).length) return;
  const name = `${s.mapMode}:${sel.viewLevel(s)}:${sel.childCodes(s).length}`;
  const drawStart = `view-draw-start:${s.layer.key}`;
  performance.mark(drawStart);
  map.once("idle", () => {
    performance.measure(`view-draw:${name}`, drawStart);
    performance.measure(`view-render:${name}`, start);
    performance.clearMarks(start);
    performance.clearMarks(drawStart);
  });
}

function fit(s, first) {
  const code = sel.openCode(s);
  const home = code ? null : sel.homeBounds(s);
  fitPending = code ? !s.places[code]?.bbox && !sel.featureOf(s, code) : !home;
  map.fitBounds(code ? sel.placeBounds(s, code) : home ?? sel.scotlandBounds(s),
                { padding: FIT_PADDING, duration: first ? 0 : ZOOM_MS });
}

const shadingKey = (s) => [s.indicatorId, sel.currentMetricId(s), s.layer.key, s.layer.status,
  ...extensions.map((e) => e.shadeKey?.(s) ?? "")].join("|");

function render(s, prev) {
  if (s.status !== "ready") return;
  const first = !prev || prev.status !== "ready";
  const moved = first || s.mapMode !== prev.mapMode || s.path !== prev.path;
  const loaded = !first && s.layer !== prev.layer && s.layer.status === "ready";
  if (moved || (loaded && fitPending)) fit(s, first);
  if (moved || loaded || s.overlays !== prev.overlays) {
    if (loaded) measureRender(s);
    setSources(s);
  }
  if (moved || loaded || shadingKey(s) !== shadingKey(prev)) paint(s);
  if (moved || s.selected !== prev.selected) {
    map.setFilter("view-selected-outer", codeIs(s.selected));
    map.setFilter("view-selected-inner", codeIs(s.selected));
  }
  if (first || s.hover !== prev.hover) {
    if (prev) setHover(s, prev.hover, false);
    setHover(s, s.hover, true);
  }
  if (first || exclusive(s) !== exclusive(prev)) setExclusive(s);
  for (const ext of extensions) ext.render?.(map, s, first ? null : prev);
}

// Which source a hovered {level, code} lives in.
function sourceFor(s, level) {
  if (level === sel.viewLevel(s)) return SOURCE.view;
  if (sel.depth(s) >= 2 && level === sel.openLevel(s)) return SOURCE.ctx;
  if (sel.depth(s) >= 1 && level === sel.steps(s)[0].level) return SOURCE.base;
  return null;
}

function setHover(s, hover, on) {
  const source = hover && sourceFor(s, hover.level);
  if (source) map.setFeatureState({ source, id: hover.code }, { hover: on });
}

// --- input -------------------------------------------------------------------

const PICK = ["overlay-fill", "view-fill", "ctx-fill", "base-fill"];

// Hidden layers are never returned, so an exclusive extension's map picks only its own.
function topFeature(point) {
  const layers = [...extensions.flatMap((e) => e.pickLayers ?? []), ...PICK];
  const [f] = map.queryRenderedFeatures(point, { layers });
  if (!f) return null;
  return { overlay: f.layer.id === "overlay-fill", ext: extensions.find((e) => e.pickLayers?.includes(f.layer.id)),
           level: f.properties.level, code: f.properties.code };
}

function extHover(hit, x, y) {
  for (const ext of extensions) ext.hover?.(hit?.ext === ext ? { level: hit.level, code: hit.code } : null, x, y);
}

function onMove(e) {
  const hit = topFeature(e.point);
  const { clientX: x, clientY: y } = e.originalEvent;
  extHover(hit, x, y);
  if (hit?.ext) {
    dispatch({ type: "HOVER", hover: null });
    map.getCanvas().style.cursor = "pointer";
    return;
  }
  if (hit?.overlay) {
    dispatch({ type: "HOVER", hover: null });
    map.getCanvas().style.cursor = "";
    tooltip.showOverlay(x, y, hit.code);
    return;
  }
  dispatch({ type: "HOVER", hover: hit && { level: hit.level, code: hit.code } });
  map.getCanvas().style.cursor = hit ? "pointer" : "";
  if (hit) tooltip.showFeature(x, y, hit.code);
  else tooltip.hide();
}

function onLeave() {
  extHover(null);
  dispatch({ type: "HOVER", hover: null });
  tooltip.hide();
}

function onClick(e) {
  const hit = topFeature(e.point);
  if (hit?.ext) hit.ext.click?.({ level: hit.level, code: hit.code });
  else if (hit && !hit.overlay) activate(hit.level, hit.code);
  else for (const ext of extensions) ext.blankClick?.();
}

// --- setup -------------------------------------------------------------------

export async function initMap(container) {
  const s = getState();
  const las = await getLAs(s.manifest);
  const rasters = basemapSources(s.explorer.basemap);
  const sources = { ...rasters, ...Object.fromEntries(Object.values(SOURCE).map((id) =>
    [id, { type: "geojson", data: id === SOURCE.frame ? las : EMPTY, promoteId: "code" }])),
    ...Object.assign({}, ...extensions.map((e) => e.sources?.() ?? {})) };
  map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources,
      layers: [{ id: "background", type: "background", paint: { "background-color": token("map-bg") } },
               ...styleLayers(rasters), ...extensions.flatMap((e) => e.layers?.() ?? [])],
    },
    bounds: sel.scotlandBounds(s),
    fitBoundsOptions: { padding: FIT_PADDING },
    attributionControl: { compact: true, customAttribution: "Boundaries: NRS / Scottish Government, Census 2022" },
    dragRotate: false,
    doubleClickZoom: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.touchZoomRotate.disableRotation();

  await new Promise((resolve) => map.once("load", resolve));
  map.on("mousemove", onMove);
  map.on("mouseout", onLeave);
  map.on("click", onClick);
  render(getState(), null);
  subscribe(render);
  return map;
}
