import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SpawnRunOptions } from "../../tools/run_vscode_tests.js";
import {
  buildLaunchCommand,
  installFixtureExtensions,
  main,
  parseGrammarVersion,
  spawnAndRequireZero,
} from "../../tools/run_vscode_tests.js";
import { INTEGRATION_TEST_TIMEOUT_MS, runIntegrationTest } from "../integration/run.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("integration runner argument policy", () => {
  it("accepts only the fixed VS Code versions", () => {
    expect(parseGrammarVersion(undefined)).toBe("1.95.0");
    expect(parseGrammarVersion("stable")).toBe("stable");
    expect(() => parseGrammarVersion("insiders")).toThrow("invalid VSCODE_TEST_VERSION");
  });

  it("builds shell-free trusted and untrusted launch arguments", () => {
    const input = {
      executable: "/tmp/Code",
      repositoryRoot: "/repo",
      testsPath: "/repo/dist-test/integration/run.js",
      workspacePath: "/tmp/workspace",
      userDataDir: "/tmp/user-data",
      extensionsDir: "/tmp/extensions",
      scenario: "trusted" as const,
    };
    const trusted = buildLaunchCommand(input);
    assert.equal(trusted.args.includes("--disable-workspace-trust"), true);
    const untrusted = buildLaunchCommand({ ...input, scenario: "untrusted" });
    assert.equal(untrusted.args.includes("--disable-workspace-trust"), false);
    assert.equal(trusted.command === "xvfb-run" || trusted.command === input.executable, true);
  });

  it("does not install current official extensions into the pinned old host", async () => {
    await expect(
      installFixtureExtensions("compatibility", "/tmp/extensions", "/tmp/code", "/repo", "1.95.0"),
    ).rejects.toThrow("stable only");
  });
});

describe("integration runner bootstrap", () => {
  it("fails before building or launching on invalid scenario/version/python", async () => {
    const build = vi.fn(() => Promise.resolve(undefined));
    const bundle = vi.fn(() => Promise.resolve(undefined));
    const launch = vi.fn(() => Promise.resolve(undefined));
    await expect(
      main(["node", "runner", "bad"], {
        buildExtension: build,
        buildIntegrationRunner: bundle,
        launchScenario: launch,
      }),
    ).rejects.toThrow("invalid integration scenario");
    vi.stubEnv("VSCODE_TEST_VERSION", "bad");
    await expect(
      main(["node", "runner", "trusted"], {
        buildExtension: build,
        buildIntegrationRunner: bundle,
        launchScenario: launch,
      }),
    ).rejects.toThrow("invalid VSCODE_TEST_VERSION");
    vi.stubEnv("VSCODE_TEST_VERSION", "1.95.0");
    expect(build).not.toHaveBeenCalled();
    expect(bundle).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("builds once and launches one fixed scenario after validation", async () => {
    vi.stubEnv("VSCODE_TEST_VERSION", "stable");
    const build = vi.fn(() => Promise.resolve(undefined));
    const bundle = vi.fn(() => Promise.resolve(undefined));
    const launch = vi.fn(() => Promise.resolve(undefined));
    await main(["node", "runner", "trusted"], {
      buildExtension: build,
      buildIntegrationRunner: bundle,
      launchScenario: launch,
    });
    expect(build).toHaveBeenCalledTimes(1);
    expect(bundle).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ scenario: "trusted" }));
  });
});

describe("integration runner process lifecycle", () => {
  class FakeChild extends EventEmitter {
    readonly pid = 42;
  }

  const spawnOptions = (
    child: FakeChild,
    extra: Partial<SpawnRunOptions> = {},
  ): SpawnRunOptions => ({
    shell: false as const,
    stdio: "ignore" as const,
    timeoutMs: 25,
    spawnProcess: vi.fn(() => child) as unknown as NonNullable<SpawnRunOptions["spawnProcess"]>,
    ...extra,
  });

  it("kills the process tree on timeout and settles exactly once", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    let releaseKill!: () => void;
    const kill = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseKill = resolve;
        }),
    );
    const pending = spawnAndRequireZero("code", [], {
      ...spawnOptions(child),
      terminateTree: kill,
    });
    await vi.advanceTimersByTimeAsync(25);
    expect(kill).toHaveBeenCalledWith(42);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("exit", 0, null);
    releaseKill();
    await expect(pending).rejects.toThrow("timed out");
    expect(child.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects synchronous spawn throws without scheduling a timer", async () => {
    vi.useFakeTimers();
    const spawnProcess = vi.fn(() => {
      throw new Error("spawn");
    });
    await expect(
      spawnAndRequireZero("code", [], {
        ...spawnOptions(new FakeChild()),
        spawnProcess,
      }),
    ).rejects.toThrow("spawn failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles error/exit races with one settlement and cleaned timer", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const pending = spawnAndRequireZero("code", [], spawnOptions(child));
    child.emit("exit", 0, null);
    child.emit("error", new Error("late error"));
    await expect(pending).resolves.toBeUndefined();
    expect(child.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a child error and ignores a later exit", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const pending = spawnAndRequireZero("code", [], spawnOptions(child));
    child.emit("error", new Error("child error"));
    child.emit("exit", 1, null);
    await expect(pending).rejects.toThrow("process failed");
    expect(child.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("integration suite timeout", () => {
  it("uses the required 30-second bound and rejects a hanging suite", async () => {
    expect(INTEGRATION_TEST_TIMEOUT_MS).toBe(30_000);
    vi.useFakeTimers();
    const pending = runIntegrationTest(() => new Promise<void>(() => {}), 30);
    const rejection = expect(pending).rejects.toThrow("integration assertion timed out");
    await vi.advanceTimersByTimeAsync(30);
    await rejection;
  });
});
