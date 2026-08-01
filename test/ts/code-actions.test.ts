import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { activate, deactivate } from "../../src/extension.js";
import {
  type CodeActionDependencies,
  InlineSqlCodeActionProvider,
  LocateCache,
} from "../../src/vscode/code-actions.js";
import { COMMANDS, registerCommands } from "../../src/vscode/commands.js";
import type { FormatController } from "../../src/vscode/format-controller.js";
import { __mock } from "../support/vscode-mock.js";

beforeEach(() => {
  __mock.reset();
});

function context(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

function document(text = "query = 'SELECT 1'"): vscode.TextDocument {
  return __mock.document({
    uri: "file:///workspace/query.py",
    languageId: "python",
    text,
  });
}

function providerFor(trusted: () => boolean = () => true): InlineSqlCodeActionProvider {
  const dependencies: CodeActionDependencies = {
    isWorkspaceTrusted: trusted,
  };
  return new InlineSqlCodeActionProvider(dependencies);
}

describe("public command registration", () => {
  it("registers exactly the three commands and delegates their modes", async () => {
    const execute = vi.fn<FormatController["execute"]>(() => Promise.resolve());
    const controller = { execute } as unknown as FormatController;
    const extensionContext = context();
    registerCommands(extensionContext, controller);

    expect(__mock.commandRegistrations().map(({ command }) => command)).toEqual([
      COMMANDS.cursor,
      COMMANDS.selection,
      COMMANDS.all,
    ]);

    await vscode.commands.executeCommand(COMMANDS.cursor);
    await vscode.commands.executeCommand(COMMANDS.selection);
    await vscode.commands.executeCommand(COMMANDS.all);
    expect(execute.mock.calls.map(([mode]) => mode)).toEqual(["cursor", "selection", "all"]);
  });

  it("routes a Code Action invocation through the same command table", async () => {
    const execute = vi.fn<FormatController["execute"]>(() => Promise.resolve());
    const extensionContext = context();
    registerCommands(extensionContext, { execute });
    const value = document();
    const range = new vscode.Range(0, 10, 0, 16);
    await vscode.commands.executeCommand(COMMANDS.selection, {
      documentUri: value.uri,
      range,
    });
    expect(execute).toHaveBeenCalledWith("selection", {
      documentUri: value.uri,
      range,
    });
  });
});

describe("InlineSqlCodeActionProvider", () => {
  it("offers a cursor action for an intersecting candidate and routes by URI", () => {
    const value = document();
    const provider = providerFor();
    const range = new vscode.Range(0, 11, 0, 11);
    const actions = provider.provideCodeActions(
      value,
      range,
      {} as vscode.CodeActionContext,
      new vscode.CancellationTokenSource().token,
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Format inline SQL");
    expect(actions[0]?.kind).toBe(vscode.CodeActionKind.RefactorRewrite);
    expect(actions[0]?.command).toEqual({
      title: "Format inline SQL",
      command: COMMANDS.cursor,
      arguments: [{ documentUri: value.uri, range }],
    });
  });

  it("uses selection mode for non-empty ranges without changing the action range", () => {
    const value = document();
    const provider = providerFor();
    const range = new vscode.Range(0, 9, 0, 14);
    const actions = provider.provideCodeActions(
      value,
      range,
      {} as vscode.CodeActionContext,
      new vscode.CancellationTokenSource().token,
    );
    expect(actions[0]?.command).toEqual({
      title: "Format inline SQL",
      command: COMMANDS.selection,
      arguments: [{ documentUri: value.uri, range }],
    });
  });

  it("caches located candidates per URI and version", () => {
    const cache = new LocateCache();
    const uri = vscode.Uri.file("/workspace/query.py");
    const first = [{ start: { line: 0, character: 8 }, end: { line: 0, character: 18 } }];
    cache.set(uri, 1, first);
    expect(cache.get(uri, 1)).toEqual(first);
    expect(cache.get(uri, 2)).toBeUndefined();
    cache.set(uri, 2, [{ start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }]);
    expect(cache.get(uri, 1)).toEqual(first);
    expect(cache.get(uri, 2)).toHaveLength(1);
    cache.deleteUri(uri);
    expect(cache.get(uri, 1)).toBeUndefined();
    expect(cache.get(uri, 2)).toBeUndefined();
  });

  it.each([
    ["untrusted", () => false],
    ["unsupported", () => true],
  ])("returns no action for %s without locating", (label, trust) => {
    const value =
      label === "unsupported"
        ? __mock.document({
            uri: "file:///workspace/query.sql",
            languageId: "sql",
            text: "SELECT 1",
          })
        : document();
    const provider = providerFor(trust);
    const actions = provider.provideCodeActions(
      value,
      new vscode.Range(0, 0, 0, 0),
      {} as vscode.CodeActionContext,
      new vscode.CancellationTokenSource().token,
    );
    expect(actions).toEqual([]);
  });

  it("rejects cancellation, missing candidates, and endpoint-only contact", () => {
    const value = document();
    const source = new vscode.CancellationTokenSource();
    source.cancel();
    expect(
      providerFor().provideCodeActions(
        value,
        new vscode.Range(0, 10, 0, 10),
        {} as vscode.CodeActionContext,
        source.token,
      ),
    ).toEqual([]);

    const noCandidate = document("query = 'not sql'");
    expect(
      providerFor().provideCodeActions(
        noCandidate,
        new vscode.Range(0, 9, 0, 9),
        {} as vscode.CodeActionContext,
        new vscode.CancellationTokenSource().token,
      ),
    ).toEqual([]);

    expect(
      providerFor().provideCodeActions(
        value,
        new vscode.Range(0, 18, 0, 18),
        {} as vscode.CodeActionContext,
        new vscode.CancellationTokenSource().token,
      ),
    ).toEqual([]);
  });
});

describe("extension activation lifecycle", () => {
  it("registers actions once when trust is granted and keeps commands available", () => {
    __mock.setTrusted(false);
    const extensionContext = {
      extensionMode: 1,
      extensionUri: vscode.Uri.file("/private/extension"),
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;
    activate(extensionContext);
    expect(__mock.codeActionRegistrations()).toHaveLength(0);
    expect(__mock.commandRegistrations().map(({ command }) => command)).toEqual([
      COMMANDS.cursor,
      COMMANDS.selection,
      COMMANDS.all,
    ]);

    __mock.fireTrustGrant();
    expect(__mock.codeActionRegistrations()).toHaveLength(1);
    __mock.fireTrustGrant();
    expect(__mock.codeActionRegistrations()).toHaveLength(1);
    expect(__mock.commandRegistrations().map(({ command }) => command)).toEqual([
      COMMANDS.cursor,
      COMMANDS.selection,
      COMMANDS.all,
    ]);
    deactivate();
    expect(__mock.codeActionRegistrations()).toHaveLength(0);
  });

  it("tears down module state before a second activation", () => {
    const first = {
      extensionMode: 1,
      extensionUri: vscode.Uri.file("/private/first"),
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;
    const second = {
      extensionMode: 1,
      extensionUri: vscode.Uri.file("/private/second"),
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;
    activate(first);
    expect(__mock.codeActionRegistrations()).toHaveLength(1);
    activate(second);
    expect(__mock.codeActionRegistrations()).toHaveLength(1);
    expect(__mock.commandRegistrations().map(({ command }) => command)).toEqual([
      COMMANDS.cursor,
      COMMANDS.selection,
      COMMANDS.all,
    ]);
    deactivate();
  });
});
