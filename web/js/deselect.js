// Deselect: clicking blank map (no feature under the cursor) clears the selection and any
// compare set, without moving the map. Esc clears compare, else the baseline, else steps
// back one level. While "Find areas" is open, Esc clears its selection, then closes it.
import { getState, dispatch } from "./state.js";
import { extendMap } from "./map.js";

export function escape() {
  const s = getState();
  if (s.status !== "ready") return;
  if (s.query.open) dispatch({ type: s.query.selected ? "QUERY_SELECT" : "QUERY_CLOSE", code: null });
  else if (s.compare.on) dispatch({ type: "COMPARE_SET_ON", on: false });
  else if (s.baseline) dispatch({ type: "CLEAR_BASELINE" });
  else dispatch({ type: "BACK" });
}

export function initDeselect() {
  extendMap({ blankClick: () => dispatch({ type: "DESELECT" }) });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) escape();
  });
}
