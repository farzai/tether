import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli/main.ts";
import {
  launchdPlist,
  type ServiceSpec,
  serviceEnv,
  systemdUnit,
  thisProgram,
  windowsTaskXml,
  windowsWrapper,
} from "../src/cli/service.ts";
import type { Ran, Run } from "../src/client/run.ts";

const SPEC: ServiceSpec = {
  name: "tether",
  program: ["/usr/local/bin/tether"],
  env: { PATH: "/usr/local/bin:/usr/bin:/bin", TETHER_CLAUDE_PATH: "/opt/claude 100%/claude" },
  home: "/home/ann/.tether",
  userHome: "/home/ann",
  uid: 501,
  windowsUser: "PC\\ann",
};

describe("the systemd user unit", () => {
  it("runs tether start, restarts it on failure and starts at login", () => {
    expect(systemdUnit(SPEC)).toMatchInlineSnapshot(`
      "[Unit]
      Description=Tether: runs connected apps' tasks with Claude Code

      [Service]
      Type=simple
      ExecStart="/usr/local/bin/tether" "start"
      Environment="PATH=/usr/local/bin:/usr/bin:/bin"
      Environment="TETHER_CLAUDE_PATH=/opt/claude 100%%/claude"
      Restart=on-failure
      RestartSec=30

      [Install]
      WantedBy=default.target
      "
    `);
  });

  it("quotes a program run through Bun with quotes and backslashes in its path", () => {
    const unit = systemdUnit({ ...SPEC, program: ["/opt/bun", '/src/a "b"\\c/bin.ts'], env: {} });
    expect(unit).toContain('ExecStart="/opt/bun" "/src/a \\"b\\"\\\\c/bin.ts" "start"');
  });
});

describe("the launchd agent", () => {
  it("runs tether start at login, restarts it after a failure, and logs to the Tether home", () => {
    expect(launchdPlist({ ...SPEC, home: "/Users/ann/.tether" })).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
      <dict>
        <key>Label</key>
        <string>dev.farzai.tether</string>
        <key>ProgramArguments</key>
        <array>
          <string>/usr/local/bin/tether</string>
          <string>start</string>
        </array>
        <key>EnvironmentVariables</key>
        <dict>
          <key>PATH</key>
          <string>/usr/local/bin:/usr/bin:/bin</string>
          <key>TETHER_CLAUDE_PATH</key>
          <string>/opt/claude 100%/claude</string>
        </dict>
        <key>RunAtLoad</key>
        <true/>
        <key>KeepAlive</key>
        <dict>
          <key>SuccessfulExit</key>
          <false/>
        </dict>
        <key>ThrottleInterval</key>
        <integer>30</integer>
        <key>ProcessType</key>
        <string>Background</string>
        <key>StandardOutPath</key>
        <string>/Users/ann/.tether/service.log</string>
        <key>StandardErrorPath</key>
        <string>/Users/ann/.tether/service.log</string>
      </dict>
      </plist>
      "
    `);
  });

  it("escapes XML in paths", () => {
    expect(launchdPlist({ ...SPEC, program: ["/a&b/<t>"] })).toContain(
      "<string>/a&amp;b/&lt;t&gt;</string>",
    );
  });
});

describe("the Windows task", () => {
  it("runs a wrapper that sets the variables, at logon, with no time limit, restarting on failure", () => {
    const spec = { ...SPEC, home: "C:\\Users\\ann\\.tether", program: ["C:\\tether.exe"] };
    const xml = windowsTaskXml(spec);
    expect(xml).toContain("<UserId>PC\\ann</UserId>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<RestartOnFailure>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toMatch(/<Command>C:\\Users\\ann\\\.tether.service\.cmd<\/Command>/);
    expect(windowsWrapper(spec)).toBe(
      [
        "@echo off",
        'set "PATH=/usr/local/bin:/usr/bin:/bin"',
        'set "TETHER_CLAUDE_PATH=/opt/claude 100%%/claude"',
        `"C:\\tether.exe" "start" >> "${join("C:\\Users\\ann\\.tether", "service.log")}" 2>&1`,
        "",
      ].join("\r\n"),
    );
  });

  it("refuses a value it cannot write into the wrapper", () => {
    expect(() => windowsWrapper({ ...SPEC, env: { PATH: 'a"b' } })).toThrow(/batch file/);
  });
});

describe("the service environment", () => {
  it("carries where Tether's files and agent are, and never an Anthropic key", () => {
    const env = serviceEnv({
      PATH: "/bin",
      TETHER_HOME: "rel/home",
      TETHER_KEYCHAIN: "off",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      GH_TOKEN: "ghp_secret",
      HOME: "/home/ann",
    });
    expect(Object.keys(env).sort()).toEqual(["PATH", "TETHER_HOME", "TETHER_KEYCHAIN"]);
    expect(env.TETHER_HOME).toMatch(/^\/.*rel\/home$/);
  });
});

describe("the program a service runs", () => {
  it("is the binary itself when compiled, and Bun with the script otherwise", () => {
    expect(thisProgram("/usr/local/bin/tether", ["bun", "/$bunfs/root/tether", "service"])).toEqual(
      ["/usr/local/bin/tether"],
    );
    expect(thisProgram("C:\\tether.exe", ["bun", "B:\\~BUN\\root\\tether.exe"])).toEqual([
      "C:\\tether.exe",
    ]);
    expect(thisProgram("/opt/bun", ["/opt/bun", "/src/cli/bin.ts"])).toEqual([
      "/opt/bun",
      "/src/cli/bin.ts",
    ]);
  });
});

/** Runs `tether service <action>` as on `platform`, recording each command instead of running it. */
class ServiceRun {
  readonly home = mkdtempSync(join(tmpdir(), "tether-service-home-"));
  readonly userHome = mkdtempSync(join(tmpdir(), "tether-service-user-"));
  readonly calls: string[] = [];
  out = "";
  err = "";
  /** Answers by command prefix; a list is answered in turn, its last answer repeating. */
  answers: Record<string, Ran | Ran[]> = {};

  constructor(readonly platform: NodeJS.Platform) {}

  connected(): this {
    const app = {
      origin: "https://paper.example",
      name: "Paper",
      device: { id: "dev_1", name: "Mac" },
      account: "Ann",
      credential: "tdc_secret_credential",
      pairedAt: "2026-11-14T00:00:00.000Z",
    };
    writeFileSync(join(this.home, "credentials.json"), JSON.stringify({ apps: [app] }));
    return this;
  }

  readonly run: Run = (command, args) => {
    const line = [command, ...args].join(" ");
    this.calls.push(line);
    const answer = Object.entries(this.answers).find(([prefix]) => line.startsWith(prefix))?.[1];
    if (!Array.isArray(answer)) return answer ?? { status: 0, stdout: "", stderr: "" };
    return (answer.length > 1 ? answer.shift() : answer[0]) as Ran;
  };

  exec(action: string, env: Record<string, string> = {}): Promise<number> {
    return main(["service", action], {
      env: { TETHER_HOME: this.home, TETHER_KEYCHAIN: "off", PATH: "/usr/bin:/bin", ...env },
      stdout: { write: (text: string) => (this.out += text) },
      stderr: { write: (text: string) => (this.err += text) },
      program: ["/usr/local/bin/tether"],
      platform: this.platform,
      run: this.run,
      userHome: this.userHome,
    });
  }
}

describe("tether service on Linux", () => {
  it("installs the unit, enables and starts it, and removes it again", async () => {
    const s = new ServiceRun("linux").connected();
    expect(await s.exec("install")).toBe(0);
    const [unit] = s.calls[1]?.match(/tether-[0-9a-f]{8}\.service/) ?? [];
    expect(s.calls).toEqual([
      "systemctl --user daemon-reload",
      `systemctl --user enable ${unit}`,
      `systemctl --user restart ${unit}`,
    ]);
    const file = join(s.userHome, ".config", "systemd", "user", unit as string);
    expect(readFileSync(file, "utf8")).toContain(`Environment="TETHER_HOME=${s.home}"`);
    expect(readFileSync(file, "utf8")).not.toContain("tdc_secret_credential");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(s.out).toContain(`journalctl --user -u ${(unit as string).replace(".service", "")}`);

    s.answers["systemctl --user is-active"] = { status: 0, stdout: "active\n", stderr: "" };
    expect(await s.exec("status")).toBe(0);
    expect(s.out).toContain("Background service (systemd): installed, active");

    s.calls.length = 0;
    expect(await s.exec("uninstall")).toBe(0);
    expect(s.calls).toEqual([
      `systemctl --user disable --now ${unit}`,
      "systemctl --user daemon-reload",
    ]);
    expect(existsSync(file)).toBe(false);
  });

  it("refuses to install before any app is connected", async () => {
    const s = new ServiceRun("linux");
    expect(await s.exec("install")).toBe(1);
    expect(s.err).toMatch(/No apps connected/);
    expect(s.calls).toEqual([]);
  });

  it("says why when systemd refuses", async () => {
    const s = new ServiceRun("linux").connected();
    s.answers["systemctl --user daemon-reload"] = {
      status: 1,
      stdout: "",
      stderr: "Failed to connect to bus: No medium found",
    };
    expect(await s.exec("install")).toBe(1);
    expect(s.err).toMatch(/daemon-reload failed: Failed to connect to bus/);
  });

  it("says what systemd printed, or its exit status when it printed nothing", async () => {
    const s = new ServiceRun("linux").connected();
    s.answers["systemctl --user enable"] = {
      status: 1,
      stdout: "Unit file is masked.",
      stderr: "",
    };
    expect(await s.exec("install")).toBe(1);
    expect(s.err).toMatch(/enable failed: Unit file is masked\./);
    s.answers["systemctl --user enable"] = { status: 5, stdout: "", stderr: "" };
    expect(await s.exec("install")).toBe(1);
    expect(s.err).toMatch(/enable failed: exit 5/);
  });

  it("warns that an Anthropic key in the shell does not reach the service", async () => {
    const s = new ServiceRun("linux").connected();
    expect(await s.exec("install", { ANTHROPIC_API_KEY: "sk-ant-secret" })).toBe(0);
    expect(s.err).toMatch(/does not carry ANTHROPIC_API_KEY/);
    expect(s.err + s.out).not.toContain("sk-ant-secret");
  });
});

describe("tether service on macOS", () => {
  it("bootstraps the agent in the user's gui domain and boots it out again", async () => {
    const s = new ServiceRun("darwin").connected();
    expect(await s.exec("install")).toBe(0);
    const uid = s.calls[0]?.match(/gui\/(\d+)/)?.[1];
    const label = s.calls[0]?.match(/dev\.farzai\.tether-[0-9a-f]{8}/)?.[0];
    const plist = join(s.userHome, "Library", "LaunchAgents", `${label}.plist`);
    expect(s.calls).toEqual([
      `launchctl bootout gui/${uid}/${label}`,
      `launchctl bootstrap gui/${uid} ${plist}`,
    ]);
    expect(statSync(join(s.home, "service.log")).mode & 0o777).toBe(0o600);

    s.answers["launchctl print"] = {
      status: 0,
      stdout: "\tstate = running\n\tpid = 4242\n",
      stderr: "",
    };
    await s.exec("status");
    expect(s.out).toContain("Background service (launchd): installed, running (pid 4242)");

    expect(await s.exec("uninstall")).toBe(0);
    expect(existsSync(plist)).toBe(false);
    s.out = "";
    await s.exec("status");
    expect(s.out).toContain("not installed");
  });
});

describe("tether service on macOS, over an agent already loaded", () => {
  const busy: Ran = { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
  const ok: Ran = { status: 0, stdout: "", stderr: "" };

  it("makes an existing log readable only by the user", async () => {
    const s = new ServiceRun("darwin").connected();
    writeFileSync(join(s.home, "service.log"), "earlier output\n", { mode: 0o644 });
    chmodSync(join(s.home, "service.log"), 0o644);
    expect(await s.exec("install")).toBe(0);
    expect(statSync(join(s.home, "service.log")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(s.home, "service.log"), "utf8")).toBe("earlier output\n");
  });

  it("waits and bootstraps again while the old agent is still being booted out", async () => {
    const s = new ServiceRun("darwin").connected();
    s.answers["launchctl bootout"] = {
      status: 36,
      stdout: "",
      stderr: "Operation now in progress",
    };
    s.answers["launchctl bootstrap"] = [busy, busy, ok];
    expect(await s.exec("install")).toBe(0);
    expect(s.calls.map((call) => call.split(" ").slice(0, 2).join(" "))).toEqual([
      "launchctl bootout",
      "launchctl bootstrap",
      "sleep 1",
      "launchctl bootstrap",
      "sleep 1",
      "launchctl bootstrap",
    ]);
  });

  it("gives up after ten tries and says what launchctl printed", async () => {
    const s = new ServiceRun("darwin").connected();
    s.answers["launchctl bootstrap"] = busy;
    expect(await s.exec("install")).toBe(1);
    expect(s.calls.filter((call) => call.startsWith("launchctl bootstrap"))).toHaveLength(10);
    expect(s.err).toMatch(/launchctl bootstrap failed: Bootstrap failed: 5: Input\/output error/);
  });
});

describe("the release workflow", () => {
  it("does not leave the job's token in the checkout", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    const checkouts = workflow
      .split("- uses: ")
      .filter((step) => step.startsWith("actions/checkout"));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) {
      expect(step.split("\n      - ")[0]).toMatch(/with:\s*\n\s*persist-credentials: false/);
    }
  });
});

describe("tether service on Windows", () => {
  it("creates the task from XML, runs it, and deletes it again", async () => {
    const s = new ServiceRun("win32").connected();
    expect(await s.exec("install")).toBe(0);
    const task = s.calls[0]?.match(/Tether-[0-9a-f]{8}/)?.[0];
    expect(s.calls).toEqual([
      `schtasks /Create /TN ${task} /XML ${join(s.home, "service.xml")} /F`,
      `schtasks /Run /TN ${task}`,
    ]);
    expect(existsSync(join(s.home, "service.cmd"))).toBe(true);
    s.calls.length = 0;
    expect(await s.exec("uninstall")).toBe(0);
    expect(s.calls).toEqual([`schtasks /End /TN ${task}`, `schtasks /Delete /TN ${task} /F`]);
    expect(existsSync(join(s.home, "service.cmd"))).toBe(false);
  });
});

describe("tether service", () => {
  it("refuses an unknown action", async () => {
    const s = new ServiceRun("linux");
    expect(await s.exec("restart")).toBe(2);
  });
});
