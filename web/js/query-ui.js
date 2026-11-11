// Small HTML helpers shared by the Find areas builder (query.js) and its cluster mode
// (cluster.js): options, segmented buttons, a variable card's header, and CSV download.
import { escapeHtml } from "./format.js";
import * as sel from "./selectors.js";

export const lower = (text) => text.toLowerCase();
export const plural = (s, level, n = 2) => lower(n === 1 ? sel.levelLabel(s, level) : sel.levelPlural(s, level));

export const option = (value, label, selected, disabled = false) =>
  `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}${disabled ? " disabled" : ""}>${escapeHtml(label)}</option>`;

// A segmented control: one button per [id, label], data-<attr>=id and data-key=key.
export function seg(attr, key, items, current, disabled = false) {
  return `<div class="seg" role="group">${items.map(([id, label]) =>
    `<button type="button" data-${attr}="${id}" data-key="${key}" aria-pressed="${id === current}"${disabled ? " disabled" : ""}>${label}</button>`).join("")}</div>`;
}

// Header of a criterion / variable card: label, table and unit, remove button.
export function criterionHead(s, c) {
  const meta = sel.metricMeta(s, c.metricId);
  const ds = sel.datasetOf(s, c.metricId);
  const sub = [ds?.title ?? "Census", meta.unit].filter(Boolean).join(" · ");
  return `<div class="qhead"><div><b>${escapeHtml(meta.label)}</b><small>${escapeHtml(sub)}</small></div>
    <button type="button" class="qx" data-q-remove="${c.key}" aria-label="Remove ${escapeHtml(meta.label)}">×</button></div>`;
}

const csvCell = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

// Save rows (arrays, header first) as a CSV file.
export function downloadCsv(filename, rows) {
  const text = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
