# Quality gate

The `quality` job in `.github/workflows/ci.yml` runs on every pull request and calls `gate.py`. It follows the
engineering quality standard as a ratchet: only code the PR adds or changes is judged, so debt already on main never
blocks a PR. Everything lives in this folder, that job and `mutation-baseline.yml`, so one revert removes it.

| Check | Fails when | Tool |
|---|---|---|
| Coverage | an executable line the PR adds or changes has no test hit, or a changed file is missing from the report | Vitest, v8 coverage (lcov) |
| CRAP | a function the PR adds or changes scores 10 or more, unless it was already 10 or more on base and scores no higher now | crapper |
| Duplication | the PR adds a structural duplicate pair at 0.8 similarity or above | dryer |
| Mutation | a mutant on a changed line survives, mutator fails on a file, or the budget runs out | mutator |

The thresholds (CRAP 10, similarity 0.8, a mutation budget of 5 to 30 minutes) are constants in `gate.py`, and a
self-test pins them. Changing one is an owner decision recorded in the engineering standard.

The gate is a port of the one in the sibling Bun repository (buildboard), adapted to Vitest: one scope, Vitest's
coverage, and a mutant command that copes with Vite resolving symbolic links (see Mutation).

## Scope

TypeScript under `src/`, minus tests and `.d.ts`. The test helpers under `test/`, the fake app server included, are
not judged.

A pure-deletion hunk judges no line. Every diff runs with `--no-color --no-ext-diff --no-textconv`, so git settings
cannot change what the gate reads, and a file whose hunks do not add up to git's own count stops the gate.

## Coverage

The gate runs `bun run coverage` itself (with the lcov report pinned), after deleting any old report, so a stale
report never stands in for it. `vitest.config.ts` lists every file under `src/`, so a file no test loads is in the
report at 0 hits.

The CLI entry points, `src/cli/bin.ts` and `src/conformance/cli.ts`, only run as child processes in the tests, which
v8 coverage does not see. Each changed line in them is reported on its own and can be waived (see Waivers). Keep them
thin: the logic belongs in `main.ts` and `runner.ts`, which the tests import.

The repo total (lines and functions, `src/` only) is compared with `baseline.json` and reported. A drop alone does
not fail the PR, because deleting covered code can cause it. A PR that raises a number updates `baseline.json`.

The gate and every mutant run with `TETHER_KEYCHAIN=off` and without `TETHER_REAL_SERVICE`, so nothing it runs
touches the OS keychain or installs a real launchd agent.

## CRAP ratchet

A changed function that already scores 10 or more on base passes when its CRAP is no higher than on base; the report
lists it as "still over the limit" with both scores. A new, moved or renamed function, and one that was under 10 on
base, must stay under 10. Functions match by file, name and order among same-named functions in the file; when the
count of a name in a file changes, every function of that name counts as new. A base function with no coverage
record is not scored (0% would be the highest base possible), so it is judged as new.

The base score is measured, not stored, and only when a touched function is over 10: the gate checks out base in a
throwaway worktree that borrows this checkout's `node_modules`, and runs the same coverage there.

## Mutation

Mutation runs only after every other check passed, on the changed lines of the changed files. The standard's
example command, `mutator --changed --test-command "bun run test"`, does not work here for two reasons, so the gate
calls mutator per file with `--lines` and its own test command, `mutant-tests.sh`:

- mutator runs each mutant in a worker under `target/mutation-workers` made of symbolic links to the tree and a copy
  of the mutated file. Vite resolves every module to its real path, so a linked test would import the original file
  and every mutant would survive. `mutant-tests.sh` first replaces the links with real copies (all but
  `node_modules`).
- The whole suite takes about 45 seconds. The script runs `vitest related` for the file first (the tests that import
  it, directly or not), on one Vitest worker, and the whole suite only for a mutant that survived: the entry points
  are reached only through child processes, which `related` cannot see.

A mutant is killed only when Vitest reports a failed test or a test file that failed to load. A run that writes no
report (a broken config, a crash) is a harness error and never a kill: the mutant shows as a survivor, and the gate
fails where a reviewer can see it.

The budget is sized to the change: the time already spent, plus for each file the rounds its sites need on its
workers (plus mutator's own unmutated run), times the measured time of the whole suite. It is never below 5 minutes
and never above 30. When it runs out, the check fails cleanly and still reports what finished and what was not
checked; the job timeout (45 minutes) sits above the largest budget.

The quality job removes the hosted runner's sudo rule before any code from the pull request runs, so no mutant can
run anything as root.

## Waivers

A surviving mutant or an untested changed line passes only with this line in the PR description, as a paragraph of
its own:

    Equivalent mutant: src/file.ts:42 why no test can tell the difference

One line waives every mutant on that line. The gate reads GitHub's own rendering of the description, fetched and
hashed before any code from the pull request runs, so a waiver counts only where a reviewer sees it. After editing
the description, re-run the quality job: it reads the description as it is when the job starts.

## Baseline

`baseline.json` holds the default branch's numbers: coverage, functions measured, functions over CRAP 10, duplicate
pairs, and the full mutation score from `full_baseline.py`, which mutates every site under `src/` with the gate's own
machinery. `.github/workflows/mutation-baseline.yml` runs it on a GitHub runner, by hand or on a pull request that
changes the script or that workflow, always on the base branch's `src/`. Copy its `RESULT` line and the run's URL
into `baseline.json`.

## Running it locally

    python3.12 -m venv /tmp/qv && /tmp/qv/bin/pip install -r .quality/requirements.txt
    PATH=/tmp/qv/bin:$PATH python3.12 -m unittest discover -s .quality -p 'test_*.py'
    PATH=/tmp/qv/bin:$PATH python3.12 .quality/gate.py --base origin/main
    PATH=/tmp/qv/bin:$PATH python3.12 .quality/full_baseline.py
