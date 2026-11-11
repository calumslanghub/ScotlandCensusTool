"""Print an OA table's headers as a `categories:` skeleton for config/datasets/<id>.yaml.

    python -m build.table_headers "data/raw/Census/Census2022OutputAreaUV/UV605 - Industry.csv"

Headers are printed as build.census.read_table names them (header rows joined with " - "),
so they can be pasted as `column:` values. Ids and labels are a starting point: shorten them.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from build.census import is_header_line, read_table
from build.config import resolve_path

ID_LENGTH = 32


def slug(header: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", header.lower()).strip("_")[:ID_LENGTH].rstrip("_")


def title_lines(path: Path) -> list[str]:
    """The lines above the header: source, table name and universe."""
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    end = next((i for i, line in enumerate(lines) if is_header_line(line)), 0)
    return [line.strip(" ,") for line in lines[:end] if line.strip(" ,")]


def skeleton(path: Path) -> str:
    table = read_table(path)
    total, *columns = table.columns
    out = [f"# {line}" for line in title_lines(path)]
    out.append(f"# {len(table)} output areas, {len(table.columns)} columns")
    out.append(f"universe: {{label: {json.dumps(total)}, total_column: {json.dumps(total)}}}")
    out.append("categories:")
    for header in columns:
        quoted = json.dumps(header, ensure_ascii=False)
        out.append(f"  - {{id: {slug(header)}, column: {quoted}, label: {quoted}}}")
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m build.table_headers")
    parser.add_argument("csv", help="path to an Output Areas CSV (relative to the project root)")
    args = parser.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")
    print(skeleton(resolve_path(args.csv)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
