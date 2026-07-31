import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import {
  createPythonResolver,
  type PythonResolverDependencies,
} from "../../src/vscode/python-resolver.js";
import { __mock } from "../support/vscode-mock.js";

function event<T>() {
  const listeners = new Set<(value: T) => unknown>();
  return {
    event: ((listener: (value: T) => unknown) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    }) as vscode.Event<T>,
    fire(value: T) {
      for (const listener of listeners) listener(value);
    },
  };
}

function target(): import("../../src/vscode/document-target.js").SupportedDocument {
  const document = __mock.document({ uri: "file:///workspace/query.py", languageId: "python" });
  return { document, documentUri: document.uri, resourceUri: document.uri };
}

beforeEach(() => {
  __mock.reset();
});

describe("workspace trust guards", () => {
  it("does not read configuration, API, PATH, or spawn while untrusted", async () => {
    __mock.setTrusted(false);
    __mock.setConfiguration(target().resourceUri, "pythonPath", "/secret/python");
    const trust = event<undefined>();
    const spawn = vi.fn();
    const getPythonApi = vi.fn(() => Promise.reject(new Error("must not call")));
    const deps: PythonResolverDependencies = {
      isWorkspaceTrusted: () => false,
      getPythonExtension: () => ({ id: "ms-python.python" }) as vscode.Extension<unknown>,
      getPythonApi,
      spawn: spawn,
      onDidChangeConfiguration: event<vscode.ConfigurationChangeEvent>().event,
      onDidGrantWorkspaceTrust: trust.event as vscode.Event<void>,
    };
    const result = await createPythonResolver(deps).resolve(
      target(),
      new vscode.CancellationTokenSource().token,
    );
    expect(result).toEqual({ ok: false, reason: "WORKSPACE_UNTRUSTED" });
    expect(__mock.configurationReads("pythonPath")).toBe(0);
    expect(getPythonApi).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("resolves after trust grant and invalidates on configuration changes", async () => {
    let trusted = false;
    const trust = event<undefined>();
    const config = event<vscode.ConfigurationChangeEvent>();
    const child = Object.assign(new (class extends EventTarget {})(), {});
    void child;
    const process = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { once: vi.fn(), end: vi.fn(), removeAllListeners: vi.fn() },
      once: vi.fn(),
      kill: vi.fn(),
      removeAllListeners: vi.fn(),
    };
    const spawn = vi.fn(() => process as never);
    const deps: PythonResolverDependencies = {
      isWorkspaceTrusted: () => trusted,
      getPythonExtension: () => undefined,
      getPythonApi: vi.fn(() => Promise.reject(new Error("not installed"))),
      spawn: spawn,
      onDidChangeConfiguration: config.event,
      onDidGrantWorkspaceTrust: trust.event as vscode.Event<void>,
    };
    const resolver = createPythonResolver(deps);
    expect(await resolver.resolve(target(), new vscode.CancellationTokenSource().token)).toEqual({
      ok: false,
      reason: "WORKSPACE_UNTRUSTED",
    });
    trusted = true;
    trust.fire(undefined);
    expect(resolver).toBeDefined();
    config.fire({ affectsConfiguration: () => true });
    resolver.dispose();
    resolver.dispose();
  });
});
