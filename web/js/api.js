// Data access. Every request goes through fetchJson, which caches the promise per
// URL in memory: each file is downloaded once per page load, and concurrent requests
// share one download. This is a network cache, not app state (see state.js).
//
// Data files are pre-gzipped (<name>.gz) because `python -m http.server` does not
// compress. It serves them as application/gzip without Content-Encoding, so the
// browser does not decode them and we do, with DecompressionStream. A host that sends
// Content-Encoding: gzip has already decoded the body, so we check the gzip magic
// bytes (1f 8b) rather than trusting the file name.

const DATA_ROOT = "data/";
const MANIFEST = "manifest.json";
const cache = new Map();
const loaded = new Map();  // url -> parsed data, once a download has finished

const MAX_CONCURRENT = 6;
const RETRY_STATUS = new Set([429, 502, 503, 504]);
let active = 0;
const waiting = [];

function acquire() {
  return new Promise((resolve) => {
    if (active < MAX_CONCURRENT) { active++; resolve(); }
    else waiting.push(resolve);
  });
}

function release() {
  const next = waiting.shift();
  if (next) next();      // hand the slot straight to the next request
  else active--;
}

async function fetchWithRetry(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url);
    if (res.ok) return res;
    if (!RETRY_STATUS.has(res.status) || i === tries - 1) {
      throw new Error(`${url}: HTTP ${res.status}`);
    }
    // 400ms, 800ms, 1600ms (+ jitter) before trying again
    await new Promise((r) => setTimeout(r, 400 * 2 ** i + Math.random() * 200));
  }
}

async function download(url) {
  let bytes;
  await acquire();
  try {
    const res = await fetchWithRetry(url);
    bytes = new Uint8Array(await res.arrayBuffer());
  } finally {
    release();
  }
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = gzipped
    ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
    : new TextDecoder().decode(bytes);
  return JSON.parse(text);
}

export function fetchJson(path) {
  const url = DATA_ROOT + path;
  if (!cache.has(url)) {
    const promise = download(url).then((data) => {
      loaded.set(url, data);
      return data;
    }).catch((err) => {
      cache.delete(url);  // allow a retry after a failure
      throw err;
    });
    cache.set(url, promise);
  }
  return cache.get(url);
}

// Already-downloaded data, synchronously; null if it has not finished loading. Never fetches.
export const peekJson = (path) => loaded.get(DATA_ROOT + path) ?? null;

export const getManifest = () => fetchJson(MANIFEST);
export const getLAs = (manifest) => fetchJson(manifest.la_file);
export const getMetrics = (manifest) => fetchJson(manifest.metrics_file);
export const getExplorer = (manifest) => fetchJson(manifest.explorer_file);
export const getIndex = (manifest) => fetchJson(manifest.index_file);

// Columnar {fields, rows} -> array of objects.
export function indexRecords({ fields, rows }) {
  return rows.map((row) => Object.fromEntries(fields.map((f, i) => [f, row[i]])));
}
