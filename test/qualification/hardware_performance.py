"""Compare only equivalent board, firmware and workload measurements."""
import json


def compare(report, path):
    baseline = json.loads(path.read_text(encoding="utf-8"))
    rows = {r["name"].split()[0]: r for r in report["tests"]}
    if (report["board"] != baseline["board"] or report["cycles"] != baseline["cycles"]
            or rows.get("HIL-002", {}).get("evidence") != baseline["identity"]):
        return {"status": "NOT COMPARABLE", "reason": "Board, firmware or cycle count differs"}
    comparisons = []
    for name, reference in baseline["seconds"].items():
        # HIL-010 now waits for additional firmware acknowledgements and
        # explicit DTR transitions; its historical timing is not equivalent.
        if name == "HIL-010":
            continue
        row = rows.get(name)
        if not row or row["status"] != "PASS":
            comparisons.append({"id": name, "status": "NOT RUN"})
            continue
        # Provisional broad guard against regressions, not a statistical SLA.
        limit = max(reference * 2, reference + .5)
        comparisons.append({"id": name, "baseline_seconds": reference,
                            "actual_seconds": row["seconds"], "limit_seconds": limit,
                            "status": "PASS" if row["seconds"] <= limit else "FAIL"})
    return {"status": "PASS" if all(r["status"] == "PASS" for r in comparisons) else "FAIL",
            "comparisons": comparisons,
            "excluded": {"HIL-010": "Debugger lifecycle workload changed; new baseline required"}}
