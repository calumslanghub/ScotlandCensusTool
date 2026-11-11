from __future__ import annotations


def pytest_terminal_summary(terminalreporter, config) -> None:
    """Print the real-data assignment report: how many features failed and why."""
    for la_geometry, res in getattr(config, "assign_reports", {}).items():
        tr = terminalreporter
        tr.section(f"assignment report (la_geometry={la_geometry})")
        tr.write_line(res.summary().to_string(index=False))
        failures = res.failures()
        tr.write_line(f"parent_code failures: {len(failures)}")
        if len(failures):
            tr.write_line(failures.groupby(["level", "status"]).size().to_string())
