"""Developer-only qualification report. No physical device access."""
import argparse
import html
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
TEST = ROOT / "test"
REPORT = ROOT / "reports" / "qualification"
REGISTRY = Path(__file__).with_name("features.json")


def git(*args):
    result = subprocess.run(["git", *args], cwd=ROOT, capture_output=True,
                            text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "git failed")
    return result.stdout.strip()


def impact(base, features):
    try:
        changes = set(git("diff", "--name-only", base + "...HEAD").splitlines())
        changes.update(git("diff", "--name-only", "HEAD").splitlines())
        changes.update(git("ls-files", "--others", "--exclude-standard").splitlines())
    except (OSError, RuntimeError):
        return None, {f["id"] for f in features}
    # Unknown/shared changes conservatively impact all features.
    known = {p for f in features for p in f["paths"]}
    all_affected = any(p not in known or p in
                       {"src/extension.js", "src/connectionManager.js", "package.json"}
                       for p in changes)
    return sorted(changes), {f["id"] for f in features
                             if all_affected or changes.intersection(f["paths"])}


def run_job(name, argv, timeout=300, env=None):
    start = time.monotonic()
    try:
        p = subprocess.run(argv, cwd=ROOT, capture_output=True,
                           text=True, encoding="utf-8", errors="replace",
                           timeout=timeout, env=env)
        status = "PASS" if p.returncode == 0 else "FAIL"
        log = p.stdout + "\n" + p.stderr
    except (OSError, subprocess.TimeoutExpired) as error:
        status, log = "ERROR", str(error)
    print(f"{name}: {status}", flush=True)
    return {"name": name, "status": status, "seconds": round(time.monotonic()-start, 3),
            "log": log}


def python_job(filename):
    return run_job(filename, [sys.executable, "-m", "unittest", "discover",
                              "-s", "test", "-p", filename, "-v"], timeout=120)


def feature_status(required, results):
    if not required:
        return "NOT COVERED"
    statuses = [results.get(name, {}).get("status", "NOT RUN") for name in required]
    if "FAIL" in statuses or "ERROR" in statuses:
        return "FAIL"
    if all(s == "PASS" for s in statuses):
        return "PASS"
    return "NOT RUN"


def write_report(data):
    REPORT.mkdir(parents=True, exist_ok=True)
    (REPORT / "report.json").write_text(json.dumps(data, indent=2), encoding="utf-8")
    e = lambda value: html.escape(str(value), quote=True)
    rows = "".join(
        "<tr><td>"+e(f["id"])+"</td><td>"+e(f["name"])+"</td><td>"+e(f["status"])+
        "</td><td>"+e("Yes" if f["affected"] else "No")+"</td><td>"+
        e(", ".join(f["evidence"]))+"</td></tr>" for f in data["features"])
    logs = "".join("<details><summary>"+e(j["name"])+" — "+e(j["status"])+
                   " ("+e(j["seconds"])+"s)</summary><pre>"+e(j["log"])+
                   "</pre></details>" for j in data["jobs"])
    page = """<!doctype html><html lang="en"><meta charset="utf-8">
<title>MicroPython Studio qualification</title><style>
body{font:15px system-ui;margin:40px auto;max-width:1100px;padding:0 20px;color:#192433}
table{border-collapse:collapse;width:100%}td,th{padding:10px;text-align:left;border-bottom:1px solid #d7dce2}
th{background:#eef2f6}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f7;padding:12px}
details{padding:8px;border-bottom:1px solid #ddd}small{color:#4b5563}
</style><h1>MicroPython Studio qualification</h1>"""
    page += "<p><strong>"+e(data["status"])+"</strong> | "+e(data["mode"])+" | "+e(data["commit"])+"</p>"
    page += "<p>Automated evidence only. PASS does not certify physical hardware or uncovered behaviour.</p>"
    page += "<p>Working tree: "+e(data["working_tree"])+" | Comparison: "+e(data["base"])+"</p>"
    page += "<details><summary>Changed files</summary><pre>"+e("\n".join(data["changes"]) if data["changes"] is not None else "Unavailable; all features impacted")+"</pre></details>"
    page += "<table><thead><tr><th>ID</th><th>Feature</th><th>Evidence status</th><th>Affected</th><th>Test suites</th></tr></thead><tbody>"+rows+"</tbody></table><h2>Test evidence</h2>"+logs+"</html>"
    (REPORT / "index.html").write_text(page, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--base", default=os.environ.get("QUALIFY_BASE", "origin/main"))
    args = parser.parse_args()
    features = json.loads(REGISTRY.read_text(encoding="utf-8"))["features"]
    python_files = sorted(p.name for p in TEST.glob("test_*.py"))
    js_files = sorted(p.name for p in TEST.glob("*.test.js"))
    mapped = {p for f in features for p in f["python"]}
    mapped_js = {p for f in features for p in f["js"]}
    if mapped != set(python_files) or mapped_js != set(js_files):
        raise SystemExit("Registry mismatch: " + repr((mapped ^ set(python_files),
                                                         mapped_js ^ set(js_files))))
    changes, affected = impact(args.base, features)
    try:
        commit = git("rev-parse", "HEAD")
        dirty = bool(git("status", "--porcelain"))
    except (OSError, RuntimeError):
        commit, dirty = "UNKNOWN", True
    results = {}
    selected = ({p for f in features if f["critical"] for p in f["python"]}
                if args.quick else set(python_files))
    for filename in sorted(selected):
        results[filename] = python_job(filename)
    if not args.quick:
        # npm test invokes lint and the real VS Code extension host.
        # npm is a .cmd on Windows; use the Node CLI path supplied by npm,
        # avoiding shell interpolation of user-controlled strings.
        npm_cli = os.environ.get("npm_execpath")
        if npm_cli:
            argv = ["node", npm_cli, "test"]
        else:
            argv = ["npm.cmd" if os.name == "nt" else "npm", "test"]
        if sys.platform.startswith("linux") and not os.environ.get("DISPLAY"):
            argv = ["xvfb-run", "-a", *argv]
        results["VS Code suite"] = run_job("VS Code suite", argv, timeout=600)
    rows = []
    for f in features:
        evidence = f["python"] + (["VS Code suite"] if f["js"] else [])
        rows.append({"id": f["id"], "name": f["name"],
                     "status": feature_status(evidence, results),
                     "affected": f["id"] in affected,
                     "evidence": f["python"] + f["js"]})
    failed = any(j["status"] != "PASS" for j in results.values())
    data = {"mode": "quick" if args.quick else "full", "commit": commit,
            "working_tree": "dirty" if dirty else "clean", "base": args.base,
            "changes": changes, "status": "FAIL" if failed else "AUTOMATED CHECKS PASS",
            "features": rows, "jobs": list(results.values())}
    write_report(data)
    print("Report:", REPORT / "index.html")
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
