# Census Explorer

Reusable spatial navigation shell for Scottish Census 2022 geographies.
Python build pipeline -> static files -> vanilla JS front end (MapLibre GL JS + Chart.js).
No server-side runtime: `python -m http.server` in `web/` (with data/processed served) must work.

## Hard rules
- Source CRS is EPSG:27700. Output GeoJSON is EPSG:4326, coordinates rounded to 5 dp.
  Exception: a level may declare its own `crs` in levels.yaml (community councils: EPSG:4326 GeoJSON); it is reprojected to 27700 on read.
- Never edit data/raw. Build is idempotent: `python -m build.run` regenerates data/processed.
- All field names and paths come from config/*.yaml. No hard-coded column names in code.
- Common schema for every level: code, name, level, parent_code, pop, households, area_km2.
- data/lookups/OA_TO_HIGHER_AREAS.csv is the hierarchy source of truth: OA2022 -> CA2019 (LA), CLOC2022 (locality).
- Locality parent LA = LA holding the majority of its OAs; store la_codes_all for the 6 straddlers.
- 3,984 OAs have no locality (CLOC2022 null): keep them, never drop silently.
- The lookup's DZ2011 does NOT match SG_DataZone_Bdry_2022 (zero shared codes). DZ2022 for each OA = OA representative point within DZ polygon. DZ2011/IZ2011/SIMD2020 are attributes only.
- Postcode->OA is a spatial join (representative point). `masterpc` is NOT a lookup.
- OA->community council (Dumfries and Galloway only) = the CC covering the largest share of the OA's area (no lookup exists). CC pop/households = sum of its OAs.
- Front end state lives in one object (web/js/state.js). Modules read/dispatch; no module keeps private copies.
- Large layers load per LA, lazily, and are cached in memory.
- Census table values load per dataset, lazily: one file per dataset and level (`values/{level}/{dataset}.json`) and per LA for output areas (`values/oa/{la_code}/{dataset}.json`). metrics.json holds definitions, Scotland values and the metrics that come from no dataset; never put a dataset's values back in it.
- Census tables are the OA-level CSVs in data/raw/Census/Census2022OutputAreaUV, one config/datasets/<id>.yaml each ("b" tables by age / sex attach to their base table as `source.extra` + `splits`). Every CSV there must belong to a dataset. UV608 is a truncated download and stays `status: draft`.
- No inlining of geometry into HTML.

## Conventions
- Python 3.10+, geopandas + pyogrio, PyYAML, pytest. Type hints. Small functions.
- JS: ES modules, no framework, no build step.
- Every build step logs feature counts in/out and file sizes.

## Definition of done for any change
- `pytest` passes; `python -m build.run` runs clean; app loads with no console errors.