"""Geometry helpers shared by build steps."""
from __future__ import annotations

import numpy as np
import shapely


def valid_polygons(geoms: np.ndarray) -> np.ndarray:
    """Repair invalid geometries (only those), keeping only polygonal parts."""
    geoms = np.asarray(geoms, dtype=object).copy()
    invalid = ~shapely.is_valid(geoms) & ~shapely.is_missing(geoms)
    geoms[invalid] = shapely.make_valid(geoms[invalid], method="structure", keep_collapsed=False)
    return geoms


def vertex_count(geoms: np.ndarray) -> int:
    return int(shapely.get_num_coordinates(np.asarray(geoms, dtype=object)).sum())
