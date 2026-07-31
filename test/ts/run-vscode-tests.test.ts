import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import type { PythonResolveDependencies, SpawnRunOptions } from "../../tools/run_vscode_tests.js";
import {
  buildLaunchCommand,
  installFixtureExtensions,
  isAbsoluteExecutablePath,
  main,
  parseGrammarVersion,
  resolveIntegrationPython,
  spawnAndRequireZero,
} from "../../tools/run_vscode_tests.js";
import { INTEGRATION_TEST_TIMEOUT_MS, runIntegrationTest } from "../integration/run.js";
import { assertNoSemanticSqlOverlap, decodeSemanticTokens } from "../support/semantic-tokens.js";

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

  it("rejects relative, multiline, and missing Python paths", async () => {
    const access = vi.fn(() => Promise.resolve(undefined));
    await expect(resolveIntegrationPython("python", { access })).rejects.toThrow("absolute line");
    await expect(resolveIntegrationPython("/tmp/python\nother", { access })).rejects.toThrow(
      "absolute line",
    );
    await expect(
      resolveIntegrationPython("/tmp/python", {
        access: vi.fn(() => {
          throw new Error("missing");
        }),
      }),
    ).rejects.toThrow("not accessible");
    expect(access).not.toHaveBeenCalled();
  });

  it("accepts POSIX and Windows-shaped absolute paths after access validation", async () => {
    const access = vi.fn(() => Promise.resolve(undefined));
    await expect(resolveIntegrationPython("/opt/python", { access })).resolves.toBe("/opt/python");
    await expect(resolveIntegrationPython("C:\\Python\\python.exe", { access })).resolves.toBe(
      "C:\\Python\\python.exe",
    );
    expect(isAbsoluteExecutablePath("C:\\Python\\python.exe")).toBe(true);
  });

  it("uses a bounded uv fallback without a shell", async () => {
    const access = vi.fn(() => Promise.resolve(undefined));
    const execute = vi.fn((_file: string, _args: readonly string[], options: { shell: false }) => {
      assert.equal(options.shell, false);
      return Promise.resolve({ stdout: "/opt/uv/python3.12\n", stderr: "" });
    }) as unknown as NonNullable<PythonResolveDependencies["execFile"]>;
    await expect(resolveIntegrationPython(undefined, { access, execFile: execute })).resolves.toBe(
      "/opt/uv/python3.12",
    );
    expect(execute).toHaveBeenCalledTimes(1);
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
        resolvePython: () => Promise.resolve("/tmp/python"),
      }),
    ).rejects.toThrow("invalid VSCODE_TEST_VERSION");
    vi.stubEnv("VSCODE_TEST_VERSION", "1.95.0");
    await expect(
      main(["node", "runner", "trusted"], {
        buildExtension: build,
        buildIntegrationRunner: bundle,
        launchScenario: launch,
        resolvePython: () => Promise.reject(new Error("python")),
      }),
    ).rejects.toThrow("python");
    expect(build).not.toHaveBeenCalled();
    expect(bundle).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("builds once and launches one fixed scenario after validation", async () => {
    vi.stubEnv("VSCODE_TEST_VERSION", "stable");
    const build = vi.fn(() => Promise.resolve(undefined));
    const bundle = vi.fn(() => Promise.resolve(undefined));
    const resolvePython = vi.fn(() => Promise.resolve("/opt/python"));
    const launch = vi.fn(() => Promise.resolve(undefined));
    await main(["node", "runner", "trusted"], {
      buildExtension: build,
      buildIntegrationRunner: bundle,
      resolvePython,
      launchScenario: launch,
    });
    expect(resolvePython).toHaveBeenCalledWith(undefined);
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

describe("semantic token decoding", () => {
  it("decodes deltas and permits boundary contact but rejects strict overlap", () => {
    const document = {
      uri: vscode.Uri.file("/tmp/semantic.py"),
      languageId: "python",
      getText: () => 'query = "SELECT"\n',
      lineCount: 2,
      lineAt: (line: number) => ({ lineNumber: line, text: line === 0 ? 'query = "SELECT"' : "" }),
    } as unknown as vscode.TextDocument;
    const tokens = {
      data: new Uint32Array([0, 0, 5, 0, 0, 0, 9, 6, 0, 0]),
    } as vscode.SemanticTokens;
    const ranges = decodeSemanticTokens(document, tokens);
    expect(ranges).toHaveLength(2);
    const safe = ranges[0];
    const sql = ranges[1];
    if (safe === undefined || sql === undefined) throw new Error("missing decoded ranges");
    assertNoSemanticSqlOverlap([safe], [sql]);
    expect(() => {
      assertNoSemanticSqlOverlap(ranges, [sql]);
    }).toThrow("semantic token overrides inline SQL");
  });

  it("rejects empty, truncated, overflowing, and out-of-document streams", () => {
    const document = {
      uri: vscode.Uri.file("/tmp/semantic.py"),
      languageId: "python",
      getText: () => "query\n",
      lineCount: 2,
      lineAt: (line: number) => ({ lineNumber: line, text: line === 0 ? "query" : "" }),
    } as unknown as vscode.TextDocument;
    expect(() =>
      decodeSemanticTokens(document, { data: new Uint32Array() } as vscode.SemanticTokens),
    ).toThrow();
    expect(() =>
      decodeSemanticTokens(document, { data: new Uint32Array([0, 0, 1]) } as vscode.SemanticTokens),
    ).toThrow();
    expect(() =>
      decodeSemanticTokens(document, {
        data: new Uint32Array([0xffffffff, 0, 1, 0, 0]),
      } as vscode.SemanticTokens),
    ).toThrow();
    expect(() =>
      decodeSemanticTokens(document, {
        data: new Uint32Array([0, 99, 1, 0, 0]),
      } as vscode.SemanticTokens),
    ).toThrow();
  });
});
