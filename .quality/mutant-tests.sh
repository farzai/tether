#!/bin/sh
# Test command for mutator: the Vitest tests that can see one mutated source file under src/.
#
# mutator runs each mutant in a worker directory under target/mutation-workers: symbolic links to the real
# tree and a private copy of the mutated file. Vite resolves every module to its real path, so in that layout
# a test would import the original, unmutated file and every mutant would survive. This script first replaces
# the links with real copies: every top-level entry except node_modules (and folders no test reads), and,
# inside the folders mutator expanded on the way to the mutated file, every linked child. The mutated file is
# already a real file and is left alone. In the repository root (mutator's own unmutated run) nothing is a
# link and nothing moves.
#
# The file comes in MUTANT_FILE (set by gate.py), so no file name is ever part of a command string.
#
# A mutant is killed only when Vitest reports a failed test or a test file that failed to load. A run that
# writes no report (a broken config, a crash) is a harness error, never a kill: it passes here, so the mutant
# shows as a survivor and the gate fails where a reviewer can see it.
set -eu

file=${MUTANT_FILE:?MUTANT_FILE is not set}
# No mutant may install a real launchd agent or touch the OS keychain or the user's own ~/.tether.
unset TETHER_REAL_SERVICE
export TETHER_KEYCHAIN=off
export TETHER_HOME="${TMPDIR:-/tmp}/tether-mutant-home-$$"
report=$(mktemp)
trap 'rm -rf "$TETHER_HOME" "$report"' EXIT

materialize() {
  for entry in "$1"/* "$1"/.[!.]*; do
    [ -L "$entry" ] || continue
    case "$entry" in
      ./node_modules | ./.git | ./target | ./coverage | ./.metrics) continue ;;
    esac
    target=$(readlink "$entry")
    rm -f "$entry"
    cp -R "$target" "$entry"
  done
}

materialize .
dir=$(dirname "$file")
while [ "$dir" != "." ] && [ "$dir" != "/" ]; do
  materialize "./$dir"
  dir=$(dirname "$dir")
done

vitest=./node_modules/.bin/vitest

# Runs Vitest with the given arguments. Exits the script with 1 when a test failed or a test file failed to
# load; returns otherwise, a harness error included.
tier() {
  rm -f "$report"
  "$vitest" "$@" --bail=1 --coverage.enabled=false --reporter=json --outputFile="$report" \
    >/dev/null 2>&1 || true
  [ -s "$report" ] || return 0
  failed=$(python3 -I -c 'import json, sys; d = json.load(open(sys.argv[1])); print(d["numFailedTests"] + d["numFailedTestSuites"])' \
    "$report" 2>/dev/null) || return 0
  if [ "$failed" -gt 0 ]; then
    exit 1
  fi
}

# Tier 1: the tests that import the file, directly or through other modules (Vitest's module graph). Most
# mutants die here in seconds.
# One Vitest worker: mutator already runs several mutants at once.
tier related --run --passWithNoTests --maxWorkers=1 "$file"
# Tier 2: the whole suite, for what reaches the file without importing it: the CLI entry points
# (src/cli/bin.ts, src/conformance/cli.ts) only run as child processes. Only a mutant that survived tier 1
# pays for this, and it keeps Vitest's own workers: the suite waits on child processes, and on one worker it
# takes minutes, which mutator's unmutated run of every file would pay too.
tier run
