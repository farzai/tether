#!/usr/bin/env python3
"""Pull request quality gate (engineering quality standard, issue #20).

Ratchet, not big bang: only code the pull request adds or changes is judged, so debt that is already on main
never blocks a PR. Four checks, all of them in this one file so a revert removes the gate:

  coverage   every executable line the PR adds or changes must be hit by a test (Vitest's v8 lcov); the repo total is
             compared with .quality/baseline.json and reported, but a drop alone never fails a PR, so deleting
             covered code cannot block a cleanup
  crap       a function the PR adds or changes must score under 10 (crapper), unless it was already 10 or more on
             base and scores no higher now (the base is measured in a throwaway worktree with the same test run)
  duplicate  the PR must not add a structural duplicate pair at 0.8 or above (dryer)
  mutation   no surviving mutant on the lines the PR changes (mutator), inside a budget sized to the change
Both coverage and mutation can be waived for one line (never line 0, a whole file missing from the coverage report)
with a line in the PR description, "Equivalent mutant: <file>:<line> <reason>" (the reason is 10 or more characters).
One such line waives every mutant on that line. It counts only as a top-level paragraph of its own in GitHub's
rendering of the description, which an earlier workflow step writes to a file (--description-html) with its sha256.

Scope for every check is the TypeScript under src/ (tests and .d.ts excluded). The test helpers under test/,
the fake app server included, are not judged.

Run from the repository root with bun, and with crapper, dryer and mutator on the PATH (.quality/requirements.txt).
The gate runs the coverage itself, so a stale report can never stand in for it.

Exit 0 when every check passes, 1 when any fails. The report goes to stdout and to GITHUB_STEP_SUMMARY.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from pathlib import Path

# Never leave __pycache__ in the tree.
sys.dont_write_bytecode = True

# The standard's thresholds. Changing one is an owner decision, never a way to get a PR through.
CRAP_LIMIT = 10
DUPLICATE_THRESHOLD = 0.8
MUTATION_BUDGET_MIN = 300.0
MUTATION_BUDGET_MAX = 1800.0

SCOPE = ("src",)
BASELINE = Path(".quality/baseline.json")
MUTANT_TESTS = ".quality/mutant-tests.sh"
LCOV = Path("coverage/lcov.info")
# The package script, so the gate measures what `bun run coverage` measures (vitest.config.ts lists every file under
# src/, so a file no test loads is still in the report, at 0 hits). The flags pin the report the gate reads.
COVERAGE_COMMAND = ["bun", "run", "coverage", "--coverage.reporter=lcov", "--coverage.reportsDirectory=coverage"]
# No test the gate runs may install a real launchd agent (test/service-real.test.ts) or reach the OS keychain.
DROPPED_VARIABLES = ("TETHER_REAL_SERVICE",)
PINNED_VARIABLES = {"TETHER_KEYCHAIN": "off"}
# Every diff the gate reads: git settings (colour, an external diff, a textconv driver) cannot change what it sees.
DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"]
# Line 0 never matches: it stands for a whole file missing from the coverage report, and no waiver covers that.
EQUIVALENT = re.compile(r"Equivalent mutant:\s*(\S+?):([1-9]\d*)\s+(\S.{9,})")
# A bidirectional control could make the reason read differently from what it says, so none may appear anywhere in
# the paragraph, on any of its lines.
BIDI = re.compile(r"[؜‎‏‪-‮⁦-⁩]")

Ranges = dict[str, list[tuple[int, int]]]


def run(args: list[str], cwd: Path | None = None, check: bool = True, env: dict | None = None) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", env=env)
    if check and result.returncode != 0:
        sys.exit(f"command failed ({result.returncode}): {' '.join(args)}\n{result.stdout[-3000:]}\n{result.stderr[-3000:]}")
    return result


def test_env() -> dict[str, str]:
    kept = {key: value for key, value in os.environ.items() if key not in DROPPED_VARIABLES}
    return {**kept, **PINNED_VARIABLES}


def resolve_base(explicit: str | None) -> str:
    """The commit the PR is measured against.

    A pull_request checkout is GitHub's merge commit, whose first parent is the current base tip, so HEAD^1 is
    exact even when the base moved after the PR was opened. Otherwise use --base.
    """
    if run(["git", "rev-parse", "--verify", "-q", "HEAD^2"], check=False).returncode == 0:
        return run(["git", "rev-parse", "HEAD^1"]).stdout.strip()
    if not explicit:
        sys.exit("HEAD is not a merge commit; pass --base <sha>")
    return explicit


def is_test_path(path: str) -> bool:
    parts = path.split("/")
    return "test" in parts[:-1] or parts[-1].endswith((".test.ts", ".spec.ts"))


def in_scope(path: str) -> bool:
    """TypeScript under src/: no tests, no declaration files."""
    if not path.startswith(tuple(f"{root}/" for root in SCOPE)):
        return False
    return path.endswith(".ts") and not path.endswith(".d.ts") and not is_test_path(path)


def added_counts(base: str) -> dict[str, int]:
    """File -> lines it adds, by name as git stores it. -z keeps a name with a space, a tab or a non-ASCII
    character whole: a patch's +++ line ends such a name with a tab or quotes it."""
    listed = run(["git", "diff", *DIFF, "--numstat", "-z", "--diff-filter=AMT", base, "HEAD", "--", *SCOPE]).stdout
    counts: dict[str, int] = {}
    for record in filter(None, listed.split("\0")):
        added, _deleted, path = record.split("\t", 2)
        if not in_scope(path):
            continue
        if added == "-":  # git counts no lines in a file it reads as binary: it must never pass unjudged
            sys.exit(f"git reads {path!r} as a binary file, so its changed lines cannot be judged")
        if int(added) > 0:  # a pure deletion adds no line to judge
            counts[path] = int(added)
    return counts


HUNK = re.compile(r"^@@ -\S+ \+(\d+)(?:,(\d+))? @@", re.MULTILINE)


def file_diff(base: str, path: str) -> str:
    """The -U0 patch of one file from base to HEAD; the name is a literal path, never a pattern."""
    return run(["git", "--literal-pathspecs", "diff", *DIFF, "-U0", base, "HEAD", "--", path]).stdout


def changed_ranges(base: str) -> Ranges:
    """Added or modified lines (new-file numbering) per file. A hunk that adds nothing (+N,0) is skipped. Each file's
    hunks must add up to the lines git counts for it; when they do not, the gate stops, because a file it cannot
    read must never pass as unchanged."""
    found: Ranges = {}
    for path, added in added_counts(base).items():
        hunks = [(int(start), 1 if count == "" else int(count)) for start, count in HUNK.findall(file_diff(base, path))]
        ranges = [(start, start + count - 1) for start, count in hunks if count > 0]
        if sum(end - start + 1 for start, end in ranges) != added:
            sys.exit(f"could not read the changed lines of {path!r}: git counts {added} added, its hunks do not")
        found[path] = ranges
    return found


def touches(ranges: list[tuple[int, int]], first: int, last: int) -> bool:
    return any(start <= last and end >= first for start, end in ranges)


def run_coverage(root: Path) -> float:
    """Run the suite with coverage into coverage/lcov.info, after deleting any old report. Returns the seconds it took,
    which is also the gate's measure of one mutant's worst case (one mutant runs at most the whole suite)."""
    shutil.rmtree(root / "coverage", ignore_errors=True)
    started = time.monotonic()
    result = run(COVERAGE_COMMAND, cwd=root, check=False, env=test_env())
    if result.returncode != 0:
        sys.exit(f"the tests failed under coverage ({result.returncode}):\n{result.stdout[-3000:]}\n{result.stderr[-3000:]}")
    if not (root / LCOV).is_file():
        sys.exit(f"the coverage run wrote no {LCOV}")
    return time.monotonic() - started


def parse_lcov(text: str) -> dict[str, dict[int, int]]:
    """File -> {line: hits} for the executable lines in an lcov report."""
    files: dict[str, dict[int, int]] = {}
    current: dict[int, int] | None = None
    for line in text.splitlines():
        if line.startswith("SF:"):
            current = files.setdefault(line[3:].strip(), {})
        elif line.startswith("DA:") and current is not None:
            number, _, rest = line[3:].partition(",")
            current[int(number)] = int(rest.split(",")[0])
    return files


def lcov_totals(text: str) -> dict[str, float]:
    """Line and function coverage of the in-scope files, in percent (two decimals), from the LF/LH/FNF/FNH records.
    """
    sums = {"LF": 0, "LH": 0, "FNF": 0, "FNH": 0}
    counted = False
    for line in text.splitlines():
        if line.startswith("SF:"):
            counted = in_scope(line[3:].strip())
        elif counted and line[:3].rstrip(":") in sums:
            key, _, value = line.partition(":")
            sums[key] += int(value)

    def pct(hit: int, found: int) -> float:
        return round(100 * hit / found, 2) if found else 100.0

    return {"lines": pct(sums["LH"], sums["LF"]), "functions": pct(sums["FNH"], sums["FNF"])}


def lines_of(report: dict[str, dict[int, int]], path: str) -> dict[int, int] | None:
    for name, lines in report.items():
        if name == path or name.endswith("/" + path):
            return lines
    return None


def uncovered_changed(changed: Ranges, lcov_text: str) -> list[tuple[str, int]]:
    """Changed executable lines that no test hits. vitest.config.ts lists every file under src/, so a file the tests
    only run as a separate process (src/cli/bin.ts) is in the report at 0 hits, and each of its changed lines is
    reported on its own. A file the report does not list at all is reported as line 0, which no waiver names: the
    report cannot vouch for any of its lines."""
    report = parse_lcov(lcov_text)
    found: list[tuple[str, int]] = []
    for path, ranges in sorted(changed.items()):
        lines = lines_of(report, path)
        if lines is None:
            found.append((path, 0))
            continue
        for number in sorted(n for n, hits in lines.items() if hits == 0 and touches(ranges, n, n)):
            found.append((path, number))
    return found


def coverage_verdict(
    uncovered: list[tuple[str, int]], allowed: dict[tuple[str, int], str], now: dict[str, float], baseline: dict
) -> tuple[bool, list[str]]:
    """The PR fails on its own untested lines, never on the repo total."""
    lines = totals_report(now, baseline["coverage"])
    bad = [item for item in uncovered if item not in allowed]
    for path, number in uncovered:
        reason = allowed.get((path, number))
        where = f"{path}:{number}" if number else f"{path} (not in the coverage report)"
        lines.append(f"  untested changed line {where}" + (f" (explained: {reason})" if reason else ""))
    if bad:
        lines.append(
            "Add a test that runs each line, or add 'Equivalent mutant: <file>:<line> <reason>' to the PR description "
            "when no test can reach it."
        )
    else:
        lines.insert(0, "Every executable line the PR adds or changes is hit by a test.")
    return not bad, lines


def totals_report(now: dict[str, float], floor: dict[str, float]) -> list[str]:
    """The repo totals against the baseline: reported, and a rise asks for the baseline to be updated."""
    lines = [
        f"Repo coverage: lines {now['lines']}% (baseline {floor['lines']}%), "
        f"functions {now['functions']}% (baseline {floor['functions']}%)."
    ]
    keys = ("lines", "functions")
    if any(now[key] > floor[key] for key in keys):
        lines.append("Coverage improved: update coverage in .quality/baseline.json in this PR.")
    if any(now[key] < floor[key] for key in keys):
        lines.append("Below the baseline; that alone does not fail the PR (deleting covered code can cause it).")
    return lines


def check_coverage(lcov_path: Path, changed: Ranges, baseline: dict, allowed: dict[tuple[str, int], str]) -> tuple[bool, list[str]]:
    text = lcov_path.read_text(encoding="utf-8")
    return coverage_verdict(uncovered_changed(changed, text), allowed, lcov_totals(text), baseline)


Scored = tuple[tuple[str, str, int], int, float, int, float]
"""One function's score: (key, start line, CRAP, complexity, coverage percent). The key is (path, name, nth function of
that name in the file), so a function that moved to another file or was renamed has no key on base: it is new."""


def scored_functions(root: Path, paths: list[str], need_coverage: bool = False) -> list[Scored]:
    """Every function in the given files with its CRAP, from the coverage under root.

    A function with no coverage record scores as 0% covered, unless `need_coverage`: then it is left out, because
    0% is the highest score it could have, which would let any head score pass against it."""
    from crapper.coverage import load_bundle
    from crapper.crap import make_entry
    from crapper.languages import functions_in_file

    bundle = load_bundle(root)
    bundle.bind_sources(sorted(paths))
    found: list[Scored] = []
    for path in sorted(paths):
        source = (root / path).read_text(encoding="utf-8", errors="replace")
        seen: dict[str, int] = {}
        for function in functions_in_file("typescript", source, path, str(root)):
            nth = seen.get(function.name, 0)
            seen[function.name] = nth + 1
            percent = bundle.percent_for(function)
            if percent is None and need_coverage:
                continue
            entry = make_entry(function, 0.0 if percent is None else percent)
            if entry.crap is not None:
                found.append(((path, function.name, nth), function.start_line, entry.crap, entry.complexity, entry.coverage))
    return found


def crap_verdict(
    head: list[Scored], touched: set[tuple[str, str, int]], base: dict[tuple[str, str, int], float] | None
) -> tuple[bool, list[str]]:
    """A function the PR touches passes under the limit. One that is over the limit passes only when it was already
    over on base and scores no higher now (raw scores; one decimal is only how they print); a new, moved or renamed
    one has to be under, and so is every function of a name whose count in its file changed (order cannot tell which
    one is the old one)."""

    def counts(keys) -> dict[tuple[str, str], int]:
        found: dict[tuple[str, str], int] = {}
        for path, name, _nth in keys:
            found[(path, name)] = found.get((path, name), 0) + 1
        return found

    on_head = counts(key for key, *_ in head)
    on_base = counts(base or {})
    bad: list[str] = []
    still: list[str] = []
    judged = [item for item in head if item[0] in touched]
    for key, line, crap, complexity, coverage in judged:
        if crap < CRAP_LIMIT:
            continue
        label = f"{key[0]}:{line} {key[1]} CRAP {crap:.1f} (complexity {complexity}, coverage {coverage:.0f}%)"
        before = (base or {}).get(key) if on_head.get(key[:2]) == on_base.get(key[:2]) else None
        failure = crap_failure(crap, before)
        if failure:
            bad.append(f"{label}, {failure}")
        else:
            still.append(f"{label}, base {before:.1f}")
    checked = len(judged)
    lines = [f"{checked} added or changed function(s) scored, limit is under {CRAP_LIMIT}."]
    lines += [f"  over the limit: {item}" for item in bad]
    lines += [f"  still over the limit, no worse than base: {item}" for item in still]
    return not bad, lines


def crap_failure(crap: float, before: float | None) -> str | None:
    """Why a function at or over the limit fails, or None when it may stay: it was already over on base and is no
    higher now."""
    if before is None:
        return "new function (no score on base under this file and name)"
    if before < CRAP_LIMIT:
        return f"was {before:.1f} on base (under the limit)"
    if crap > before:
        return f"was {before:.1f} on base (higher)"
    return None


def base_worktree(root: Path, base: str) -> tuple[Path, Path]:
    """A throwaway detached worktree of base. Returns (its parent, the tree)."""
    parent = Path(tempfile.mkdtemp(prefix="quality-base-"))
    tree = parent / "tree"
    run(["git", "worktree", "add", "--detach", str(tree), base], cwd=root)
    return parent, tree


def drop_worktree(root: Path, parent: Path) -> None:
    run(["git", "worktree", "remove", "--force", str(parent / "tree")], cwd=root, check=False)
    shutil.rmtree(parent, ignore_errors=True)


def base_scores(base: str, root: Path, paths: list[str]) -> dict[tuple[str, str, int], float]:
    """CRAP on base for the functions in the given files: the base tree, with the same coverage run as head (the base
    borrows this checkout's node_modules)."""
    parent, tree = base_worktree(root, base)
    try:
        existing = [path for path in paths if (tree / path).is_file()]
        if not existing:
            return {}
        (tree / "node_modules").symlink_to((root / "node_modules").resolve(), target_is_directory=True)
        run_coverage(tree)
        return {
            key: crap for key, _line, crap, _complexity, _coverage in scored_functions(tree, existing, need_coverage=True)
        }
    finally:
        drop_worktree(root, parent)


def touched_functions(root: Path, changed: Ranges) -> set[tuple[str, str, int]]:
    """Functions with a changed line in them."""
    from crapper.languages import functions_in_file

    found: set[tuple[str, str, int]] = set()
    for path, ranges in changed.items():
        source = (root / path).read_text(encoding="utf-8", errors="replace")
        seen: dict[str, int] = {}
        for function in functions_in_file("typescript", source, path, str(root)):
            nth = seen.get(function.name, 0)
            seen[function.name] = nth + 1
            if touches(ranges, function.start_line, function.end_line):
                found.add((path, function.name, nth))
    return found


def check_crap(changed: Ranges, root: Path, base: str) -> tuple[bool, list[str]]:
    head = scored_functions(root, sorted(changed))
    touched = touched_functions(root, changed)
    over = sorted({key[0] for key, _l, crap, _c, _v in head if key in touched and crap >= CRAP_LIMIT})
    return crap_verdict(head, touched, base_scores(base, root, over) if over else None)


Pair = tuple[float, tuple[str, int, int], tuple[str, int, int]]
# The start of each block in dryer's report; a line, so a path or note that holds the word cannot add one.
DUPLICATE = re.compile(r"^DUPLICATE ", re.MULTILINE)


def parse_dryer(out: str) -> list[Pair]:
    pairs: list[Pair] = []
    # The text before the first marker is not a block.
    for block in DUPLICATE.split(out)[1:]:
        score = re.match(r"score=([\d.]+)", block)
        places = re.findall(r"^\s+(\S+):(\d+)-(\d+)$", block, re.MULTILINE)
        if score and len(places) == 2:
            left, right = ((p, int(a), int(b)) for p, a, b in places)
            pairs.append((float(score.group(1)), left, right))
    # A block the gate cannot read could hide a new pair, so it stops the gate rather than being skipped.
    blocks = len(DUPLICATE.findall(out))
    if blocks != len(pairs):
        sys.exit(f"dryer printed {blocks} DUPLICATE blocks but {len(pairs)} pairs could be read:\n{out[-3000:]}")
    return pairs


def dryer_pairs(root: Path) -> list[Pair]:
    """Pairs at the threshold or above under src/ (dryer skips test folders and files on its own)."""
    targets = [name for name in SCOPE if (root / name).is_dir()]
    if not targets:
        return []
    out = run(["dryer", "--threshold", str(DUPLICATE_THRESHOLD), *targets], cwd=root).stdout
    shutil.rmtree(root / ".metrics", ignore_errors=True)
    return parse_dryer(out)


def duplicate_verdict(changed: Ranges, before: list[Pair], after: list[Pair]) -> tuple[bool, list[str]]:
    """A pair is new when it touches a changed line and its two files hold more pairs than they did on base."""

    def key(pair: Pair) -> tuple[str, str]:
        return tuple(sorted((pair[1][0], pair[2][0])))  # type: ignore[return-value]

    def count(pairs: list[Pair], wanted: tuple[str, str]) -> int:
        return sum(1 for p in pairs if key(p) == wanted)

    bad = []
    for pair in after:
        score, left, right = pair
        touched = any(f in changed and touches(changed[f], a, b) for f, a, b in (left, right))
        if touched and count(after, key(pair)) > count(before, key(pair)):
            bad.append(f"{left[0]}:{left[1]}-{left[2]} and {right[0]}:{right[1]}-{right[2]} (similarity {score:.2f})")
    head = f"{len(after)} duplicate pair(s) at {DUPLICATE_THRESHOLD} or above on this PR, {len(before)} on base."
    return not bad, [head] + [f"  new duplicate: {item}" for item in bad]


def check_duplicates(changed: Ranges, base: str, root: Path) -> tuple[bool, list[str]]:
    parent, tree = base_worktree(root, base)
    try:
        before = dryer_pairs(tree)
    finally:
        drop_worktree(root, parent)
    return duplicate_verdict(changed, before, dryer_pairs(root))


# Elements that never hold content, so they never wrap a waiver.
VOID = frozenset({"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"})


class TopLevelParagraphs(HTMLParser):
    """The text of each top-level <p> in GitHub's rendering that holds text and nothing else. Anything inside another
    element (<details>, <pre>, a list, a quote) or next to markup in its paragraph is left out, and an element that is
    never closed covers everything after it."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.open: list[str] = []
        self.text: list[str] | None = None
        self.found: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.text = [] if tag == "p" and not self.open and not attrs else None
        if tag not in VOID:
            self.open.append(tag)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.text = None

    def handle_endtag(self, tag: str) -> None:
        if tag not in self.open:
            return
        while self.open.pop() != tag:
            pass
        # Text is collected only from a top-level <p> with no tag since, so this end tag closes that very paragraph;
        # nothing after it belongs to it.
        if self.text is not None:
            self.found.append("".join(self.text))
            self.text = None

    def handle_data(self, data: str) -> None:
        if self.text is not None:
            self.text.append(data)


def survivors_allowed(html: str) -> dict[tuple[str, int], str]:
    """The waivers in GitHub's rendering of the description: each must be the whole text of a top-level paragraph, so
    a reviewer always sees it on the PR page."""
    parser = TopLevelParagraphs()
    parser.feed(html)
    parser.close()
    found = (EQUIVALENT.fullmatch(text.strip()) for text in parser.found if not BIDI.search(text))
    return {(m.group(1), int(m.group(2))): m.group(3).strip() for m in found if m}


def read_waivers(path: str | None, sha256: str | None) -> tuple[bool, list[str], dict[tuple[str, int], str]]:
    """The waivers that count, from GitHub's rendering of the description, written to `path` by the workflow step that
    holds the token, before any code from the pull request runs, together with its sha256 (a step output, which no
    later step can change). Without a file nothing is waived; a file that cannot be read, or comes without its hash or
    does not match it, fails, because then the gate cannot tell which waivers a reviewer sees."""
    if path is None:
        return True, ["No rendered description was given: nothing is waived."], {}
    try:
        data = Path(path).read_bytes()
    except OSError as error:
        return False, [f"The rendered description cannot be read, so no waiver can be: {error}"], {}
    if not sha256 or hashlib.sha256(data).hexdigest() != sha256.strip().lower():
        return False, ["The rendered description does not match the sha256 it was rendered with, so no waiver can be read."], {}
    allowed = survivors_allowed(data.decode("utf-8", errors="replace"))
    lines = [f"{len(allowed)} waiver(s) count, each the whole text of a top-level paragraph on GitHub."]
    lines.extend(f"  {file}:{line}" for file, line in sorted(allowed))
    return True, lines, allowed


SAFE_PATH = re.compile(r"^[A-Za-z0-9_./@+-]+$")


def safe_path(path: str) -> bool:
    return bool(SAFE_PATH.match(path)) and ".." not in path.split("/")


def _kill_pass(tag: str) -> int:
    """One scan of /proc: kill every process that carries the tag. Returns how many it killed."""
    needle = f"QUALITY_GATE_TAG={tag}".encode()
    proc_dir = Path("/proc")
    if not proc_dir.is_dir():
        return 0
    others = (e for e in proc_dir.iterdir() if e.name.isdigit() and int(e.name) != os.getpid())
    return sum(1 for entry in others if _kill_if_tagged(entry, needle))


def _kill_if_tagged(entry: Path, needle: bytes) -> bool:
    """Kill the process behind one /proc entry when its environment holds the tag. A process that is gone, or not
    ours to read, is skipped."""
    try:
        if needle not in (entry / "environ").read_bytes().split(b"\0"):
            return False
        os.kill(int(entry.name), signal.SIGKILL)
        return True
    except OSError:
        return False


def kill_tagged(tag: str, passes: int = 20) -> None:
    """Kill every process that carries QUALITY_GATE_TAG=<tag> in its environment (Linux, via /proc).

    mutator starts each test run in its own session, so killing mutator's process group leaves them running; they
    inherit the tag from the environment, which is how they are found. A process can fork between the scan and the
    kill, so scan again until a pass finds none.
    """
    for _ in range(passes):
        if _kill_pass(tag) == 0:
            return
        time.sleep(0.05)


def run_limited(args: list[str], cwd: Path, env: dict, seconds: float) -> tuple[int | None, str, str]:
    """Run args; on timeout kill the process group and everything tagged by this run, and return code None."""
    tag = uuid.uuid4().hex
    proc = subprocess.Popen(
        args, cwd=cwd, env={**env, "QUALITY_GATE_TAG": tag}, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, start_new_session=True,
    )
    try:
        out, err = proc.communicate(timeout=max(seconds, 0.1))
        return proc.returncode, out, err
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        kill_tagged(tag)
        proc.communicate()
        return None, "", ""


def mutator_args(path: str, wanted: list[int], *extra: str) -> list[str]:
    return ["mutator", path, "--lines", ",".join(map(str, wanted)), "--use-existing-coverage", *extra]


def count_sites(path: str, wanted: list[int], root: Path) -> int | str:
    """Mutation sites on the wanted lines (a scan runs no tests), or "unknown" when the scan does not finish."""
    code, out, _ = run_limited(mutator_args(path, wanted, "--scan"), root, dict(os.environ), 30)
    if code is None:
        return "unknown"
    return len([line for line in out.splitlines() if re.match(r"\s+\S+:\d+\s", line)])


CGROUP = Path("/sys/fs/cgroup")
BYTES_PER_MUTANT = 1 << 30  # one Vitest run of the whole suite stays well under 1 GB
MEMORY_RESERVE = 2 << 30  # for the gate, the mutator processes and the system


def available_cores(cgroup: Path = CGROUP) -> int:
    """Cores this process may use: the CPU affinity, capped by a cgroup v2 CPU quota when there is one.

    os.cpu_count() reports the host, which on a container runner can be far more than the job is given.
    """
    n = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else (os.cpu_count() or 1)
    try:
        quota, period = (cgroup / "cpu.max").read_text().split()[:2]
        if quota != "max":
            n = min(n, max(1, int(int(quota) / int(period))))
    except (OSError, ValueError):
        pass
    return max(1, n)


def memory_limit(cgroup: Path = CGROUP, meminfo: Path = Path("/proc/meminfo")) -> int | None:
    """Bytes of memory this job may use: the cgroup limit (v2, then v1) or, without one, the machine's total."""
    for name in ("memory.max", "memory/memory.limit_in_bytes"):
        try:
            text = (cgroup / name).read_text().strip()
            if text != "max" and int(text) < (1 << 60):
                return int(text)
        except (OSError, ValueError):
            continue
    try:
        for line in meminfo.read_text().splitlines():
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError):
        pass
    return None


def worker_limit(cores: int, memory: int | None) -> int:
    """Mutants allowed at once: the cores, or what the memory holds after a 2 GB reserve at 1 GB per mutant."""
    if memory is None:
        return max(1, cores)
    return max(1, min(cores, (memory - MEMORY_RESERVE) // BYTES_PER_MUTANT))


def plan_workers(sites: dict[str, int | str], limit: int) -> dict[str, int]:
    """Mutants to run at once per file; the total never goes over `limit`.

    A file with many sites gets many workers, so a big file does not finish last on a few workers while other cores
    sit idle. With more files than `limit` every file gets one worker and the files queue for a free slot (the caller
    runs at most `limit` mutator processes at a time).
    """
    # A file whose scan did not finish ("unknown") still gets mutated, so it takes one slot of the plan.
    sites = {path: (count if isinstance(count, int) else 1) for path, count in sites.items()}
    sites = {path: count for path, count in sites.items() if count > 0}
    if not sites:
        return {}
    if len(sites) >= limit:
        return {path: 1 for path in sites}
    total = sum(sites.values())
    extra = limit - len(sites)
    exact = {path: extra * count / total for path, count in sites.items()}
    plan = {path: 1 + int(exact[path]) for path in sites}
    leftover = limit - sum(plan.values())
    for path in sorted(sites, key=lambda p: (exact[p] - int(exact[p]), sites[p]), reverse=True)[:leftover]:
        plan[path] += 1
    return plan


def mutation_budget(spent: float, sites: dict[str, int | str], plan: dict[str, int], limit: int, mutant_seconds: float) -> float:
    """The whole gate's time budget, sized to the change (engineering standard, "Mutation budget"): the time already
    spent, plus for each file the rounds its sites need on its workers, plus mutator's own unmutated run of the file,
    times the measured time of one mutant. Files beyond `limit` queue, so the per-file rounds are spread over the
    slots. Never below 5 minutes, never above 30."""
    rounds = 0
    for path, workers in plan.items():
        count = sites[path] if isinstance(sites[path], int) else 1
        rounds += math.ceil(count / workers) + 1  # type: ignore[operator]
    files_at_once = max(1, min(len(plan), limit))
    wanted = spent + math.ceil(rounds / files_at_once) * mutant_seconds
    return max(MUTATION_BUDGET_MIN, min(MUTATION_BUDGET_MAX, wanted))


def wanted_lines(ranges: list[tuple[int, int]]) -> list[int]:
    return sorted({n for start, end in ranges for n in range(start, end + 1)})


def mutate_file(path: str, ranges: list[tuple[int, int]], root: Path, workers: int, deadline: float):
    """Mutate one file's changed lines. Returns (status, killed, survivors, detail); status is ok, unchecked or failed."""
    wanted = wanted_lines(ranges)
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return "unchecked", 0, [], count_sites(path, wanted, root)
    # The file reaches the test command through the environment, never through the command string.
    env = {**test_env(), "MUTANT_FILE": path}
    code, out, err = run_limited(
        mutator_args(path, wanted, "--mutate-all", "--max-workers", str(workers), "--test-command", f"./{MUTANT_TESTS}"),
        root, env, remaining,
    )
    if code is None:
        return "unchecked", 0, [], count_sites(path, wanted, root)
    if code not in (0, 3):
        return "failed", 0, [], f"mutator failed on {path} (exit {code}):\n{out[-1500:]}\n{err[-1500:]}"
    killed = 0
    survivors: list[tuple[str, int, str]] = []
    for line in out.splitlines():
        m = re.match(r"(KILLED|SURVIVED)\s+(\S+?):(\d+)\s+(.*)", line)
        if not m:
            continue
        if m.group(1) == "KILLED":
            killed += 1
        else:
            survivors.append((m.group(2), int(m.group(3)), m.group(4)))
    return "ok", killed, survivors, ""


def tally(outcomes: dict[str, tuple]) -> tuple[int, list[tuple[str, int, str]], list[tuple[str, int | str]], list[str]]:
    """Killed, survivors, files not checked (with their sites) and failure details, over every file's outcome."""
    survived: list[tuple[str, int, str]] = []
    unchecked: list[tuple[str, int | str]] = []
    failed: list[str] = []
    killed = 0
    for path in sorted(outcomes):
        status, k, survivors, detail = outcomes[path]
        if status == "failed":
            failed.append(detail)
        elif status == "unchecked":
            unchecked.append((path, detail))
        killed += k
        survived.extend(survivors)
    return killed, survived, unchecked, failed


def unchecked_report(unchecked: list[tuple[str, int | str]], budget: float) -> list[str]:
    if not unchecked:
        return []
    return [
        f"The {budget:.0f}s budget ran out before every file was checked. Not checked:",
        *(f"  {path} ({sites} mutation site(s))" for path, sites in unchecked),
        "The runner may have been busy: re-run this job once before doing anything else. If it runs out of time "
        "again, the PR is too large for the gate to finish and has to be split, or its tests made faster.",
    ]


def mutation_report(
    outcomes: dict[str, tuple], allowed: dict[tuple[str, int], str], budget: float, elapsed: float, how: str
) -> tuple[bool, list[str]]:
    """The verdict and report from each file's outcome. A file mutator failed on fails the check, and so does a file
    the budget ran out on; the files that finished are still reported."""
    killed, survived, unchecked, failed = tally(outcomes)
    unexplained = [s for s in survived if (s[0], s[1]) not in allowed]
    lines = [
        f"{killed} mutant(s) killed, {len(survived)} survived on the changed lines, {elapsed:.0f}s of a "
        f"{budget:.0f}s budget ({how})."
    ]
    for path, line, op in survived:
        reason = allowed.get((path, line))
        tag = f"explained as equivalent: {reason}" if reason else "NOT explained"
        lines.append(f"  survivor {path}:{line} {op} ({tag})")
    if unexplained:
        lines.append(
            "Kill each survivor with a test, or add 'Equivalent mutant: <file>:<line> <why it cannot change behaviour>' "
            "to the PR description (one such line waives every mutant on that line)."
        )
    lines.extend(failed)
    lines.extend(unchecked_report(unchecked, budget))
    return not unexplained and not unchecked and not failed, lines


def check_mutation(
    changed: Ranges,
    root: Path,
    allowed: dict[tuple[str, int], str],
    started: float,
    mutant_seconds: float,
    workers: int | None = None,
) -> tuple[bool, list[str]]:
    """Mutate the changed lines inside a budget sized to the change, as many mutants at once as the machine allows.

    Each mutant runs in its own copy of the tree (mutator's worker directories), so parallel mutants never share
    files. When the budget runs out the check fails cleanly: the report names what was not checked, instead of the
    runner killing the job and the report with it.
    """
    for path in changed:
        if not safe_path(path):
            return False, [f"refusing to run mutator on an unusual file name: {path!r}"]
    cores = available_cores()
    limit = workers or worker_limit(cores, memory_limit())
    shutil.rmtree(root / ".metrics", ignore_errors=True)
    paths = sorted(changed)
    # Scans run no tests, so counting every file's sites first is cheap.
    with ThreadPoolExecutor(max_workers=max(1, min(len(paths), cores))) as pool:
        sites = dict(zip(paths, pool.map(lambda p: count_sites(p, wanted_lines(changed[p]), root), paths)))
    plan = plan_workers(sites, limit)
    budget = mutation_budget(time.monotonic() - started, sites, plan, limit, mutant_seconds)
    deadline = started + budget
    # A file with no mutation site needs no run; a scan that did not finish is planned as one site.
    todo = [p for p in paths if p in plan]
    with ThreadPoolExecutor(max_workers=max(1, min(len(todo), limit))) as pool:
        outcomes = dict(zip(todo, pool.map(lambda p: mutate_file(p, changed[p], root, plan[p], deadline), todo)))
    shutil.rmtree(root / "target" / "mutation-workers", ignore_errors=True)
    shutil.rmtree(root / ".metrics", ignore_errors=True)
    per_file = ", ".join(f"{Path(p).name} x{n} ({sites[p]} sites)" for p, n in sorted(plan.items())) or "no sites"
    how = f"limit {limit} mutants at once from {cores} core(s), one mutant measured at {mutant_seconds:.0f}s: {per_file}"
    return mutation_report(outcomes, allowed, budget, time.monotonic() - started, how)


def main() -> int:
    started = time.monotonic()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", help="base commit when HEAD is not a merge commit")
    parser.add_argument("--workers", type=int, default=None, help="mutants at once; default from cores and memory")
    parser.add_argument("--skip-coverage-run", action="store_true", help="read coverage/lcov.info as it is (self-tests)")
    parser.add_argument("--skip-mutation", action="store_true", help="local runs only")
    parser.add_argument("--description-html", help="GitHub's rendering of the PR description, from an earlier step")
    parser.add_argument("--description-sha256", help="the sha256 of that file, as the step that wrote it gave it")
    opts = parser.parse_args()

    root = Path.cwd()
    base = resolve_base(opts.base)
    results, before_mutation = gate_results(opts, root, base, started)
    report = [f"## Quality gate (base {base[:8]})", "", f"Every check before mutation took {before_mutation:.0f}s.", ""]
    for name, passed, lines in results:
        report.append(f"### {name}: {'pass' if passed else 'FAIL'}")
        report.extend(lines)
        report.append("")
    text = "\n".join(report)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(text + "\n")
    return 0 if all(passed for _, passed, _ in results) else 1


Result = tuple[str, bool, list[str]]


def guarded(check, *args) -> tuple[bool, list[str]]:
    """Run one check. A check that breaks (a tool that fails, a report it cannot read, a bug) fails with the error's
    type and message, and the other checks and the summary still run."""
    try:
        return check(*args)
    except (Exception, SystemExit) as error:  # noqa: BLE001 - every failure must reach the report
        return False, [f"The check broke: {type(error).__name__}: {str(error)[-3000:]}"]


def gate_results(opts: argparse.Namespace, root: Path, base: str, started: float) -> tuple[list[Result], float]:
    """Every check in order, and the seconds spent before mutation."""
    baseline = json.loads(BASELINE.read_text(encoding="utf-8"))
    changed = changed_ranges(base)
    ok, lines, allowed = read_waivers(opts.description_html, opts.description_sha256)
    results: list[Result] = [("Waivers", ok, lines)]

    timing: list[float] = []
    ok, lines = guarded(coverage_step, opts, root, changed, baseline, allowed, timing)
    results.append(("Coverage", ok, lines))
    suite_seconds = timing[0] if timing else 0.0
    nothing = "No lines were added or changed in TypeScript under src/."
    results.append(("CRAP", *guarded(check_crap, changed, root, base)) if changed else ("CRAP", True, [nothing]))
    results.append(
        ("Duplication", *guarded(check_duplicates, changed, base, root)) if changed else ("Duplication", True, [nothing])
    )
    before_mutation = time.monotonic() - started
    results.append(mutation_result(opts, changed, root, allowed, started, suite_seconds, results, nothing))
    return results, before_mutation


def mutation_result(opts, changed: Ranges, root: Path, allowed, started: float, suite_seconds: float, earlier, nothing: str) -> Result:
    """Mutation runs last, and only when there is something to mutate and every earlier check passed."""
    if not changed:
        return ("Mutation", True, [nothing])
    if not all(passed for _, passed, _ in earlier):
        return ("Mutation", False, ["Not run: an earlier check failed. Fix it first; mutation runs after it passes."])
    if opts.skip_mutation:
        return ("Mutation", True, ["Skipped (--skip-mutation)."])
    return ("Mutation", *guarded(check_mutation, changed, root, allowed, started, suite_seconds, opts.workers))


def coverage_step(opts, root: Path, changed: Ranges, baseline: dict, allowed, timing: list[float]) -> tuple[bool, list[str]]:
    """Run the suite with coverage (unless told to read the report as it is), time it into `timing`, and judge it."""
    if opts.skip_coverage_run:
        return check_coverage(root / LCOV, changed, baseline, allowed)
    timing.append(run_coverage(root))
    print(f"tests with coverage: {timing[0]:.0f}s", flush=True)
    ok, lines = check_coverage(root / LCOV, changed, baseline, allowed)
    return ok, [*lines, f"The suite with coverage took {timing[0]:.0f}s."]


if __name__ == "__main__":
    sys.exit(main())
