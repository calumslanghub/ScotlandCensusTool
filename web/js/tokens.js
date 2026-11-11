// Read design tokens (css/tokens.css) for code that cannot use CSS directly: MapLibre paint
// properties and Chart.js. Tokens are static, so values are cached after the first read.
const cache = new Map();

export function token(name) {
  if (!cache.has(name)) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
    if (!value) throw new Error(`Missing design token --${name} (css/tokens.css)`);
    cache.set(name, value);
  }
  return cache.get(name);
}

// A token colour at a given opacity, for canvas drawing (#rgb / #rrggbb tokens).
export function withAlpha(name, alpha) {
  const hex = token(name).replace("#", "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
