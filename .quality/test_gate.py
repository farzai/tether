"""Self-tests for gate.py. Run from the repository root:  python -m unittest discover -s .quality -p 'test_*.py'"""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from contextlib import redirect_stdout
from unittest import mock
from pathlib import Path

sys.dont_write_bytecode = True
# absolute(), not resolve(): in a mutation worker this file is a link, and the gate beside it is the mutated copy
sys.path.insert(0, str(Path(__file__).absolute().parent))

import gate  # noqa: E402


def git(repo: Path, *args: str) -> str:
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
    return subprocess.run(["git", *args], cwd=repo, env=env, check=True, capture_output=True, text=True).stdout.strip()


class InRepo(unittest.TestCase):
    """A throwaway repository with src/a.ts committed; tests change it and diff against the first commit."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name)
        self._cwd = os.getcwd()
        os.chdir(self.repo)
        git(self.repo, "init", "-q")
        (self.repo / "src").mkdir(parents=True)
        self.write("src/a.ts", "\n".join(f"const line{n} = {n};" for n in range(1, 11)) + "\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "base")
        self.base = git(self.repo, "rev-parse", "HEAD")

    def tearDown(self) -> None:
        os.chdir(self._cwd)
        self._tmp.cleanup()

    def write(self, name: str, text: str) -> None:
        (self.repo / name).parent.mkdir(parents=True, exist_ok=True)
        (self.repo / name).write_text(text)

    def commit(self) -> None:
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "change")


class Thresholds(unittest.TestCase):
    def test_the_standard_thresholds_are_unchanged(self) -> None:
        # Lowering one needs an owner decision recorded in the engineering standard, never a PR on its own.
        self.assertEqual(gate.CRAP_LIMIT, 10)
        self.assertEqual(gate.DUPLICATE_THRESHOLD, 0.8)
        self.assertEqual((gate.MUTATION_BUDGET_MIN, gate.MUTATION_BUDGET_MAX), (300.0, 1800.0))


class Scope(unittest.TestCase):
    def test_source_under_src_is_in_scope(self) -> None:
        for path in ("src/client/policy.ts", "src/cli/bin.ts", "src/protocol/urls.ts"):
            with self.subTest(path=path):
                self.assertTrue(gate.in_scope(path))

    def test_tests_declarations_and_other_folders_are_out(self) -> None:
        for path in (
            "test/helpers.ts", "test/policy.test.ts", "test/fake-app/server.ts", "src/x.test.ts", "src/types.d.ts",
            "src/x.js", "schemas/a.json", "srcx/a.ts", ".quality/gate.py", "vitest.config.ts",
        ):
            with self.subTest(path=path):
                self.assertFalse(gate.in_scope(path))


class ChangedRanges(InRepo):
    def test_a_declaration_file_is_out_of_scope(self) -> None:
        self.write("src/types.d.ts", "declare const x: number;\n")
        self.commit()
        self.assertEqual(gate.changed_ranges(self.base), {})

    def test_a_test_file_is_out_of_scope(self) -> None:
        self.write("test/a.test.ts", "const x = 1;\n")
        self.commit()
        self.assertEqual(gate.changed_ranges(self.base), {})

    def test_deleting_the_first_line_judges_nothing(self) -> None:
        lines = (self.repo / "src/a.ts").read_text().splitlines()
        self.write("src/a.ts", "\n".join(lines[1:]) + "\n")
        self.commit()
        self.assertEqual(gate.changed_ranges(self.base), {})

    def test_deleting_a_lower_line_does_not_mark_the_line_above(self) -> None:
        lines = (self.repo / "src/a.ts").read_text().splitlines()
        del lines[2]
        self.write("src/a.ts", "\n".join(lines) + "\n")
        self.commit()
        self.assertEqual(gate.changed_ranges(self.base), {})

    def test_an_added_line_is_judged_even_next_to_a_deletion(self) -> None:
        lines = (self.repo / "src/a.ts").read_text().splitlines()
        lines[0:2] = ["const replaced = 0;"]
        self.write("src/a.ts", "\n".join(lines) + "\n")
        self.commit()
        self.assertEqual(gate.changed_ranges(self.base), {"src/a.ts": [(1, 1)]})

    def test_a_deletion_beside_an_added_line_adds_no_range(self) -> None:
        lines = (self.repo / "src/a.ts").read_text().splitlines()
        lines[7] = "const changed = 8;"
        del lines[2]
        self.write("src/a.ts", "\n".join(lines) + "\n")
        self.commit()
        self.assertEqual(gate.changed_ranges(self.base), {"src/a.ts": [(7, 7)]})

    def test_a_file_named_with_a_space_is_judged(self) -> None:
        self.write("src/my file.ts", "const a = 1;\nconst b = 2;\n")
        self.commit()
        self.assertEqual(gate.changed_ranges(self.base), {"src/my file.ts": [(1, 2)]})

    def test_a_file_named_with_a_non_ascii_character_is_judged(self) -> None:
        self.write("src/café.ts", "const a = 1;\n")
        self.commit()
        self.assertEqual(gate.changed_ranges(self.base), {"src/café.ts": [(1, 1)]})

    def test_a_file_named_with_a_tab_is_judged(self) -> None:
        self.write("src/tab\there.ts", "const a = 1;\n")
        self.commit()
        self.assertEqual(gate.changed_ranges(self.base), {"src/tab\there.ts": [(1, 1)]})

    def test_hunks_that_do_not_add_up_to_gits_count_stop_the_gate(self) -> None:
        self.write("src/b.ts", "const a = 1;\n")
        self.commit()
        with mock.patch.object(gate, "file_diff", return_value=""), self.assertRaises(SystemExit) as stop:
            gate.changed_ranges(self.base)
        self.assertIn("src/b.ts", str(stop.exception.code))

    def test_a_file_git_reads_as_binary_stops_the_gate(self) -> None:
        (self.repo / "src/blob.ts").write_bytes(b"\x00\x01\x02binary\n")
        self.commit()
        with self.assertRaises(SystemExit) as stop:
            gate.changed_ranges(self.base)
        self.assertIn("src/blob.ts", str(stop.exception.code))

    def test_git_settings_cannot_change_what_the_gate_reads(self) -> None:
        git(self.repo, "config", "diff.external", "false")
        git(self.repo, "config", "color.diff", "always")
        self.write("src/b.ts", "const a = 1;\n")
        self.commit()
        self.assertEqual(gate.changed_ranges(self.base), {"src/b.ts": [(1, 1)]})


class MainReport(InRepo):
    """The whole gate on a PR that changes no TypeScript: the waivers come from the rendered file, checked by its hash."""

    def setUp(self) -> None:
        super().setUp()
        self.write(".quality/baseline.json", json.dumps({"coverage": {"lines": 80.0, "functions": 80.0}}))
        self.write("coverage/lcov.info", "")
        self.write("README.md", "changed\n")
        self.commit()
        self.html = self.repo / "pr-body.html"
        self.html.write_text(RENDERED["plain"]["html"], encoding="utf-8")

    def main(self, *args: str) -> tuple[int, str]:
        argv = ["gate.py", "--base", self.base, "--skip-coverage-run", "--skip-mutation", *args]
        out = io.StringIO()
        env = {k: v for k, v in os.environ.items() if k != "GITHUB_STEP_SUMMARY"}
        with mock.patch.object(sys, "argv", argv), mock.patch.dict(os.environ, env, clear=True), redirect_stdout(out):
            code = gate.main()
        return code, out.getvalue()

    def test_a_matching_rendered_description_passes_and_lists_its_waivers(self) -> None:
        digest = hashlib.sha256(self.html.read_bytes()).hexdigest()
        code, report = self.main("--description-html", str(self.html), "--description-sha256", digest)
        self.assertEqual(code, 0, report)
        self.assertIn(f"## Quality gate (base {self.base[:8]})", report)
        self.assertIn("### Waivers: pass\n1 waiver(s) count", report)
        self.assertIn("  src/a.ts:3\n", report)
        self.assertIn("### CRAP: pass\nNo lines were added or changed", report)
        self.assertIn("### Mutation: pass\nNo lines were added or changed", report)

    def test_a_rendered_description_that_does_not_match_its_hash_fails_the_gate(self) -> None:
        code, report = self.main("--description-html", str(self.html), "--description-sha256", "0" * 64)
        self.assertEqual(code, 1)
        self.assertIn("### Waivers: FAIL\nThe rendered description does not match the sha256", report)

    def test_the_report_is_appended_to_the_step_summary(self) -> None:
        summary = self.repo / "summary.md"
        summary.write_text("before\n")
        with mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}):
            argv = ["gate.py", "--base", self.base, "--skip-coverage-run", "--skip-mutation"]
            with mock.patch.object(sys, "argv", argv), redirect_stdout(io.StringIO()):
                self.assertEqual(gate.main(), 0)
        text = summary.read_text()
        self.assertTrue(text.startswith("before\n## Quality gate"))
        self.assertIn("No rendered description was given: nothing is waived.", text)

    def test_the_suite_runs_with_coverage_and_its_time_reaches_mutation(self) -> None:
        self.write("src/b.ts", "export const b = 1\n")
        self.commit()
        lcov = "SF:src/b.ts\nDA:1,3\nLF:1\nLH:1\nend_of_record\n"
        argv = ["gate.py", "--base", self.base]
        with mock.patch.object(gate, "run_coverage", side_effect=lambda root: self.write("coverage/lcov.info", lcov) or 42.0), \
                mock.patch.object(gate, "check_crap", return_value=(True, [])), \
                mock.patch.object(gate, "check_duplicates", return_value=(True, [])), \
                mock.patch.object(gate, "check_mutation", return_value=(True, ["mutated"])) as mutation, \
                mock.patch.object(sys, "argv", argv), redirect_stdout(io.StringIO()) as out:
            os.environ.pop("GITHUB_STEP_SUMMARY", None)
            self.assertEqual(gate.main(), 0, out.getvalue())
        self.assertIn("The suite with coverage took 42s.", out.getvalue())
        self.assertEqual(mutation.call_args.args[4], 42.0)

    def test_a_check_that_breaks_fails_with_its_error_and_the_report_is_still_written(self) -> None:
        self.write("src/b.ts", "export const b = 1\n")
        self.commit()
        self.write("coverage/lcov.info", "SF:src/b.ts\nDA:1,3\nend_of_record\n")
        with mock.patch.object(gate, "check_crap", side_effect=ModuleNotFoundError("No module named 'crapper'")), \
                mock.patch.object(gate, "check_duplicates", side_effect=SystemExit("dryer failed")):
            code, report = self.main()
        self.assertEqual(code, 1)
        self.assertIn("### CRAP: FAIL\nThe check broke: ModuleNotFoundError: No module named 'crapper'", report)
        self.assertIn("### Duplication: FAIL\nThe check broke: SystemExit: dryer failed", report)

    def test_mutation_is_not_run_after_an_earlier_check_failed(self) -> None:
        self.write("src/b.ts", "export const b = 1;\n")
        self.commit()
        with mock.patch.object(gate, "check_crap", return_value=(True, [])), \
                mock.patch.object(gate, "check_duplicates", return_value=(True, [])), \
                mock.patch.object(gate, "check_mutation") as mutation:
            code, report = self.main()
        self.assertEqual(code, 1)
        self.assertIn("untested changed line src/b.ts (not in the coverage report", report)
        self.assertIn("### Mutation: FAIL\nNot run: an earlier check failed", report)
        mutation.assert_not_called()


RENDERED = json.loads((Path(__file__).resolve().parent / "rendered-descriptions.json").read_text(encoding="utf-8"))
"""Description bodies with GitHub's own rendering of each (POST /markdown, mode gfm), recorded so no test needs the
network. To add one, render the body with `gh api markdown -f mode=gfm -f text=<body>` and store both."""
REASON = "the two branches return the same value"


class EquivalentWaivers(unittest.TestCase):
    """Which waivers count in GitHub's rendering of a description: only a top-level paragraph that is the waiver."""

    def allowed(self, case: str) -> set[tuple[str, int]]:
        return set(gate.survivors_allowed(RENDERED[case]["html"]))

    def test_a_waiver_in_its_own_paragraph_counts_with_its_reason(self) -> None:
        self.assertEqual(gate.survivors_allowed(RENDERED["plain"]["html"]), {("src/a.ts", 3): REASON})

    def test_entities_read_as_the_page_shows_them(self) -> None:
        self.assertEqual(
            gate.survivors_allowed(RENDERED["entities"]["html"]), {("src/a.ts", 3): "a < b && c > d holds on both sides"}
        )

    def test_a_waiver_after_code_or_a_closed_comment_still_counts(self) -> None:
        for case in ("backtick_fence", "comment", "crlf"):
            with self.subTest(case=case):
                self.assertEqual(self.allowed(case), {("src/a.ts", 3)})

    def test_only_the_waivers_that_are_their_own_paragraph_count(self) -> None:
        self.assertEqual(self.allowed("adjacent"), {("src/a.ts", 5)})

    def test_a_waiver_github_shows_as_its_own_paragraph_counts(self) -> None:
        # GitHub drops <template> and keeps its content, and shows <script> and <style> as text outside any paragraph.
        self.assertEqual(self.allowed("hidden_elements"), {("src/a.ts", 3), ("src/a.ts", 4)})

    def test_a_waiver_a_reviewer_cannot_see_on_its_own_does_not_count(self) -> None:
        hidden = (
            "tilde_fence", "unclosed_fence", "unclosed_comment", "markup_before", "link_reference_title",
            "multi_line_alt", "attribute_across_blank_lines", "continues_paragraph", "indented",
            "backtick_in_info_string", "fence_inside_html_block", "details", "details_open", "blockquote_and_list",
            "mention_in_reason", "bidi_control", "unclosed_element",
        )
        for case in hidden:
            with self.subTest(case=case):
                self.assertEqual(self.allowed(case), set())

    def test_every_recorded_body_is_tested(self) -> None:
        source = Path(__file__).read_text(encoding="utf-8")
        self.assertEqual([case for case in RENDERED if f'"{case}"' not in source], [])

    def test_a_paragraph_with_attributes_or_a_self_closed_tag_does_not_count(self) -> None:
        waiver = f"Equivalent mutant: src/a.ts:3 {REASON}"
        for html in (f'<p hidden="">{waiver}</p>', f"<p>{waiver}<br/></p>", f"<p><br/>{waiver}</p>"):
            with self.subTest(html=html):
                self.assertEqual(gate.survivors_allowed(html), {})

    def test_a_stray_closing_tag_neither_hides_nor_reveals(self) -> None:
        waiver = f"Equivalent mutant: src/a.ts:3 {REASON}"
        self.assertEqual(set(gate.survivors_allowed(f"</div><p>{waiver}</span></p>")), {("src/a.ts", 3)})
        self.assertEqual(gate.survivors_allowed(f"<details></span><p>{waiver}</p>"), {})

    def test_a_waiver_after_an_element_closes_counts(self) -> None:
        waiver = f"Equivalent mutant: src/a.ts:3 {REASON}"
        html = f"<div><ul><li>x</li></ul><hr></div><p>{waiver}</p>"
        self.assertEqual(set(gate.survivors_allowed(html)), {("src/a.ts", 3)})

    def test_an_element_with_no_content_covers_nothing_after_it(self) -> None:
        waiver = f"Equivalent mutant: src/a.ts:3 {REASON}"
        self.assertEqual(set(gate.survivors_allowed(f"<hr>\n<p><img src=\"a\"></p>\n<p>{waiver}</p>")), {("src/a.ts", 3)})

    def test_a_waiver_after_other_text_in_its_paragraph_does_not_count(self) -> None:
        self.assertEqual(gate.survivors_allowed(f"<p>See Equivalent mutant: src/a.ts:3 {REASON}</p>"), {})

    def test_a_paragraph_inside_an_element_inside_a_paragraph_does_not_count(self) -> None:
        waiver = f"Equivalent mutant: src/a.ts:3 {REASON}"
        self.assertEqual(gate.survivors_allowed(f"<p><details><p>{waiver}</p></details></p>"), {})

    def test_text_split_by_a_comment_reads_as_the_page_shows_it(self) -> None:
        html = f"<p>Equivalent mut<!-- x -->ant: src/a.ts:3 {REASON}</p>"
        self.assertEqual(set(gate.survivors_allowed(html)), {("src/a.ts", 3)})

    def test_a_stray_end_tag_after_a_waiver_paragraph_adds_nothing_to_it(self) -> None:
        # Once its paragraph closes, nothing that follows (a stray end tag, then text) is collected for it.
        waiver = f"Equivalent mutant: src/a.ts:3 {REASON}"
        parser = gate.TopLevelParagraphs()
        parser.feed(f"<p>{waiver}</p></div>tail")
        self.assertEqual(parser.found, [waiver])
        self.assertIsNone(parser.text)
        parser.feed(f"<p>Equivalent mutant: src/a.ts:4 {REASON}</p>")
        self.assertEqual(parser.found, [waiver, f"Equivalent mutant: src/a.ts:4 {REASON}"])

    def test_a_bidi_control_on_a_later_line_of_the_paragraph_waives_nothing(self) -> None:
        self.assertEqual(gate.survivors_allowed(f"<p>Equivalent mutant: src/a.ts:3\nthe two \u202ebranches return the same</p>"), {})
        self.assertEqual(gate.survivors_allowed(f"<p>Equivalent mutant: src/a.ts:3\n{REASON}</p>"), {("src/a.ts", 3): REASON})

    def test_a_waiver_for_line_0_does_not_parse(self) -> None:
        for line in ("0", "00"):
            with self.subTest(line=line):
                self.assertEqual(gate.survivors_allowed(f"<p>Equivalent mutant: src/a.ts:{line} {REASON}</p>"), {})
        self.assertEqual(set(gate.survivors_allowed(f"<p>Equivalent mutant: src/a.ts:10 {REASON}</p>")), {("src/a.ts", 10)})

    def test_closing_an_element_closes_what_it_left_open(self) -> None:
        waiver = f"Equivalent mutant: src/a.ts:3 {REASON}"
        self.assertEqual(set(gate.survivors_allowed(f"<div><span><b></div><p>{waiver}</p>")), {("src/a.ts", 3)})


class ReadWaivers(unittest.TestCase):
    """The waivers come from a file an earlier workflow step rendered, checked against the sha256 that step gave."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "pr-body.html"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def rendered(self, html: str) -> tuple[str, str]:
        self.path.write_bytes(html.encode())
        return str(self.path), hashlib.sha256(html.encode()).hexdigest()

    def test_waivers_are_read_from_the_rendered_file_that_matches_its_hash(self) -> None:
        path, digest = self.rendered(RENDERED["plain"]["html"])
        ok, lines, allowed = gate.read_waivers(path, digest)
        self.assertTrue(ok)
        self.assertEqual(allowed, {("src/a.ts", 3): REASON})
        self.assertEqual(lines, ["1 waiver(s) count, each the whole text of a top-level paragraph on GitHub.", "  src/a.ts:3"])

    def test_the_hash_is_compared_without_regard_to_case_or_surrounding_space(self) -> None:
        path, digest = self.rendered(RENDERED["plain"]["html"])
        ok, _lines, allowed = gate.read_waivers(path, f" {digest.upper()}\n")
        self.assertTrue(ok)
        self.assertEqual(set(allowed), {("src/a.ts", 3)})

    def test_without_a_rendered_file_nothing_is_waived(self) -> None:
        ok, lines, allowed = gate.read_waivers(None, None)
        self.assertEqual((ok, allowed), (True, {}))
        self.assertEqual(lines, ["No rendered description was given: nothing is waived."])

    def test_a_file_that_cannot_be_read_fails(self) -> None:
        ok, lines, allowed = gate.read_waivers(str(self.path), "0" * 64)
        self.assertEqual((ok, allowed), (False, {}))
        self.assertIn("cannot be read", lines[0])

    def test_a_file_that_does_not_match_its_hash_fails(self) -> None:
        path, digest = self.rendered(RENDERED["plain"]["html"])
        self.path.write_bytes(RENDERED["plain"]["html"].encode() + b"<p>x</p>")
        for sha in (digest, None, ""):
            with self.subTest(sha=sha):
                ok, lines, allowed = gate.read_waivers(path, sha)
                self.assertEqual((ok, allowed), (False, {}))
                self.assertIn("does not match the sha256", lines[0])

    def test_the_gate_no_longer_talks_to_the_network(self) -> None:
        source = Path(gate.__file__).read_text(encoding="utf-8")
        self.assertNotIn("urllib", source)
        self.assertNotIn("GITHUB_TOKEN", source)


WORKFLOW = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "ci.yml"


def job_text(name: str) -> str:
    """One job of ci.yml without its comment lines, so only what runs is checked."""
    lines = WORKFLOW.read_text(encoding="utf-8").splitlines(keepends=True)
    text = "".join(line for line in lines if not line.lstrip().startswith("#"))
    start = text.index(f"\n  {name}:\n") + 1
    rest = text[start + 1 :]
    following = [rest.index(f"\n  {m}") for m in ("check:", "quality:") if f"\n  {m}" in rest]
    return text[start : start + 1 + min(following)] if following else text[start:]


def workflow_steps() -> list[str]:
    """Each step of the quality job as its block of text, in order."""
    text = job_text("quality")
    body = text[text.index("    steps:\n") :]
    return [block for block in body.split("\n      - ")[1:]]


class QualityWorkflow(unittest.TestCase):
    """The token reaches only the steps that run before any code from the pull request, and no action's post step."""

    CREDENTIAL = ("github.token", "secrets.", "GITHUB_TOKEN")

    def step(self, needle: str) -> tuple[int, str]:
        found = [(n, block) for n, block in enumerate(workflow_steps()) if needle in block]
        self.assertEqual(len(found), 1, needle)
        return found[0]

    def test_the_job_runs_on_every_pull_request_on_one_hosted_linux_runner(self) -> None:
        text = WORKFLOW.read_text(encoding="utf-8")
        on = text[text.index("\non:") : text.index("\njobs:")]
        self.assertNotIn("paths", on)  # a path filter would let a PR skip the gate
        job = job_text("quality")
        self.assertIn("runs-on: ubuntu-latest", job)
        self.assertIn("if: github.event_name == 'pull_request'", job)

    def test_only_the_checkout_and_render_steps_get_the_token(self) -> None:
        checkout, _ = self.step("name: Check out the pull request")
        render, _ = self.step("name: Render the pull request description")
        install, _ = self.step("run: bun install --frozen-lockfile")
        self.assertEqual((checkout, render), (0, 1))
        self.assertLess(render, install)
        holders = [n for n, block in enumerate(workflow_steps()) if any(word in block for word in self.CREDENTIAL)]
        self.assertEqual(holders, [checkout, render])
        job = job_text("quality")
        self.assertEqual(sum(job.count(word) for word in self.CREDENTIAL), 2)  # not at job level either

    def test_no_action_takes_the_token_by_default(self) -> None:
        self.assertNotIn("actions/checkout", job_text("quality"))
        for action in ("oven-sh/setup-bun@", "actions/setup-python@"):
            with self.subTest(action=action):
                _, block = self.step(action)
                self.assertIn('token: ""', block)
        uses = [block for block in workflow_steps() if block.startswith("uses:")]
        self.assertEqual(len(uses), 2)

    def test_steps_with_the_token_fail_on_any_broken_command_and_inline_no_expression(self) -> None:
        for name in ("name: Check out the pull request", "name: Render the pull request description"):
            with self.subTest(step=name):
                _, block = self.step(name)
                script = block[block.index("run: |") :]
                self.assertIn("set -o pipefail", script)
                self.assertNotIn("${{", script)
        _, render = self.step("name: Render the pull request description")
        self.assertIn("/markdown", render)
        self.assertEqual(render.count("--fail "), 2)

    def test_the_token_can_read_the_pull_request_and_nothing_more(self) -> None:
        job = job_text("quality")
        block = job[job.index("    permissions:\n") :].split("\n    runs-on")[0]
        self.assertEqual(block.splitlines()[1:], ["      contents: read", "      pull-requests: read"])
        text = WORKFLOW.read_text(encoding="utf-8")
        top = text[text.index("\npermissions:") : text.index("\njobs:")]
        self.assertNotIn("write", top)

    def test_the_gate_reads_the_rendered_file_and_its_hash_and_outlives_its_budget(self) -> None:
        _, block = self.step("name: Quality gate")
        self.assertIn('--description-html "$RUNNER_TEMP/pr-body.html"', block)
        self.assertIn("--description-sha256", block)
        self.assertIn("steps.description.outputs.sha256", block)
        minutes = int(job_text("quality").split("timeout-minutes:")[1].split()[0])
        # The job must outlive the largest mutation budget, or the runner kills it and the report with it.
        self.assertGreater(minutes * 60, gate.MUTATION_BUDGET_MAX + 600)


LCOV = textwrap.dedent(
    """\
    TN:
    SF:src/a.ts
    FNF:4
    FNH:3
    DA:1,3
    DA:2,0
    DA:5,0
    DA:6,1
    LF:4
    LH:2
    end_of_record
    SF:/abs/checkout/src/b.ts
    FNF:1
    FNH:1
    DA:1,0
    LF:6
    LH:5
    end_of_record
    SF:test/helpers.ts
    FNF:10
    FNH:0
    LF:100
    LH:0
    end_of_record
    """
)


class UncoveredChangedLines(unittest.TestCase):
    def test_an_executable_changed_line_with_no_hits_is_reported(self) -> None:
        found = gate.uncovered_changed({"src/a.ts": [(1, 2), (6, 6)]}, LCOV)
        self.assertEqual(found, [("src/a.ts", 2)])

    def test_a_changed_line_that_is_not_executable_is_ignored(self) -> None:
        self.assertEqual(gate.uncovered_changed({"src/a.ts": [(3, 4)]}, LCOV), [])

    def test_absolute_paths_in_the_report_match_by_suffix(self) -> None:
        self.assertEqual(gate.uncovered_changed({"src/b.ts": [(1, 1)]}, LCOV), [("src/b.ts", 1)])

    def test_a_file_missing_from_the_report_is_reported_whole(self) -> None:
        self.assertEqual(gate.uncovered_changed({"src/c.ts": [(4, 5)]}, LCOV), [("src/c.ts", 0)])


class LcovTotals(unittest.TestCase):
    def test_the_totals_count_only_in_scope_files(self) -> None:
        # src/a.ts 2 of 4 lines and 3 of 4 functions; the absolute b.ts path is not in scope by name, and
        # the test helper never counts.
        self.assertEqual(gate.lcov_totals(LCOV), {"lines": 50.0, "functions": 75.0})

    def test_an_empty_report_is_full(self) -> None:
        self.assertEqual(gate.lcov_totals(""), {"lines": 100.0, "functions": 100.0})


class CoverageVerdict(unittest.TestCase):
    BASELINE = {"coverage": {"lines": 98.92, "functions": 95.07}}

    def verdict(self, uncovered, allowed=None, now=None):
        return gate.coverage_verdict(uncovered, allowed or {}, now or {"lines": 90.0, "functions": 90.0}, self.BASELINE)

    def test_a_lower_repo_total_alone_does_not_fail_but_is_reported(self) -> None:
        ok, lines = self.verdict([])
        self.assertTrue(ok)
        self.assertIn("lines 90.0% (baseline 98.92%)", lines[1])
        self.assertTrue(any("Below the baseline" in line for line in lines))

    def test_a_higher_repo_total_asks_for_the_baseline_to_be_updated(self) -> None:
        _, lines = self.verdict([], now={"lines": 99.0, "functions": 95.07})
        self.assertTrue(any("update coverage in .quality/baseline.json" in line for line in lines))

    def test_an_uncovered_changed_line_fails(self) -> None:
        ok, _ = self.verdict([("src/a.ts", 2)])
        self.assertFalse(ok)

    def test_an_override_with_a_reason_waives_the_line(self) -> None:
        ok, _ = self.verdict([("src/a.ts", 2)], {("src/a.ts", 2): "only reachable as another user"})
        self.assertTrue(ok)

    def test_no_waiver_covers_a_file_missing_from_the_coverage_report(self) -> None:
        allowed = gate.survivors_allowed(f"<p>Equivalent mutant: src/c.ts:0 {REASON}</p>")
        ok, lines = self.verdict(gate.uncovered_changed({"src/c.ts": [(4, 5)]}, LCOV), allowed)
        self.assertFalse(ok)
        self.assertTrue(any("src/c.ts (not in the coverage report" in line for line in lines))


DRYER = (
    "Scanning src\n"
    "DUPLICATE score=0.91 kind=function\n  src/a.ts:1-9\n  src/b.ts:3-11\n"
    "DUPLICATE score=0.85 kind=function\n  src/c.ts:2-8\n  src/d.ts:4-10\n"
)


class DryerOutput(unittest.TestCase):
    def test_the_output_is_parsed_into_pairs(self) -> None:
        self.assertEqual(
            gate.parse_dryer(DRYER),
            [(0.91, ("src/a.ts", 1, 9), ("src/b.ts", 3, 11)),
             (0.85, ("src/c.ts", 2, 8), ("src/d.ts", 4, 10))],
        )

    def test_no_duplicates_is_no_pairs(self) -> None:
        self.assertEqual(gate.parse_dryer("No duplicate candidates found.\n"), [])

    def test_a_block_the_gate_cannot_read_stops_the_gate(self) -> None:
        for block in (
            "DUPLICATE kind=function\n  src/e.ts:1-2\n  src/f.ts:1-2\n",
            "DUPLICATE score=0.9\n  src/e.ts:1-2\n",
        ):
            with self.subTest(block=block), self.assertRaises(SystemExit) as stop:
                gate.parse_dryer(DRYER + block)
            self.assertIn("3 DUPLICATE blocks but 2 pairs", str(stop.exception.code))

    def test_only_a_marker_at_the_start_of_a_line_starts_a_block(self) -> None:
        preamble = "score=0.5 in a header\n  src/e.ts:1-2\n  src/f.ts:1-2\n"
        self.assertEqual(len(gate.parse_dryer(preamble + DRYER)), 2)


class DuplicateVerdict(unittest.TestCase):
    PAIR = (0.9, ("src/a.ts", 10, 20), ("src/b.ts", 30, 40))

    def test_a_new_pair_on_a_changed_line_fails(self) -> None:
        ok, lines = gate.duplicate_verdict({"src/a.ts": [(12, 12)]}, [], [self.PAIR])
        self.assertFalse(ok)
        self.assertIn("  new duplicate: src/a.ts:10-20 and src/b.ts:30-40 (similarity 0.90)", lines)

    def test_a_pair_already_on_base_passes(self) -> None:
        ok, _ = gate.duplicate_verdict({"src/a.ts": [(12, 12)]}, [self.PAIR], [self.PAIR])
        self.assertTrue(ok)

    def test_a_pair_the_pr_did_not_touch_passes(self) -> None:
        ok, _ = gate.duplicate_verdict({"src/a.ts": [(1, 5)]}, [], [self.PAIR])
        self.assertTrue(ok)


class DryerRun(InRepo):
    @unittest.skipUnless(shutil.which("dryer"), "needs dryer")
    def test_a_copied_function_is_found_by_the_real_dryer_and_tests_are_skipped(self) -> None:
        body = "export function f{n}(a: number[]): number {{\n  let t = 0\n  for (const x of a) {{\n    if (x > 2) {{\n      t += x * 3\n    }} else {{\n      t -= x\n    }}\n  }}\n  return t\n}}\n"
        self.write("src/c.ts", body.format(n=1))
        self.write("src/d.ts", body.format(n=2))
        self.write("test/e.ts", body.format(n=3))
        pairs = gate.dryer_pairs(self.repo)
        self.assertEqual({tuple(sorted((p[1][0], p[2][0]))) for p in pairs}, {("src/c.ts", "src/d.ts")})
        self.assertFalse((self.repo / ".metrics").exists())


SLOW = 'case "$*" in *--scan*) echo "  src/x.ts:1 a -> b";; *) sleep 30;; esac\n'


class MutationBudget(InRepo):
    def stub_mutator(self, body: str) -> Path:
        bin_dir = self.repo / "bin"
        bin_dir.mkdir(exist_ok=True)
        script = bin_dir / "mutator"
        script.write_text("#!/bin/sh\n" + body)
        script.chmod(script.stat().st_mode | stat.S_IEXEC)
        return bin_dir

    def check(self, body: str, changed, seconds_left: float, workers: int = 1):
        """check_mutation with the whole budget (30 minutes, the most there is) spent but `seconds_left`."""
        bin_dir = self.stub_mutator(body)
        started = time.monotonic() - gate.MUTATION_BUDGET_MAX + seconds_left
        with mock.patch.dict(os.environ, {"PATH": f"{bin_dir}:{os.environ['PATH']}"}):
            return gate.check_mutation(changed, self.repo, {}, started, 1000.0, workers)

    def test_running_out_of_budget_fails_cleanly_with_what_was_not_checked(self) -> None:
        ok, lines = self.check(SLOW, {"src/a.ts": [(1, 3)], "src/b.ts": [(1, 2)]}, 1.0)
        text = "\n".join(lines)
        self.assertFalse(ok)
        self.assertIn("budget ran out", text)
        self.assertIn("src/a.ts", text)
        self.assertIn("src/b.ts", text)
        self.assertLess(text.index("re-run"), text.index("split"))

    def test_the_slow_mutator_is_actually_stopped(self) -> None:
        start = time.monotonic()
        self.check(SLOW, {"src/a.ts": [(1, 3)]}, 1.0)
        self.assertLess(time.monotonic() - start, 10)

    def test_a_finished_run_inside_the_budget_reports_survivors(self) -> None:
        body = 'case "$*" in *--scan*) echo "  src/a.ts:1 > -> >=";; *) echo "SURVIVED  src/a.ts:1 > -> >="; exit 3;; esac\n'
        ok, lines = self.check(body, {"src/a.ts": [(1, 1)]}, 60.0)
        self.assertFalse(ok)
        self.assertIn("survivor src/a.ts:1", "\n".join(lines))

    def test_a_mutator_failure_on_one_file_still_reports_the_others(self) -> None:
        body = (
            'case "$*" in *--scan*) echo "  $1:1 a -> b"; exit 0;; esac\n'
            'case "$1" in *a.ts) echo "KILLED  $1:1 a -> b"; exit 0;; *) echo boom; exit 2;; esac\n'
        )
        ok, lines = self.check(body, {"src/a.ts": [(1, 1)], "src/b.ts": [(1, 1)]}, 60.0, workers=2)
        text = "\n".join(lines)
        self.assertFalse(ok)
        self.assertIn("1 mutant(s) killed", text)
        self.assertIn("mutator failed on src/b.ts (exit 2)", text)

    def test_the_file_reaches_the_test_command_through_the_environment_only(self) -> None:
        record = self.repo / "record.txt"
        body = (
            'case "$*" in *--scan*) echo "  x:1 a -> b"; exit 0;; esac\n'
            f'echo "$*" > "{record}"; echo "env=$MUTANT_FILE real=${{TETHER_REAL_SERVICE:-unset}} keychain=${{TETHER_KEYCHAIN:-unset}}" >> "{record}"\n'
        )
        with mock.patch.dict(os.environ, {"TETHER_REAL_SERVICE": "1", "TETHER_KEYCHAIN": "on"}):
            self.check(body, {"src/client/policy.ts": [(1, 2)]}, 60.0)
        args, env_line = record.read_text().splitlines()[:2]
        self.assertNotIn("policy.ts", args.split("--test-command", 1)[1])
        self.assertEqual(env_line, "env=src/client/policy.ts real=unset keychain=off")  # no mutant may install a launchd agent or reach the keychain

    def test_a_file_name_is_not_run_through_a_shell(self) -> None:
        self.assertFalse(gate.safe_path("src/a.ts; touch pwned"))
        self.assertFalse(gate.safe_path("src/../../etc.ts"))
        self.assertTrue(gate.safe_path("src/client/policy.ts"))

    def test_no_more_mutator_processes_than_the_limit_run_at_once(self) -> None:
        running = self.repo / "running"
        counts = self.repo / "counts.txt"
        running.mkdir()
        body = (
            'case "$*" in *--scan*) echo "  $1:1 a -> b"; exit 0;; esac\n'
            f'touch "{running}/$$"; ls "{running}" | wc -l >> "{counts}"; sleep 1; rm "{running}/$$"\n'
        )
        self.check(body, {f"src/f{i}.ts": [(1, 1)] for i in range(6)}, 120.0, workers=2)
        peak = max(int(line) for line in counts.read_text().split())
        self.assertLessEqual(peak, 2)
        self.assertEqual(len(counts.read_text().split()), 6)

    def test_the_kill_scans_again_until_no_tagged_process_is_left(self) -> None:
        with mock.patch.object(gate, "_kill_pass", side_effect=[2, 1, 0]) as scan:
            gate.kill_tagged("tag")
        self.assertEqual(scan.call_count, 3)


class BudgetSizing(unittest.TestCase):
    def test_a_small_change_gets_the_five_minute_floor(self) -> None:
        self.assertEqual(gate.mutation_budget(60.0, {"a": 2}, {"a": 2}, 2, 30.0), 300.0)

    def test_the_budget_grows_with_the_rounds_the_sites_need(self) -> None:
        # 20 sites on 2 workers: 10 rounds plus mutator's unmutated run, 11 x 40 s, after 100 s already spent.
        self.assertEqual(gate.mutation_budget(100.0, {"a": 20}, {"a": 2}, 2, 40.0), 540.0)

    def test_files_beyond_the_slots_queue(self) -> None:
        # Three files of 1 site on 1 worker each, 2 slots: 6 rounds over 2 slots is 3, 3 x 100 s.
        self.assertEqual(gate.mutation_budget(0.0, {"a": 1, "b": 1, "c": 1}, {"a": 1, "b": 1, "c": 1}, 2, 100.0), 300.0)
        self.assertEqual(gate.mutation_budget(0.0, {"a": 1, "b": 1, "c": 1}, {"a": 1, "b": 1, "c": 1}, 2, 150.0), 450.0)

    def test_the_budget_never_passes_thirty_minutes(self) -> None:
        self.assertEqual(gate.mutation_budget(0.0, {"a": 500}, {"a": 2}, 2, 96.0), 1800.0)

    def test_a_scan_that_did_not_finish_counts_as_one_site(self) -> None:
        self.assertEqual(gate.mutation_budget(0.0, {"a": "unknown"}, {"a": 1}, 1, 200.0), 400.0)


class Workers(unittest.TestCase):
    def test_workers_follow_the_sites_of_each_file(self) -> None:
        self.assertEqual(gate.plan_workers({"a": 100}, 4), {"a": 4})
        self.assertEqual(gate.plan_workers({"a": 0}, 4), {})
        self.assertEqual(gate.plan_workers({"a": 5, "b": 5, "c": 5}, 2), {"a": 1, "b": 1, "c": 1})

    def test_the_total_never_goes_over_the_limit(self) -> None:
        many = {"big": 100, **{f"f{i}": 1 for i in range(23)}}
        self.assertEqual(sum(gate.plan_workers(many, 24).values()), 24)
        plan = gate.plan_workers({"a": "unknown", "b": 100, "c": "unknown"}, 24)
        self.assertEqual(sum(plan.values()), 24)

    def test_a_cgroup_cpu_quota_caps_the_cores(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "cpu.max").write_text("200000 100000\n")
            self.assertEqual(gate.available_cores(Path(tmp)), min(2, gate.available_cores(Path(tmp) / "none")))

    def test_memory_caps_the_workers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "memory.max").write_text(str(8 << 30) + "\n")
            self.assertEqual(gate.worker_limit(24, gate.memory_limit(Path(tmp))), 6)
            Path(tmp, "memory.max").write_text("max\n")
            meminfo = Path(tmp, "meminfo")
            meminfo.write_text("MemTotal:       16777216 kB\n")
            self.assertEqual(gate.memory_limit(Path(tmp), meminfo), 16 << 30)
        self.assertEqual(gate.worker_limit(4, None), 4)
        self.assertEqual(gate.worker_limit(4, 1 << 30), 1)


class CrapVerdict(unittest.TestCase):
    """The CRAP ratchet: a function already over the limit on base may stay, never get worse."""

    def verdict(self, head, base, touched=None):
        keys = {key for key, *_ in head} if touched is None else touched
        return gate.crap_verdict(head, keys, base)

    @staticmethod
    def fn(crap, name="big", path="src/a.ts", nth=0, line=10):
        return ((path, name, nth), line, crap, 40, 90.0)

    def test_same_score_as_base_passes_and_says_it_is_still_over(self) -> None:
        ok, lines = self.verdict([self.fn(67.3)], {("src/a.ts", "big", 0): 67.3})
        self.assertTrue(ok)
        self.assertTrue(any("still over the limit" in line and "67.3" in line and "base 67.3" in line for line in lines))
        self.assertFalse(any("over the limit:" in line for line in lines))

    def test_lower_score_than_base_passes(self) -> None:
        ok, _ = self.verdict([self.fn(60.0)], {("src/a.ts", "big", 0): 67.3})
        self.assertTrue(ok)

    def test_higher_score_than_base_fails_and_prints_both(self) -> None:
        ok, lines = self.verdict([self.fn(67.4)], {("src/a.ts", "big", 0): 67.3})
        self.assertFalse(ok)
        self.assertTrue(any("over the limit:" in line and "67.4" in line and "was 67.3 on base (higher)" in line for line in lines))

    def test_a_higher_raw_score_fails_even_when_it_prints_the_same(self) -> None:
        ok, lines = self.verdict([self.fn(67.34)], {("src/a.ts", "big", 0): 67.26})
        self.assertFalse(ok)
        self.assertTrue(any("67.3" in line and "higher" in line for line in lines))

    def test_an_equal_raw_score_passes(self) -> None:
        ok, _ = self.verdict([self.fn(67.26)], {("src/a.ts", "big", 0): 67.26})
        self.assertTrue(ok)

    def test_a_new_function_with_a_name_the_file_already_had_is_new(self) -> None:
        # Head has two "big"; base had one. Matching by order would compare the new first one with the old one.
        head = [self.fn(15.0, nth=0), self.fn(67.0, nth=1)]
        ok, lines = self.verdict(head, {("src/a.ts", "big", 0): 67.0})
        self.assertFalse(ok)
        self.assertTrue(any("new function" in line for line in lines))

    def test_a_function_removed_from_a_same_named_pair_is_new_too(self) -> None:
        ok, _ = self.verdict([self.fn(67.0)], {("src/a.ts", "big", 0): 67.0, ("src/a.ts", "big", 1): 80.0})
        self.assertFalse(ok)

    def test_the_same_count_of_a_name_still_matches_by_order(self) -> None:
        head = [self.fn(20.0, nth=0), self.fn(25.0, nth=1)]
        ok, _ = self.verdict(head, {("src/a.ts", "big", 0): 20.0, ("src/a.ts", "big", 1): 25.0})
        self.assertTrue(ok)

    def test_names_in_another_file_do_not_change_the_count(self) -> None:
        head = [self.fn(67.0), self.fn(5.0, path="src/b.ts", nth=0), self.fn(6.0, path="src/b.ts", nth=1)]
        ok, _ = self.verdict(head, {("src/a.ts", "big", 0): 67.0})
        self.assertTrue(ok)

    def test_under_the_limit_on_base_and_over_now_fails(self) -> None:
        ok, lines = self.verdict([self.fn(10.0)], {("src/a.ts", "big", 0): 9.9})
        self.assertFalse(ok)
        self.assertTrue(any("was 9.9 on base (under the limit)" in line for line in lines))

    def test_a_new_function_over_the_limit_fails(self) -> None:
        ok, lines = self.verdict([self.fn(12.0, name="fresh")], {("src/a.ts", "big", 0): 67.3})
        self.assertFalse(ok)
        self.assertTrue(any("new function" in line for line in lines))

    def test_a_renamed_function_is_new(self) -> None:
        ok, _ = self.verdict([self.fn(67.3, name="renamed")], {("src/a.ts", "big", 0): 67.3})
        self.assertFalse(ok)

    def test_a_moved_function_is_new(self) -> None:
        ok, _ = self.verdict([self.fn(67.3, path="src/b.ts")], {("src/a.ts", "big", 0): 67.3})
        self.assertFalse(ok)

    def test_a_second_function_of_the_same_name_is_matched_by_order(self) -> None:
        head = [self.fn(20.0, nth=0), self.fn(30.0, nth=1)]
        ok, _ = self.verdict(head, {("src/a.ts", "big", 0): 20.0, ("src/a.ts", "big", 1): 25.0})
        self.assertFalse(ok)

    def test_a_function_under_the_limit_passes_without_a_base(self) -> None:
        ok, lines = self.verdict([self.fn(9.9, name="small")], None)
        self.assertTrue(ok)
        self.assertIn("1 added or changed function(s) scored", lines[0])

    def test_functions_the_pr_did_not_touch_are_not_judged(self) -> None:
        ok, lines = self.verdict([self.fn(99.0)], {}, touched=set())
        self.assertTrue(ok)
        self.assertIn("0 added or changed function(s) scored", lines[0])



class CrapBase(InRepo):
    """base_scores, touched_functions and crapper on an lcov report, against a throwaway repository."""

    def test_touched_functions_names_only_the_functions_with_a_changed_line(self) -> None:
        self.write("src/f.ts", "function one() {\n  return 1;\n}\n\nfunction two() {\n  return 2;\n}\n\nfunction two() {\n  return 3;\n}\n")
        self.assertEqual(gate.touched_functions(self.repo, {"src/f.ts": [(6, 6)]}), {("src/f.ts", "two", 0)})
        self.assertEqual(
            gate.touched_functions(self.repo, {"src/f.ts": [(1, 1), (10, 10)]}),
            {("src/f.ts", "one", 0), ("src/f.ts", "two", 1)},
        )

    def test_crapper_scores_from_the_line_records(self) -> None:
        source = (
            "export function pick(a: number, b: number): number {\n"
            "  if (a > b) {\n    return a\n  }\n  if (a < 0) {\n    return 0\n  }\n  return b\n}\n"
        )
        self.write("src/p.ts", source)
        # Only FNF/FNH counts and DA lines, so the score comes from the lines. Lines 3 and 6 never ran.
        hits = {1: 4, 2: 4, 3: 0, 4: 4, 5: 4, 6: 0, 7: 4, 8: 4, 9: 4}
        self.write(
            "coverage/lcov.info",
            "TN:\nSF:src/p.ts\nFNF:1\nFNH:1\n" + "".join(f"DA:{n},{h}\n" for n, h in hits.items())
            + "LF:9\nLH:7\nend_of_record\n",
        )
        [(key, _line, crap, complexity, coverage)] = gate.scored_functions(self.repo, ["src/p.ts"])
        self.assertEqual(key, ("src/p.ts", "pick", 0))
        self.assertEqual(complexity, 3)
        self.assertGreater(coverage, 50.0)  # read from the DA lines, not 0% for a missing FN record
        self.assertLess(coverage, 100.0)
        self.assertLess(crap, 9 + 3)  # 0% coverage would score complexity squared plus complexity

    def run_base_scores(self, scored, paths):
        runs: list[Path] = []
        (self.repo / "node_modules").mkdir()
        with mock.patch.object(gate, "run_coverage", side_effect=lambda root: runs.append(root) or 1.0), \
                mock.patch.object(gate, "scored_functions", scored):
            return gate.base_scores(self.base, self.repo, paths), runs

    def test_base_scores_measures_the_files_that_exist_on_base_with_coverage_required(self) -> None:
        seen = {}

        def scored(root, paths, need_coverage=False):
            seen.update(need_coverage=need_coverage, modules=(root / "node_modules").is_symlink(), paths=paths)
            return [(("src/a.ts", "f", 0), 1, 42.0, 7, 80.0)]

        result, runs = self.run_base_scores(scored, ["src/a.ts", "src/new.ts"])
        self.assertEqual(result, {("src/a.ts", "f", 0): 42.0})
        self.assertEqual(seen, {"need_coverage": True, "modules": True, "paths": ["src/a.ts"]})
        self.assertEqual(len(runs), 1)
        self.assertNotEqual(runs[0], self.repo)  # the base tree, not this checkout

    def test_base_scores_runs_nothing_when_no_file_is_on_base_and_removes_its_worktree(self) -> None:
        result, runs = self.run_base_scores(lambda root, paths, need_coverage=False: [], ["src/new.ts"])
        self.assertEqual((result, runs), ({}, []))
        self.assertNotIn("quality-base", git(self.repo, "worktree", "list"))

    def test_a_base_function_without_a_coverage_record_is_not_scored(self) -> None:
        class Bundle:
            def bind_sources(self, paths):
                pass

            def percent_for(self, function):
                return None

        class Fn:
            name = "big"
            start_line = 1
            end_line = 3

        entry = mock.Mock(crap=9999.0, complexity=70, coverage=0.0)
        with (
            mock.patch("crapper.coverage.load_bundle", return_value=Bundle()),
            mock.patch("crapper.languages.functions_in_file", return_value=[Fn()]),
            mock.patch("crapper.crap.make_entry", return_value=entry),
        ):
            self.write("src/f.ts", "x\n")
            self.assertEqual(gate.scored_functions(self.repo, ["src/f.ts"], need_coverage=True), [])
            self.assertEqual(len(gate.scored_functions(self.repo, ["src/f.ts"])), 1)


REPO = Path(__file__).resolve().parent.parent
VITEST_CONFIG = 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"] } });\n'


@unittest.skipUnless((REPO / "node_modules/.bin/vitest").exists(), "needs bun install")
class MutantTestsScript(unittest.TestCase):
    """mutant-tests.sh with the real Vitest, on a throwaway project that borrows this checkout's node_modules."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "project"
        root = self.root
        (root / ".quality").mkdir(parents=True)
        shutil.copy(REPO / ".quality/mutant-tests.sh", root / ".quality/mutant-tests.sh")
        (root / "node_modules").symlink_to(REPO / "node_modules", target_is_directory=True)
        (root / "vitest.config.ts").write_text(VITEST_CONFIG)
        (root / "src/lib").mkdir(parents=True)
        (root / "test").mkdir()
        (root / "src/lib/a.ts").write_text("export function one(): number {\n  return 1;\n}\n")
        (root / "test/a.test.ts").write_text(
            'import { expect, test } from "vitest";\nimport { one } from "../src/lib/a.ts";\n'
            'test("one", () => { expect(one()).toBe(1); });\n'
            'test("isolated", () => {\n  expect(process.env.TETHER_REAL_SERVICE).toBeUndefined();\n'
            '  expect(process.env.TETHER_KEYCHAIN).toBe("off");\n  expect(process.env.TETHER_HOME).toContain("tether-mutant-home");\n});\n'
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def run_script(self, cwd: Path, file: str = "src/lib/a.ts") -> subprocess.CompletedProcess[str]:
        env = {**os.environ, "MUTANT_FILE": file, "TETHER_REAL_SERVICE": "1", "TETHER_KEYCHAIN": "on"}
        return subprocess.run(["sh", ".quality/mutant-tests.sh"], cwd=cwd, env=env, capture_output=True, text=True)

    def worker(self, mutated: str) -> Path:
        """mutator's layout: links to every top-level entry, src and src/lib expanded, a.ts a private mutated copy."""
        worker = Path(self._tmp.name) / "worker"
        (worker / "src/lib").mkdir(parents=True)
        for entry in self.root.iterdir():
            if entry.name != "src":
                (worker / entry.name).symlink_to(entry)
        (worker / "src/lib/a.ts").write_text(mutated)
        return worker

    def test_the_tests_pass_on_the_unmutated_file_with_the_service_and_keychain_kept_away(self) -> None:
        result = self.run_script(self.root)
        self.assertEqual(result.returncode, 0, result.stdout[-1500:] + result.stderr[-1500:])

    def test_a_mutant_the_tests_catch_fails_the_command(self) -> None:
        (self.root / "src/lib/a.ts").write_text("export function one(): number {\n  return 2;\n}\n")
        self.assertNotEqual(self.run_script(self.root).returncode, 0)

    def test_in_a_worker_of_links_the_tests_see_the_mutated_copy(self) -> None:
        # Vite resolves links to their real path, so a linked test would import the original file and pass.
        worker = self.worker("export function one(): number {\n  return 2;\n}\n")
        self.assertNotEqual(self.run_script(worker).returncode, 0)
        self.assertFalse((worker / "test").is_symlink())
        self.assertTrue((worker / "node_modules").is_symlink())

    def test_in_a_worker_of_links_the_unmutated_copy_passes(self) -> None:
        worker = self.worker((self.root / "src/lib/a.ts").read_text())
        result = self.run_script(worker)
        self.assertEqual(result.returncode, 0, result.stdout[-1500:] + result.stderr[-1500:])

    def entry_point(self, source: str) -> None:
        """src/entry.ts, which no test imports: a test reads it the way the CLI tests start bin.ts, as a process."""
        (self.root / "src/entry.ts").write_text(source)
        (self.root / "test/entry.test.ts").write_text(
            'import { readFileSync } from "node:fs";\nimport { expect, test } from "vitest";\n'
            'test("entry", () => { expect(readFileSync("src/entry.ts", "utf8")).toContain("exit(0)"); });\n'
        )

    def test_a_file_no_test_imports_passes_unmutated(self) -> None:
        self.entry_point("process.exit(0);\n")
        result = self.run_script(self.root, "src/entry.ts")
        self.assertEqual(result.returncode, 0, result.stdout[-1500:] + result.stderr[-1500:])

    def test_a_mutant_in_a_file_no_test_imports_is_killed_by_the_whole_suite(self) -> None:
        self.entry_point("process.exit(1);\n")
        self.assertNotEqual(self.run_script(self.root, "src/entry.ts").returncode, 0)

    def test_a_broken_harness_is_never_a_kill(self) -> None:
        (self.root / "vitest.config.ts").write_text('throw new Error("broken config");\n')
        (self.root / "src/lib/a.ts").write_text("export function one(): number {\n  return 2;\n}\n")
        self.assertEqual(self.run_script(self.root).returncode, 0)


class Baseline(unittest.TestCase):
    def test_the_committed_baseline_holds_every_number_the_standard_asks_for(self) -> None:
        baseline = json.loads((REPO / gate.BASELINE).read_text(encoding="utf-8"))
        for key in ("lines", "functions"):
            self.assertIsInstance(baseline["coverage"][key], float)
        for key in ("functionsMeasured", "functionsOverCrap10", "duplicatePairs"):
            self.assertIsInstance(baseline[key], int)
        self.assertIsInstance(baseline["mutation"]["score"], float)


class CrapFailure(unittest.TestCase):
    def test_each_reason_a_function_over_the_limit_fails_or_stays(self) -> None:
        self.assertIn("new function", gate.crap_failure(12.0, None))
        self.assertIn("under the limit", gate.crap_failure(12.0, 9.9))
        self.assertIn("higher", gate.crap_failure(12.1, 12.0))
        self.assertIsNone(gate.crap_failure(12.0, 12.0))


class CheckCrap(InRepo):
    def test_the_base_is_measured_only_for_files_with_a_touched_function_over_the_limit(self) -> None:
        head = [(("src/a.ts", "big", 0), 1, 20.0, 4, 0.0), (("src/b.ts", "ok", 0), 1, 2.0, 1, 100.0)]
        touched = {("src/a.ts", "big", 0), ("src/b.ts", "ok", 0)}
        with mock.patch.object(gate, "scored_functions", return_value=head), \
                mock.patch.object(gate, "touched_functions", return_value=touched), \
                mock.patch.object(gate, "base_scores", return_value={("src/a.ts", "big", 0): 20.0}) as base:
            ok, lines = gate.check_crap({"src/a.ts": [(1, 1)], "src/b.ts": [(1, 1)]}, self.repo, self.base)
        base.assert_called_once_with(self.base, self.repo, ["src/a.ts"])
        self.assertTrue(ok)
        self.assertIn("still over the limit, no worse than base", "\n".join(lines))

    def test_no_base_run_when_nothing_touched_is_over_the_limit(self) -> None:
        head = [(("src/b.ts", "ok", 0), 1, 2.0, 1, 100.0)]
        with mock.patch.object(gate, "scored_functions", return_value=head), \
                mock.patch.object(gate, "touched_functions", return_value={("src/b.ts", "ok", 0)}), \
                mock.patch.object(gate, "base_scores") as base:
            ok, _ = gate.check_crap({"src/b.ts": [(1, 1)]}, self.repo, self.base)
        base.assert_not_called()
        self.assertTrue(ok)


class RunCoverage(InRepo):
    def stub_bun(self, body: str) -> Path:
        bin_dir = self.repo / "bin"
        bin_dir.mkdir()
        (bin_dir / "bun").write_text("#!/bin/sh\n" + body)
        (bin_dir / "bun").chmod(0o755)
        return bin_dir

    def run_with(self, body: str):
        bin_dir = self.stub_bun(body)
        with mock.patch.dict(os.environ, {"PATH": f"{bin_dir}:{os.environ['PATH']}", "TETHER_REAL_SERVICE": "1"}):
            return gate.run_coverage(self.repo)

    def test_a_stale_report_is_deleted_and_the_run_writes_a_new_one_without_the_real_service_or_keychain(self) -> None:
        self.write("coverage/stale.txt", "old\n")
        body = 'mkdir -p coverage; echo "args=$* real=${TETHER_REAL_SERVICE:-unset} keychain=${TETHER_KEYCHAIN:-unset}" > coverage/lcov.info\n'
        self.assertGreaterEqual(self.run_with(body), 0.0)
        self.assertFalse((self.repo / "coverage/stale.txt").exists())
        text = (self.repo / "coverage/lcov.info").read_text()
        self.assertIn("run coverage --coverage.reporter=lcov --coverage.reportsDirectory=coverage", text)
        self.assertIn("real=unset keychain=off", text)

    def test_failing_tests_stop_the_gate(self) -> None:
        with self.assertRaises(SystemExit) as stop:
            self.run_with("echo boom; exit 1\n")
        self.assertIn("the tests failed under coverage", str(stop.exception.code))

    def test_a_run_that_writes_no_report_stops_the_gate(self) -> None:
        with self.assertRaises(SystemExit) as stop:
            self.run_with("exit 0\n")
        self.assertIn("wrote no coverage/lcov.info", str(stop.exception.code))


class KillTagged(unittest.TestCase):
    def test_only_a_process_with_the_tag_is_killed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            entry = Path(tmp, "4242")
            entry.mkdir()
            (entry / "environ").write_bytes(b"A=1\0QUALITY_GATE_TAG=t\0")
            with mock.patch.object(gate.os, "kill") as kill:
                self.assertTrue(gate._kill_if_tagged(entry, b"QUALITY_GATE_TAG=t"))
                self.assertFalse(gate._kill_if_tagged(entry, b"QUALITY_GATE_TAG=other"))
                self.assertFalse(gate._kill_if_tagged(Path(tmp, "gone"), b"QUALITY_GATE_TAG=t"))
            kill.assert_called_once_with(4242, gate.signal.SIGKILL)

    @unittest.skipUnless(Path("/proc").is_dir(), "needs /proc")
    def test_a_test_run_in_its_own_session_is_killed_with_the_gate_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pidfile = Path(tmp, "child.pid")
            script = Path(tmp, "spawner.sh")
            script.write_text(
                "#!/bin/sh\n"
                f'python3 -c "import os,sys,time; os.setsid(); open(sys.argv[1],\'w\').write(str(os.getpid())); time.sleep(60)" "{pidfile}" &\n'
                "sleep 60\n"
            )
            script.chmod(0o755)
            code, _, _ = gate.run_limited([str(script)], Path(tmp), dict(os.environ), 2.0)
            self.assertIsNone(code)
            time.sleep(0.5)
            self.assertFalse(Path(f"/proc/{pidfile.read_text()}").exists(), "the child in its own session survived the kill")


class FullBaseline(InRepo):
    def setUp(self) -> None:
        super().setUp()
        import full_baseline

        self.fb = full_baseline

    def test_every_in_scope_source_file_is_listed(self) -> None:
        self.write("src/client/x.ts", "export const x = 1\n")
        self.write("test/a.test.ts", "x\n")
        self.write("test/fake-app/server.ts", "export const s = 1\n")
        self.write("src/types.d.ts", "declare const d: 1\n")
        self.assertEqual(self.fb.source_files(self.repo), ["src/a.ts", "src/client/x.ts"])

    def test_the_totals_score_only_what_finished_and_list_the_rest(self) -> None:
        totals = self.fb.Totals(time.monotonic())
        with redirect_stdout(io.StringIO()):
            totals.record("a.ts", ("ok", 3, [("a.ts", 1, "x")], ""))
            totals.record("b.ts", ("unchecked", 0, [], 7))
            totals.record("c.ts", ("failed", 0, [], "boom"))
        result = totals.result(3, 20)
        self.assertEqual((result["killed"], result["survived"], result["score"]), (3, 1, 75.0))
        self.assertEqual((result["filesNotChecked"], result["filesFailed"]), (["b.ts"], ["c.ts"]))
        self.assertIsNone(self.fb.Totals(time.monotonic()).result(0, 0)["score"])

    def test_the_result_goes_to_the_log_and_the_step_summary(self) -> None:
        summary = self.repo / "summary.md"
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}), redirect_stdout(out):
            self.fb.publish({"score": 50.0})
        self.assertIn('RESULT {"score": 50.0}', out.getvalue())
        self.assertIn("## Full mutation baseline", summary.read_text())

    def test_main_mutates_each_file_with_every_slot_and_fails_on_a_file_not_checked(self) -> None:
        calls = []

        def mutate(path, ranges, root, workers, deadline):
            calls.append((path, workers))
            return ("ok", 1, [], "") if path.endswith("a.ts") else ("unchecked", 0, [], 2)

        self.write("src/b.ts", "export const b = 1\n")
        with mock.patch.object(gate, "run_coverage", return_value=1.0), \
                mock.patch.object(gate, "count_sites", return_value=2), \
                mock.patch.object(gate, "worker_limit", return_value=3), \
                mock.patch.object(gate, "mutate_file", side_effect=mutate), \
                mock.patch.dict(os.environ, {}, clear=False), redirect_stdout(io.StringIO()) as out:
            os.environ.pop("GITHUB_STEP_SUMMARY", None)
            code = self.fb.main()
        self.assertEqual(code, 1)
        self.assertEqual(sorted(calls), [("src/a.ts", 3), ("src/b.ts", 3)])
        self.assertIn('"filesNotChecked": ["src/b.ts"]', out.getvalue())


if __name__ == "__main__":
    unittest.main()
