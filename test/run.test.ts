import { describe, expect, it } from "vitest";
import { run } from "../src/client/run.ts";

describe("run", () => {
  it("passes input on stdin and returns the status and both outputs", () => {
    const script =
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(s.toUpperCase());process.stderr.write('e');process.exit(3)})";
    expect(run(process.execPath, ["-e", script], "secret")).toEqual({
      status: 3,
      stdout: "SECRET",
      stderr: "e",
    });
  });

  it("reports a program that cannot start with a null status", () => {
    expect(run("/no/such/program", []).status).toBeNull();
  });
});
