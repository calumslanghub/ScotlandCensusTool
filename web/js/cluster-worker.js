// Web Worker for "Cluster areas": runs cluster-core.js off the main thread so the page stays
// responsive. Messages in: {task: "elbow" | "run", X, n, d, kMax | k, opts}. Messages out:
// {type: "progress", done, total}, then {type: "done", ...} or {type: "error", message}.
import * as core from "./cluster-core.js";

self.onmessage = ({ data }) => {
  const { task, X, n, d, opts } = data;
  try {
    if (task === "elbow") {
      const out = core.elbow(X, n, d, data.kMax, opts, (done, total) => self.postMessage({ type: "progress", done, total }));
      self.postMessage({ type: "done", ...out });
    } else if (task === "run") {
      self.postMessage({ type: "progress", done: 0, total: 1 });
      const out = core.cluster(X, n, d, data.k, opts);
      self.postMessage({ type: "done", ...out }, [out.labels.buffer, out.centres.buffer]);
    } else {
      throw new Error(`Unknown task ${task}`);
    }
  } catch (err) {
    self.postMessage({ type: "error", message: err.message });
  }
};
