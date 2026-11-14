import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BIN = new URL("../src/cli/bin.ts", import.meta.url).pathname;

// The release ships `bun build --compile` binaries, which carry no files beside them: anything the
// CLI reads from the repository at run time must be bundled in.
describe("the compiled binary", () => {
  it("runs a command that validates protocol messages", () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-binary-"));
    const exe = join(dir, process.platform === "win32" ? "tether.exe" : "tether");
    execFileSync("bun", ["build", "--compile", BIN, "--outfile", exe], { stdio: "pipe" });
    const out = execFileSync(exe, ["apps"], {
      env: { ...process.env, TETHER_HOME: join(dir, "home") },
      encoding: "utf8",
    });
    expect(out).toContain("No apps connected");
  }, 120_000);
});
