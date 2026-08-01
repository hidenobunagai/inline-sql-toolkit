import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { activate, deactivate } from "../../src/extension.js";
import type { LocateResponse } from "../../src/protocol.js";
import {
  type CodeActionDependencies,
  InlineSqlCodeActionProvider,
} from "../../src/vscode/code-actions.js";
import { COMMANDS, registerCommands } from "../../src/vscode/commands.js";
import type { FormatController } from "../../src/vscode/format-controller.js";
import type { HelperClient } from "../../src/vscode/helper-client.js";
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

function candidates(...ranges: [number, number, number, number][]): LocateResponse {
  return {
    protocolVersion: 1,
    operation: "locate",
    ok: true,
    candidates: ranges.map(([startLine, startCharacter, endLine, endCharacter]) => ({
      start: { line: startLine, character: startCharacter },
      end: { line: endLine, character: endCharacter },
    })),
  };
}

function helperWith(response: LocateResponse): HelperClient & {
  readonly locateCalls: ReturnType<typeof vi.fn>;
} {
  const locateCalls = vi.fn(() => Promise.resolve(response));
  return {
    locate: locateCalls,
    format: vi.fn(),
    protect: vi.fn(),
    finalize: vi.fn(),
    locateCalls,
  };
}

function providerFor(
  helper: HelperClient,
  trusted: () => boolean = () => true,
): InlineSqlCodeActionProvider {
  const dependencies: CodeActionDependencies = {
    helper,
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
  it("offers a cursor action for an intersecting candidate and routes by URI", async () => {
    const value = document();
    const helper = helperWith(candidates([0, 9, 0, 17]));
    const provider = providerFor(helper);
    const range = new vscode.Range(0, 11, 0, 11);
    const actions = await provider.provideCodeActions(
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
    expect(helper.locateCalls).toHaveBeenCalledWith(
      expect.objectContaining({ uri: value.uri, version: value.version, text: value.getText() }),
      { mode: "all" },
      expect.objectContaining({ keywordCase: "upper" }),
      expect.objectContaining({ document: value, documentUri: value.uri, resourceUri: value.uri }),
      expect.anything(),
    );
  });

  it("uses selection mode for non-empty ranges without changing the action range", async () => {
    const value = document();
    const helper = helperWith(candidates([0, 9, 0, 17]));
    const provider = providerFor(helper);
    const range = new vscode.Range(0, 9, 0, 14);
    const actions = await provider.provideCodeActions(
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

  it("caches only a successful locate result for one URI/version", async () => {
    const value = document();
    const helper = helperWith(candidates([0, 9, 0, 17]));
    const provider = providerFor(helper);
    const token = new vscode.CancellationTokenSource().token;
    await provider.provideCodeActions(
      value,
      new vscode.Range(0, 10, 0, 10),
      {} as vscode.CodeActionContext,
      token,
    );
    await provider.provideCodeActions(
      value,
      new vscode.Range(0, 12, 0, 12),
      {} as vscode.CodeActionContext,
      token,
    );
    expect(helper.locateCalls).toHaveBeenCalledTimes(1);
    const changed = __mock.document({
      uri: value.uri.toString(),
      languageId: "python",
      text: value.getText(),
      version: value.version + 1,
    });
    await provider.provideCodeActions(
      changed,
      new vscode.Range(0, 10, 0, 10),
      {} as vscode.CodeActionContext,
      token,
    );
    expect(helper.locateCalls).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["untrusted", () => false],
    ["unsupported", () => true],
  ])("returns no action for %s without locating", async (label, trust) => {
    const value =
      label === "unsupported"
        ? __mock.document({
            uri: "file:///workspace/query.sql",
            languageId: "sql",
            text: "SELECT 1",
          })
        : document();
    const helper = helperWith(candidates([0, 0, 0, 1]));
    const provider = providerFor(helper, trust);
    const actions = await provider.provideCodeActions(
      value,
      new vscode.Range(0, 0, 0, 0),
      {} as vscode.CodeActionContext,
      new vscode.CancellationTokenSource().token,
    );
    expect(actions).toEqual([]);
    expect(helper.locateCalls).not.toHaveBeenCalled();
  });

  it("rejects cancellation, failures, missing candidates, and endpoint-only contact", async () => {
    const value = document();
    const source = new vscode.CancellationTokenSource();
    source.cancel();
    const cancelledHelper = helperWith(candidates([0, 9, 0, 17]));
    expect(
      await providerFor(cancelledHelper).provideCodeActions(
        value,
        new vscode.Range(0, 10, 0, 10),
        {} as vscode.CodeActionContext,
        source.token,
      ),
    ).toEqual([]);
    expect(cancelledHelper.locateCalls).not.toHaveBeenCalled();

    const failed = helperWith({
      protocolVersion: 1,
      operation: "locate",
      ok: false,
      error: { code: "DOCUMENT_PARSE_FAILED" },
    });
    expect(
      await providerFor(failed).provideCodeActions(
        value,
        new vscode.Range(0, 10, 0, 10),
        {} as vscode.CodeActionContext,
        new vscode.CancellationTokenSource().token,
      ),
    ).toEqual([]);

    const noCandidate = helperWith(candidates([0, 0, 0, 2]));
    expect(
      await providerFor(noCandidate).provideCodeActions(
        value,
        new vscode.Range(0, 9, 0, 9),
        {} as vscode.CodeActionContext,
        new vscode.CancellationTokenSource().token,
      ),
    ).toEqual([]);
    const endpoint = helperWith(candidates([0, 9, 0, 17]));
    expect(
      await providerFor(endpoint).provideCodeActions(
        value,
        new vscode.Range(0, 17, 0, 17),
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
