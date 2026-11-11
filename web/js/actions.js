// What clicking an area does, shared by the map and chart marks so both behave the same.
//   view area, first step (council areas)  open it
//   view area, deeper                      select it; click the selected one again to open it
//                                          (or deselect it when nothing is below)
//   grey context (another council area, another ward...)   open that one instead
//   the open area itself (its background between children) clears the selection
// While compare is on, a click on a view area adds or removes it instead (compare.js).
// A view area of a neighbouring area (e.g. an output area of the next ward) opens under its
// own parents, so the drill path always describes where it is.
import { getState, dispatch } from "./state.js";
import { compareClick } from "./compare.js";
import * as sel from "./selectors.js";

export function open(code) {
  dispatch({ type: "OPEN", path: [...sel.pathTo(getState(), code), code] });
}

export function activate(level, code) {
  const s = getState();
  if (level === sel.viewLevel(s)) {
    if (s.compare.on) return compareClick(code);
    if (sel.depth(s) === 0 && sel.canOpen(s)) return open(code);
    if (code !== s.selected) return dispatch({ type: "SELECT", code });
    return sel.canOpen(s) ? open(code) : dispatch({ type: "DESELECT" });
  }
  // Context: a sibling of an area on the path, at the step it sits on.
  const at = s.path.findIndex((_, i) => sel.steps(s)[i].level === level);
  if (at < 0) return undefined;
  if (code === s.path[at]) return dispatch({ type: "DESELECT" });
  if (s.compare.on) return compareClick(code);
  return dispatch({ type: "OPEN", path: [...s.path.slice(0, at), code] });
}

export const back = () => dispatch({ type: "BACK" });
