// Third-party code, pinned in one place. MapLibre GL JS, Chart.js and
// chartjs-plugin-annotation are classic scripts in index.html (globals): the plugin's UMD
// build binds to the global Chart, so importing Chart.js again as a module would give
// two copies. Everything else is an ES module.
export { quantile, jenks } from "https://cdn.jsdelivr.net/npm/simple-statistics@7.8.3/+esm";
export * as chromatic from "https://cdn.jsdelivr.net/npm/d3-scale-chromatic@3.1.0/+esm";

/* global Chart */
export const ChartJS = Chart;
export const annotationPlugin = globalThis["chartjs-plugin-annotation"];
ChartJS.register(annotationPlugin);
