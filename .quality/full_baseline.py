#!/usr/bin/env python3
"""Full mutation baseline: every mutation site under src/, not only the lines a PR changes.

Run by hand from the repository root (see .quality/README.md). It runs the suite with coverage, then uses the gate's own machinery
(worker plan, memory limit, per-mutant isolation, the same test command) with every file's whole range, prints one
line per file as it finishes, and ends with the totals that belong in .quality/baseline.json. Uncovered sites are not
run (mutator skips them), so the score is killed / (killed + survived). Files the budget did not reach are listed,
and the score covers only the files that finished.
"""

from __future__ import annotations

import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import gate  # noqa: E402


def source_files(root: Path) -> list[str]:
    found = []
    for scope in gate.SCOPE:
        for path in (root / scope).rglob("*.ts"):
            name = path.relative_to(root).as_posix()
            if gate.in_scope(name):
                found.append(name)
    return sorted(found)


class Totals:
    """Running totals of a full run, one file at a time."""

    def __init__(self, started: float) -> None:
        self.started = started
        self.killed = 0
        self.survived = 0
        self.unchecked: list[str] = []
        self.failed: list[str] = []

    def record(self, path: str, outcome) -> None:
        status, k, survivors, detail = outcome
        self.killed += k
        self.survived += len(survivors)
        if status == "failed":
            self.failed.append(path)
        elif status == "unchecked":
            self.unchecked.append(path)
        elapsed = time.monotonic() - self.started
        print(f"{status:9} {path} killed={k} survived={len(survivors)} elapsed={elapsed:.0f}s", flush=True)
        if status == "failed":
            print(str(detail)[-600:], flush=True)

    def result(self, files: int, sites: int) -> dict:
        done = self.killed + self.survived
        return {
            "files": files,
            "sites": sites,
            "killed": self.killed,
            "survived": self.survived,
            "score": round(100 * self.killed / done, 1) if done else None,
            "filesNotChecked": sorted(self.unchecked),
            "filesFailed": sorted(self.failed),
            "seconds": round(time.monotonic() - self.started),
        }


def publish(result: dict) -> None:
    print("RESULT " + json.dumps(result), flush=True)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write("## Full mutation baseline\n\n```json\n" + json.dumps(result, indent=2) + "\n```\n")


def main() -> int:
    root = Path.cwd()
    budget = float(os.environ.get("BASELINE_BUDGET_SECONDS", "19800"))  # 330 minutes
    started = time.monotonic()
    suite = gate.run_coverage(root)
    files = source_files(root)
    ranges = {f: [(1, len((root / f).read_text(encoding="utf-8").splitlines()))] for f in files}
    cores = gate.available_cores()
    limit = gate.worker_limit(cores, gate.memory_limit())
    with ThreadPoolExecutor(max_workers=max(1, min(len(files), cores))) as pool:
        sites = dict(zip(files, pool.map(lambda f: gate.count_sites(f, gate.wanted_lines(ranges[f]), root), files)))
    known = sum(n for n in sites.values() if isinstance(n, int))
    todo = sorted(gate.plan_workers(sites, limit), key=lambda f: -(sites[f] if isinstance(sites[f], int) else 1))
    print(f"suite {suite:.0f}s, {len(files)} files, {known} sites, {len(todo)} to mutate, limit {limit} ({cores} cores)", flush=True)

    totals = Totals(started)
    # One file at a time with every slot: a share proportional to the sites leaves a big file on one worker for hours.
    for path in todo:
        totals.record(path, gate.mutate_file(path, ranges[path], root, limit, started + budget))
    gate.shutil.rmtree(root / "target" / "mutation-workers", ignore_errors=True)
    result = totals.result(len(files), known)
    publish(result)
    return 1 if result["filesNotChecked"] or result["filesFailed"] else 0


if __name__ == "__main__":
    sys.exit(main())
