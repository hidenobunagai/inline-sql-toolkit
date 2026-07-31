import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import {
  createPythonResolver,
  type PythonResolverDependencies,
  VERSION_ARGUMENTS,
} from "../../src/vscode/python-resolver.js";
import { __mock } from "../support/vscode-mock.js";

type FakeProcess = EventEmitter & {
  readonly stdin: EventEmitter & { end: () => void };
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly removeAllListeners: (event?: string | symbol) => FakeProcess;
};

function processDouble(): FakeProcess {
  return Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  });
}

function tokenSource(): vscode.CancellationTokenSource {
  return new vscode.CancellationTokenSource();
}

function event<T>(): {
  readonly event: vscode.Event<T>;
  fire(value: T): void;
  readonly disposeCalls: () => number;
} {
  const listeners = new Set<(value: T) => unknown>();
  let disposeCalls = 0;
  return {
    event: (listener) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
          disposeCalls += 1;
        },
      };
    },
    fire(value) {
      for (const listener of listeners) listener(value);
    },
    disposeCalls: () => disposeCalls,
  };
}

function target(): import("../../src/vscode/document-target.js").SupportedDocument {
  const document = __mock.document({ uri: "file:///workspace/query.py", languageId: "python" });
  return { document, documentUri: document.uri, resourceUri: document.uri };
}

function apiFacade(executable = "/env/bin/python") {
  return {
    ready: Promise.resolve(),
    environments: {
      getActiveEnvironmentPath: vi.fn(() => "selected"),
      resolveEnvironment: vi.fn(() =>
        Promise.resolve({ executable: { uri: vscode.Uri.file(executable) } }),
      ),
      onDidChangeActiveEnvironmentPath: event().event,
    },
  };
}

function dependencies(
  overrides: Partial<PythonResolverDependencies> = {},
): PythonResolverDependencies & {
  readonly process: FakeProcess;
  readonly configurationChanges: ReturnType<typeof event<vscode.ConfigurationChangeEvent>>;
  readonly trustGrants: ReturnType<typeof event<undefined>>;
} {
  const configurationChanges = event<vscode.ConfigurationChangeEvent>();
  const trustGrants = event<undefined>();
  const process = processDouble();
  return {
    isWorkspaceTrusted: () => true,
    getPythonExtension: () => undefined,
    getPythonApi: () => Promise.resolve(apiFacade() as never),
    spawn: vi.fn(() => process) as unknown as PythonResolverDependencies["spawn"],
    onDidChangeConfiguration: configurationChanges.event,
    onDidGrantWorkspaceTrust: trustGrants.event,
    ...overrides,
    process,
    configurationChanges,
    trustGrants,
  };
}

function finish(process: FakeProcess, output = "3.12.0\n", code: number | null = 0): void {
  process.stdout.emit("data", Buffer.from(output));
  process.emit("close", code, null);
}

beforeEach(() => {
  __mock.reset();
  vi.useRealTimers();
});

describe("Python resolver priority", () => {
  it("uses a non-empty resource-scoped override as a terminal choice", async () => {
    const uri = target().resourceUri;
    __mock.setConfiguration(uri, "pythonPath", "/opt/python with spaces");
    const deps = dependencies();
    const resolver = createPythonResolver(deps);
    const pending = resolver.resolve(target(), tokenSource().token);
    expect(deps.spawn).toHaveBeenCalledWith(
      "/opt/python with spaces",
      [...VERSION_ARGUMENTS],
      expect.objectContaining({ shell: false }),
    );
    finish(deps.process);
    await expect(pending).resolves.toMatchObject({
      ok: true,
      python: {
        executable: "/opt/python with spaces",
        source: "configuration",
        version: { major: 3, minor: 12, patch: 0 },
      },
    });
  });

  it("uses the selected Python extension environment and passes the resource URI", async () => {
    const facade = apiFacade("/selected/python");
    const getActive = facade.environments.getActiveEnvironmentPath;
    const deps = dependencies({
      getPythonExtension: () => ({ id: "ms-python.python" }) as vscode.Extension<unknown>,
      getPythonApi: () => Promise.resolve(facade as never),
    });
    const pending = createPythonResolver(deps).resolve(target(), tokenSource().token);
    await vi.waitFor(() => {
      expect(getActive).toHaveBeenCalledWith(target().resourceUri);
    });
    finish(deps.process);
    await expect(pending).resolves.toMatchObject({
      ok: true,
      python: { executable: "/selected/python", source: "python-extension" },
    });
  });

  it("tries PATH python3 then python only when python3 is not found", async () => {
    const first = processDouble();
    const second = processDouble();
    let calls = 0;
    const deps = dependencies({
      spawn: vi.fn(() =>
        calls++ === 0 ? first : second,
      ) as unknown as PythonResolverDependencies["spawn"],
    });
    const pending = createPythonResolver(deps).resolve(target(), tokenSource().token);
    expect(deps.spawn).toHaveBeenCalledWith("python3", expect.any(Array), expect.any(Object));
    first.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
    await vi.waitFor(() => {
      expect(deps.spawn).toHaveBeenCalledWith("python", expect.any(Array), expect.any(Object));
    });
    finish(second, "3.13.2\n");
    await expect(pending).resolves.toMatchObject({
      ok: true,
      python: { executable: "python", source: "path", version: { minor: 13, patch: 2 } },
    });
  });

  it("does not fall through when the Python extension is installed but unresolved", async () => {
    const facade = apiFacade();
    facade.environments.resolveEnvironment.mockImplementation(() =>
      Promise.resolve(undefined as never),
    );
    const deps = dependencies({
      getPythonExtension: () => ({ id: "ms-python.python" }) as vscode.Extension<unknown>,
      getPythonApi: () => Promise.resolve(facade as never),
    });
    await expect(
      createPythonResolver(deps).resolve(target(), tokenSource().token),
    ).resolves.toEqual({ ok: false, reason: "PROCESS_FAILED" });
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("rejects malformed configuration before any API or process call", async () => {
    __mock.setConfiguration(target().resourceUri, "pythonPath", 123);
    const api = apiFacade();
    const deps = dependencies({
      getPythonExtension: () => ({ id: "ms-python.python" }) as vscode.Extension<unknown>,
      getPythonApi: () => Promise.resolve(api as never),
    });
    await expect(
      createPythonResolver(deps).resolve(target(), tokenSource().token),
    ).resolves.toEqual({ ok: false, reason: "INVALID_CONFIGURATION" });
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(api.environments.getActiveEnvironmentPath).not.toHaveBeenCalled();
  });
});

describe("bounded version probe", () => {
  it.each(["3.11.9\n", "3.12", "3.12.0\nextra\n", "3.12.0\u0000\n"])(
    "rejects malformed or unsupported output %j",
    async (output) => {
      const deps = dependencies();
      const pending = createPythonResolver(deps).resolve(target(), tokenSource().token);
      finish(deps.process, output);
      await expect(pending).resolves.toMatchObject({ ok: false });
      expect(deps.spawn).toHaveBeenCalledWith(
        "python3",
        [...VERSION_ARGUMENTS],
        expect.objectContaining({ shell: false, windowsHide: true }),
      );
    },
  );

  it("accepts a future major Python version", async () => {
    const deps = dependencies();
    const pending = createPythonResolver(deps).resolve(target(), tokenSource().token);
    finish(deps.process, "4.0.0\n");
    await expect(pending).resolves.toMatchObject({
      ok: true,
      python: { version: { major: 4, minor: 0, patch: 0 } },
    });
  });

  it("maps nonzero exits and synchronous spawn errors without source text", async () => {
    const deps = dependencies({
      spawn: vi.fn(() => {
        throw new Error("secret source");
      }) as unknown as PythonResolverDependencies["spawn"],
    });
    await expect(
      createPythonResolver(deps).resolve(target(), tokenSource().token),
    ).resolves.toEqual({ ok: false, reason: "PROCESS_FAILED" });
  });

  it("honors cancellation and kills a silent process exactly once", async () => {
    vi.useFakeTimers();
    const deps = dependencies();
    const source = tokenSource();
    const pending = createPythonResolver(deps).resolve(target(), source.token);
    source.cancel();
    await expect(pending).resolves.toEqual({ ok: false, reason: "PROCESS_CANCELLED" });
    expect(deps.process.kill).toHaveBeenCalledTimes(1);
    const second = dependencies();
    const secondPending = createPythonResolver(second).resolve(target(), tokenSource().token);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(secondPending).resolves.toEqual({ ok: false, reason: "PROCESS_TIMEOUT" });
    expect(second.process.kill).toHaveBeenCalledTimes(1);
  });

  it("preserves cancellation when kill synchronously emits close", async () => {
    const deps = dependencies();
    deps.process.kill.mockImplementation(() => {
      deps.process.emit("close", 1, null);
      return true;
    });
    const source = tokenSource();
    const pending = createPythonResolver(deps).resolve(target(), source.token);
    source.cancel();
    await expect(pending).resolves.toEqual({ ok: false, reason: "PROCESS_CANCELLED" });
    expect(deps.process.kill).toHaveBeenCalledTimes(1);
  });
});
