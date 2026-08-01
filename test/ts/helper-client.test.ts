import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import type {
  FormatOptions,
  FormatResponse,
  FormatTarget,
  LocateResponse,
} from "../../src/protocol.js";
import type { SupportedDocument } from "../../src/vscode/document-target.js";
import {
  BoundedBytes,
  DefaultHelperClient,
  type DocumentSnapshot,
  type HelperClientDependencies,
  MAX_STDERR_BYTES,
  MAX_STDIN_BYTES,
  MAX_STDOUT_BYTES,
} from "../../src/vscode/helper-client.js";
import type { PythonResolver } from "../../src/vscode/python-resolver.js";
import { __mock } from "../support/vscode-mock.js";

type FakeStream = EventEmitter & {
  readonly end: ReturnType<typeof vi.fn<(data: Buffer) => void>>;
};

type FakeChild = EventEmitter & {
  readonly stdin: FakeStream;
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  readonly kill: ReturnType<typeof vi.fn>;
};

function stream(): FakeStream {
  return Object.assign(new EventEmitter(), { end: vi.fn<(data: Buffer) => void>() });
}

function childDouble(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdin: stream(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  });
}

function source(): vscode.CancellationTokenSource {
  return new vscode.CancellationTokenSource();
}

function resource(): SupportedDocument {
  const document = __mock.document({
    uri: "file:///workspace/notebook.ipynb#resource-sentinel",
    languageId: "python",
  });
  return {
    document,
    documentUri: document.uri,
    resourceUri: vscode.Uri.parse("file:///workspace/notebook.ipynb#resource-sentinel"),
  };
}

function snapshot(text = "SELECT 1 -- source-sentinel"): DocumentSnapshot {
  return {
    uri: vscode.Uri.parse("file:///private/source-sentinel.py"),
    version: 19,
    text,
  };
}

const target: FormatTarget = { mode: "all" };
const options: FormatOptions = {
  keywordCase: "upper",
  indentWidth: 2,
  wrapAfter: 88,
  useSpaceAroundOperators: true,
  expandSelectList: false,
  trimBlankBoundaries: false,
  dialect: "postgresql",
};

function success(operation: "locate" | "format"): LocateResponse | FormatResponse {
  if (operation === "locate") {
    return {
      protocolVersion: 1,
      operation,
      ok: true,
      candidates: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }],
    };
  }
  return {
    protocolVersion: 1,
    operation,
    ok: true,
    edits: [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        expectedText: "SELECT 1",
        newText: "SELECT 1",
      },
    ],
    skips: [],
    summary: { discovered: 1, selected: 1, changed: 1, unchanged: 0, skipped: 0 },
  };
}

function errorResponse(operation: "locate" | "format", code: string): unknown {
  return { protocolVersion: 1, operation, ok: false, error: { code } };
}

function setup(
  overrides: {
    readonly process?: FakeChild;
    readonly trusted?: boolean;
    readonly resolve?: PythonResolver["resolve"];
    readonly processWillSpawn?: (kind: "helper") => void;
    readonly extensionUri?: vscode.Uri;
    readonly spawn?: HelperClientDependencies["spawn"];
  } = {},
): {
  readonly client: DefaultHelperClient;
  readonly process: FakeChild;
  readonly resolver: PythonResolver;
  readonly resolveSpy: ReturnType<typeof vi.fn>;
  readonly spawn: HelperClientDependencies["spawn"];
} {
  const process = overrides.process ?? childDouble();
  const resolve =
    overrides.resolve ??
    vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        python: {
          executable: "/private/python-sentinel/bin/python",
          version: { major: 3, minor: 12, patch: 4 },
          source: "configuration" as const,
        },
      }),
    );
  const resolver = {
    resolve,
    invalidate: vi.fn(),
    dispose: vi.fn(),
  } as unknown as PythonResolver;
  const spawn =
    overrides.spawn ?? (vi.fn(() => process) as unknown as HelperClientDependencies["spawn"]);
  const client = new DefaultHelperClient({
    extensionUri: overrides.extensionUri ?? vscode.Uri.file("/private/extension-sentinel"),
    resolver,
    isWorkspaceTrusted: () => overrides.trusted ?? true,
    ...(overrides.processWillSpawn === undefined
      ? {}
      : { processWillSpawn: overrides.processWillSpawn }),
    spawn,
  });
  return {
    client,
    process,
    resolver,
    resolveSpy: resolve as unknown as ReturnType<typeof vi.fn>,
    spawn,
  };
}

function complete(
  process: FakeChild,
  operation: "locate" | "format",
  value = success(operation),
): void {
  process.stdout.emit("data", Buffer.from(JSON.stringify(value), "utf8"));
  process.emit("close", 0, null);
}

beforeEach(() => {
  __mock.reset();
  vi.useRealTimers();
});

describe("bounded helper process", () => {
  it("does not signal when fixed helper paths cannot be constructed", async () => {
    const processWillSpawn = vi.fn();
    const extensionUri = {
      get fsPath(): string {
        throw new Error("path-sentinel");
      },
    } as unknown as vscode.Uri;
    const result = setup({ extensionUri, processWillSpawn });
    await expect(
      result.client.locate(snapshot(), target, options, resource(), source().token),
    ).resolves.toMatchObject({ ok: false, error: { code: "PROCESS_FAILED" } });
    expect(processWillSpawn).not.toHaveBeenCalled();
    expect(result.spawn).not.toHaveBeenCalled();
  });

  it("signals exactly once immediately before a helper spawn", async () => {
    const processWillSpawn = vi.fn();
    const result = setup({ processWillSpawn });
    const pending = result.client.locate(snapshot(), target, options, resource(), source().token);
    await vi.waitFor(() => {
      expect(processWillSpawn).toHaveBeenCalledWith("helper");
    });
    expect(processWillSpawn).toHaveBeenCalledTimes(1);
    complete(result.process, "locate");
    await expect(pending).resolves.toEqual(success("locate"));
  });

  it("collects bytes up to the limit and becomes inert after sealing", () => {
    const bytes = new BoundedBytes(4);
    expect(bytes.push(Buffer.from("1234"))).toBe(true);
    expect(bytes.length).toBe(4);
    expect(bytes.concat().toString()).toBe("1234");
    bytes.seal();
    expect(bytes.push(Buffer.from("x"))).toBe(false);
    expect(bytes.length).toBe(4);
  });

  it("rejects a crossing chunk without retaining it, including many chunks", () => {
    const bytes = new BoundedBytes(5);
    expect(bytes.push(Buffer.from("12"))).toBe(true);
    expect(bytes.push(Buffer.from("34"))).toBe(true);
    expect(bytes.push(Buffer.from("567"))).toBe(false);
    expect(bytes.concat().toString()).toBe("1234");
    expect(bytes.push(Buffer.from("5"))).toBe(true);
    expect(bytes.concat().toString()).toBe("12345");
  });

  it("uses byte length rather than character count", () => {
    const bytes = new BoundedBytes(3);
    expect(bytes.push(Buffer.from("あ", "utf8"))).toBe(true);
    expect(bytes.length).toBe(3);
    expect(bytes.push(Buffer.from("x"))).toBe(false);
  });
});

describe("DefaultHelperClient", () => {
  it("spawns with isolated arguments and sends one source-only request", async () => {
    const { client, process, resolveSpy, spawn } = setup();
    const spawnSpy = spawn as unknown as ReturnType<typeof vi.fn>;
    const pending = client.format(snapshot(), target, options, resource(), source().token);
    await vi.waitFor(() => {
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    });
    expect(spawnSpy).toHaveBeenCalledWith(
      "/private/python-sentinel/bin/python",
      ["-I", "-S", "-B", "-X", "utf8", "/private/extension-sentinel/python/bootstrap.py"],
      expect.objectContaining({
        cwd: "/private/extension-sentinel",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
    );
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(process.stdin.end).toHaveBeenCalledTimes(1);
    const requestArgument: unknown = (process.stdin.end.mock.calls as readonly unknown[][])[0]?.[0];
    if (!(requestArgument instanceof Buffer)) throw new Error("missing request bytes");
    const request = JSON.parse(requestArgument.toString("utf8")) as Record<string, unknown>;
    expect(request).toEqual({
      protocolVersion: 1,
      operation: "format",
      source: snapshot().text,
      target,
      options,
    });
    expect(JSON.stringify(request)).not.toContain("resource-sentinel");
    expect(JSON.stringify(request)).not.toContain("extension-sentinel");
    complete(process, "format");
    await expect(pending).resolves.toEqual(success("format"));
  });

  it("shares one invocation path for locate and validates its response", async () => {
    const { client, process, resolveSpy } = setup();
    const pending = client.locate(snapshot(), target, options, resource(), source().token);
    await vi.waitFor(() => {
      expect(resolveSpy).toHaveBeenCalledTimes(1);
    });
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    complete(process, "locate");
    await expect(pending).resolves.toEqual(success("locate"));
  });

  it("does not spawn after cancellation or trust loss", async () => {
    const cancelled = source();
    cancelled.cancel();
    const first = setup();
    await expect(
      first.client.format(snapshot(), target, options, resource(), cancelled.token),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "PROCESS_CANCELLED" },
    });
    expect(first.spawn).not.toHaveBeenCalled();

    const untrusted = setup({ trusted: false });
    await expect(
      untrusted.client.format(snapshot(), target, options, resource(), source().token),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_UNTRUSTED" },
    });
    expect(untrusted.spawn).not.toHaveBeenCalled();
  });

  it.each([
    "PYTHON_NOT_FOUND",
    "PYTHON_VERSION_UNSUPPORTED",
    "WORKSPACE_UNTRUSTED",
    "INVALID_CONFIGURATION",
    "PROCESS_TIMEOUT",
    "PROCESS_CANCELLED",
    "PROCESS_FAILED",
  ] as const)("maps resolver reason %s without source text", async (reason) => {
    const resolve = vi.fn(() => Promise.resolve({ ok: false as const, reason }));
    const result = setup({ resolve });
    const pending = result.client.format(
      snapshot("RESOLVER-SOURCE-SECRET"),
      target,
      options,
      resource(),
      source().token,
    );
    await expect(pending).resolves.toEqual({
      protocolVersion: 1,
      operation: "format",
      ok: false,
      error: { code: reason },
    });
    expect(result.spawn).not.toHaveBeenCalled();
    expect(JSON.stringify(await pending)).not.toContain("RESOLVER-SOURCE-SECRET");
  });

  it("times out at exactly five seconds and kills once", async () => {
    vi.useFakeTimers();
    const { client, process } = setup();
    const pending = client.format(snapshot(), target, options, resource(), source().token);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(process.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "PROCESS_TIMEOUT" } });
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(() => {
      process.stdout.emit("error", new Error("late timeout stdout private"));
      process.stderr.emit("error", new Error("late timeout stderr private"));
      process.stdin.emit("error", new Error("late timeout stdin private"));
      process.emit("error", new Error("late timeout process private"));
    }).not.toThrow();
    expect(process.kill).toHaveBeenCalledTimes(1);
  });

  it("cancels a running process and kills once", async () => {
    const cancellation = source();
    const { client, process, spawn } = setup();
    const spawnSpy = spawn as unknown as ReturnType<typeof vi.fn>;
    const pending = client.format(snapshot(), target, options, resource(), cancellation.token);
    await vi.waitFor(() => {
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    });
    cancellation.cancel();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "PROCESS_CANCELLED" },
    });
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(() => {
      process.stdout.emit("error", new Error("late cancel stdout private"));
      process.stderr.emit("error", new Error("late cancel stderr private"));
      process.stdin.emit("error", new Error("late cancel stdin private"));
      process.emit("error", new Error("late cancel process private"));
    }).not.toThrow();
    expect(process.kill).toHaveBeenCalledTimes(1);
  });

  it.each(["stdout", "stderr"] as const)(
    "maps %s stream errors and absorbs late errors",
    async (streamName) => {
      const process = childDouble();
      const result = setup({ process });
      const spawnSpy = result.spawn as unknown as ReturnType<typeof vi.fn>;
      const pending = result.client.format(
        snapshot("STREAM-SOURCE-SECRET"),
        target,
        options,
        resource(),
        source().token,
      );
      await vi.waitFor(() => {
        expect(spawnSpy).toHaveBeenCalledTimes(1);
      });

      expect(() => process[streamName].emit("error", new Error("stream private"))).not.toThrow();
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: "PROCESS_FAILED" },
      });
      expect(process.kill).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(await pending)).not.toContain("STREAM-SOURCE-SECRET");

      expect(() => {
        process[streamName].emit("error", new Error("late stream private"));
        process.emit("error", new Error("late process private"));
        process.stdin.emit("error", new Error("late stdin private"));
      }).not.toThrow();
      expect(process.kill).toHaveBeenCalledTimes(1);
    },
  );

  it("terminates a live child on process error exactly once before synchronous close", async () => {
    const process = childDouble();
    process.kill.mockImplementation(() => {
      process.emit("close", null, "SIGTERM");
      process.emit("error", new Error("late process private"));
      return true;
    });
    const result = setup({ process });
    const spawnSpy = result.spawn as unknown as ReturnType<typeof vi.fn>;
    const pending = result.client.locate(
      snapshot("PROCESS-SOURCE-SECRET"),
      target,
      options,
      resource(),
      source().token,
    );
    await vi.waitFor(() => {
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    });

    expect(() => process.emit("error", new Error("live process private"))).not.toThrow();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "PROCESS_FAILED" } });
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await pending)).not.toContain("PROCESS-SOURCE-SECRET");
  });

  it("absorbs all late stream and process errors after a normal finish", async () => {
    const process = childDouble();
    const result = setup({ process });
    const spawnSpy = result.spawn as unknown as ReturnType<typeof vi.fn>;
    const pending = result.client.format(
      snapshot("FINISH-SOURCE-SECRET"),
      target,
      options,
      resource(),
      source().token,
    );
    await vi.waitFor(() => {
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    });
    complete(process, "format");
    await expect(pending).resolves.toEqual(success("format"));

    expect(() => {
      process.stdout.emit("error", new Error("late stdout private"));
      process.stderr.emit("error", new Error("late stderr private"));
      process.stdin.emit("error", new Error("late stdin private"));
      process.emit("error", new Error("late process private"));
    }).not.toThrow();
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("maps spawn, exit, signal, and stdin failures to source-free errors", async () => {
    const cases = [
      {
        name: "sync spawn",
        spawn: vi.fn(() => {
          throw new Error("private source");
        }),
      },
      {
        name: "async error",
        event: (process: FakeChild) => process.emit("error", new Error("private source")),
      },
      { name: "nonzero exit", event: (process: FakeChild) => process.emit("close", 2, null) },
      {
        name: "signal exit",
        event: (process: FakeChild) => process.emit("close", null, "SIGTERM"),
      },
    ] as const;
    for (const testCase of cases) {
      const process = childDouble();
      const setupResult =
        "spawn" in testCase ? setup({ process, spawn: testCase.spawn }) : setup({ process });
      const spawnSpy = setupResult.spawn as unknown as ReturnType<typeof vi.fn>;
      const pending = setupResult.client.locate(
        snapshot(),
        target,
        options,
        resource(),
        source().token,
      );
      await vi.waitFor(() => {
        expect(spawnSpy).toHaveBeenCalledTimes(1);
      });
      if ("event" in testCase) testCase.event(process);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: "PROCESS_FAILED" },
      });
      expect(JSON.stringify(await pending)).not.toContain("source-sentinel");
    }

    const syncEnd = childDouble();
    syncEnd.stdin.end.mockImplementation(() => {
      throw new Error("stdin private");
    });
    const syncResult = setup({ process: syncEnd });
    await expect(
      syncResult.client.format(snapshot(), target, options, resource(), source().token),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "PROCESS_FAILED" },
    });
    expect(syncEnd.kill).toHaveBeenCalledTimes(1);

    const asyncEnd = childDouble();
    const asyncResult = setup({ process: asyncEnd });
    const asyncSpawnSpy = asyncResult.spawn as unknown as ReturnType<typeof vi.fn>;
    const pending = asyncResult.client.format(
      snapshot(),
      target,
      options,
      resource(),
      source().token,
    );
    await vi.waitFor(() => {
      expect(asyncSpawnSpy).toHaveBeenCalledTimes(1);
    });
    asyncEnd.stdin.emit("error", new Error("stdin private"));
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "PROCESS_FAILED" } });
    expect(asyncEnd.kill).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed, extra, mismatched, and invalid responses", async () => {
    const outputs: readonly [string, Buffer | string][] = [
      ["extra stdout", `${JSON.stringify(success("format"))} trailing`],
      ["malformed json", "{"],
      ["malformed utf8", Buffer.from([0xff, 0xfe])],
      [
        "protocol mismatch",
        JSON.stringify({
          protocolVersion: 2,
          operation: "format",
          ok: false,
          error: { code: "PROCESS_FAILED" },
        }),
      ],
      ["operation mismatch", JSON.stringify(errorResponse("locate", "PROCESS_FAILED"))],
      [
        "edit shape mismatch",
        JSON.stringify({
          ...success("format"),
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              expectedText: "",
              newText: "x",
            },
          ],
        }),
      ],
    ];
    for (const [name, output] of outputs) {
      const process = childDouble();
      const result = setup({ process });
      const spawnSpy = result.spawn as unknown as ReturnType<typeof vi.fn>;
      const pending = result.client.format(snapshot(), target, options, resource(), source().token);
      await vi.waitFor(() => {
        expect(spawnSpy).toHaveBeenCalledTimes(1);
      });
      process.stdout.emit("data", output);
      process.emit("close", 0, null);
      await expect(pending, name).resolves.toMatchObject({
        ok: false,
        error: { code: "PROTOCOL_ERROR" },
      });
    }
  });

  it("rejects unexpected stderr and bounded output without exposing data", async () => {
    const process = childDouble();
    const result = setup({ process });
    const spawnSpy = result.spawn as unknown as ReturnType<typeof vi.fn>;
    const pending = result.client.format(
      snapshot("UNIQUE-SOURCE-SECRET"),
      target,
      options,
      resource(),
      source().token,
    );
    await vi.waitFor(() => {
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    });
    process.stderr.emit("data", Buffer.from("unexpected warning"));
    process.emit("close", 0, null);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "PROCESS_FAILED" } });
    expect(JSON.stringify(await pending)).not.toContain("UNIQUE-SOURCE-SECRET");

    const stdoutOverflow = childDouble();
    const stdoutResult = setup({ process: stdoutOverflow });
    const stdoutSpawnSpy = stdoutResult.spawn as unknown as ReturnType<typeof vi.fn>;
    const stdoutPending = stdoutResult.client.locate(
      snapshot(),
      target,
      options,
      resource(),
      source().token,
    );
    await vi.waitFor(() => {
      expect(stdoutSpawnSpy).toHaveBeenCalledTimes(1);
    });
    stdoutOverflow.stdout.emit("data", Buffer.alloc(MAX_STDOUT_BYTES + 1));
    await expect(stdoutPending).resolves.toMatchObject({
      ok: false,
      error: { code: "RESOURCE_LIMIT_EXCEEDED" },
    });
    expect(stdoutOverflow.kill).toHaveBeenCalledTimes(1);

    const stderrOverflow = childDouble();
    const stderrResult = setup({ process: stderrOverflow });
    const stderrSpawnSpy = stderrResult.spawn as unknown as ReturnType<typeof vi.fn>;
    const stderrPending = stderrResult.client.locate(
      snapshot(),
      target,
      options,
      resource(),
      source().token,
    );
    await vi.waitFor(() => {
      expect(stderrSpawnSpy).toHaveBeenCalledTimes(1);
    });
    stderrOverflow.stderr.emit("data", Buffer.alloc(MAX_STDERR_BYTES + 1));
    await expect(stderrPending).resolves.toMatchObject({
      ok: false,
      error: { code: "RESOURCE_LIMIT_EXCEEDED" },
    });
    expect(stderrOverflow.kill).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized stdin request before spawning", async () => {
    const result = setup();
    const oversized = "x".repeat(MAX_STDIN_BYTES);
    await expect(
      result.client.locate(snapshot(oversized), target, options, resource(), source().token),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "RESOURCE_LIMIT_EXCEEDED" },
    });
    expect(result.spawn).not.toHaveBeenCalled();
  });
});
