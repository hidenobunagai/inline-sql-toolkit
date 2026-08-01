import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";

import { DefaultFormatController, protocolTarget } from "../../src/vscode/format-controller.js";
import type { NotificationSink } from "../../src/vscode/notifications.js";
import type { IntegrationTestHooks, TestOperationOutcome } from "../../src/vscode/test-hooks.js";
import { createTestHooks, TEST_HOOK_COMMANDS } from "../../src/vscode/test-hooks.js";
import { __mock } from "../support/vscode-mock.js";

beforeEach(() => {
  __mock.reset();
});

function notifications(): NotificationSink & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    reason: (code) => calls.push(`reason:${code}`),
    target: (code) => calls.push(`target:${code}`),
    emptySelection: () => calls.push("empty-selection"),
    summary: (summary, skipped) => calls.push(`summary:${summary.changed}:${skipped}`),
  };
}

function hooks(): IntegrationTestHooks & { readonly outcomes: TestOperationOutcome[] } {
  const outcomes: TestOperationOutcome[] = [];
  return {
    outcomes,
    processWillSpawn: () => {},
    afterHelperResponse: async () => {},
    isWorkspaceTrusted: (value) => value,
    applyWorkspaceEdit: () => Promise.resolve(true),
    operationCompleted: (outcome) => outcomes.push(outcome),
  };
}

function setup(text = 'query = "select 1"') {
  const document = __mock.document({
    uri: "file:///workspace/query.py",
    languageId: "python",
    text,
  });
  const editor = __mock.editor(document);
  __mock.setActiveEditor(editor);
  const hook = hooks();
  let trusted = true;
  (hook as { isWorkspaceTrusted: (value: boolean) => boolean }).isWorkspaceTrusted = (value) =>
    trusted && value;
  const note = notifications();
  const controller = new DefaultFormatController({ hooks: hook, notifications: note });
  return {
    document,
    editor,
    hook,
    note,
    controller,
    setTrusted: (value: boolean) => {
      trusted = value;
    },
  };
}

describe("protocol target construction", () => {
  it("uses active cursor, selection, and no coordinates for all", () => {
    const document = __mock.document({
      uri: "file:///target.py",
      languageId: "python",
      text: "SELECT",
    });
    const editor = __mock.editor(document);
    const selection = new vscode.Selection(new vscode.Position(0, 1), new vscode.Position(0, 4));
    (editor as { selection: vscode.Selection }).selection = selection;
    expect(protocolTarget("cursor", editor)).toEqual({
      mode: "cursor",
      cursor: { line: 0, character: 4 },
    });
    expect(protocolTarget("selection", editor)).toEqual({
      mode: "selection",
      selection: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
    });
    expect(protocolTarget("all", editor)).toEqual({ mode: "all" });
    expect(
      protocolTarget("selection", editor, { range: new vscode.Range(0, 2, 0, 2) }),
    ).toBeUndefined();
    expect(protocolTarget("cursor", editor, { range: new vscode.Range(0, 2, 0, 2) })).toEqual({
      mode: "cursor",
      cursor: { line: 0, character: 2 },
    });
  });
});

describe("DefaultFormatController", () => {
  it("formats a changed candidate without a success notification", async () => {
    const value = setup();
    await value.controller.execute("all");
    expect(value.hook.outcomes).toEqual([{ changed: 1, skipped: 0 }]);
    expect(value.note.calls).toEqual([]);
  });

  it("summarizes unchanged and all-skipped results", async () => {
    const unchanged = setup('query = """\nSELECT\n  1\n"""');
    await unchanged.controller.execute("all");
    expect(unchanged.note.calls).toEqual(["summary:0:0"]);
    const skipped = setup('query = "select 1" "x"');
    await skipped.controller.execute("all");
    expect(skipped.note.calls).toEqual(["summary:0:1"]);
  });

  it("reports no SQL candidate and empty selections without applying", async () => {
    const none = setup('query = "not sql"');
    await none.controller.execute("all");
    expect(none.note.calls).toEqual(["reason:NO_SQL_CANDIDATE"]);
    expect(none.hook.outcomes).toEqual([{ changed: 0, skipped: 0, reason: "NO_SQL_CANDIDATE" }]);
    const empty = setup();
    (empty.editor as { selection: vscode.Selection }).selection = new vscode.Selection(0, 0, 0, 0);
    await empty.controller.execute("selection");
    expect(empty.note.calls).toEqual(["empty-selection"]);
  });

  it("selects candidates by cursor and selection", async () => {
    const value = setup('q1 = "select 1"\nq2 = "select 2"');
    (value.editor as { selection: vscode.Selection }).selection = new vscode.Selection(0, 9, 0, 9);
    await value.controller.execute("cursor");
    expect(value.hook.outcomes).toEqual([{ changed: 1, skipped: 0 }]);
    value.hook.outcomes.length = 0;
    (value.editor as { selection: vscode.Selection }).selection = new vscode.Selection(1, 9, 1, 9);
    await value.controller.execute("cursor");
    expect(value.hook.outcomes).toEqual([{ changed: 1, skipped: 0 }]);
    value.hook.outcomes.length = 0;
    await value.controller.execute("all");
    expect(value.hook.outcomes).toEqual([{ changed: 2, skipped: 0 }]);
  });

  it("formats every code cell when running all on a notebook", async () => {
    const first = __mock.document({
      uri: "file:///workspace/cell1.py",
      languageId: "python",
      text: 'q1 = "select 1"',
    });
    const second = __mock.document({
      uri: "file:///workspace/cell2.py",
      languageId: "python",
      text: 'q2 = "select 2"',
    });
    const notebook = __mock.notebook({
      uri: "file:///workspace/book.ipynb",
      notebookType: "jupyter-notebook",
      cells: [first, second],
    });
    __mock.setNotebookDocuments([notebook]);
    __mock.setActiveNotebook(notebook);
    const applied: unknown[] = [];
    const value = setup();
    __mock.setActiveEditor(__mock.editor(first));
    (
      value.hook as { applyWorkspaceEdit: (edit: unknown) => Thenable<boolean> }
    ).applyWorkspaceEdit = (edit) => {
      applied.push(edit);
      return Promise.resolve(true);
    };
    await value.controller.execute("all");
    expect(value.hook.outcomes).toEqual([{ changed: 2, skipped: 0 }]);
    expect(applied).toHaveLength(1);
  });

  it("rejects trust and unsupported targets before formatting", async () => {
    const untrusted = setup();
    untrusted.setTrusted(false);
    await untrusted.controller.execute("all");
    expect(untrusted.note.calls).toEqual(["reason:WORKSPACE_UNTRUSTED"]);
    const unsupported = setup();
    const raw = __mock.document({
      uri: "file:///workspace/query.sql",
      languageId: "sql",
      text: "SELECT 1",
    });
    __mock.setActiveEditor(__mock.editor(raw));
    await unsupported.controller.execute("all");
    expect(unsupported.note.calls).toEqual(["target:UNSUPPORTED_DOCUMENT"]);
  });
});

describe("production-safe integration hooks", () => {
  it("does not register unmanifested commands outside test mode", async () => {
    const context = { extensionMode: 1, subscriptions: [] } as unknown as vscode.ExtensionContext;
    const hooks = createTestHooks(context);
    expect(__mock.commandRegistrations().map((item) => item.command)).not.toContain(
      TEST_HOOK_COMMANDS.configure,
    );
    expect(await vscode.commands.executeCommand(TEST_HOOK_COMMANDS.read)).toBeUndefined();
    expect(hooks.isWorkspaceTrusted(true)).toBe(true);
  });

  it("exposes a deterministic barrier and source-free outcome in test mode", async () => {
    const context = {
      extensionMode: vscode.ExtensionMode.Test,
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;
    const hooks = createTestHooks(context);
    await vscode.commands.executeCommand(TEST_HOOK_COMMANDS.configure, { pauseBeforeApply: true });
    const waiting = vscode.commands.executeCommand(TEST_HOOK_COMMANDS.read, {
      waitForBarrier: true,
    });
    const barrier = hooks.afterHelperResponse(() => {});
    await expect(waiting).resolves.toMatchObject({ barrierReached: true });
    hooks.operationCompleted({ changed: 2, skipped: 1 });
    await vscode.commands.executeCommand(TEST_HOOK_COMMANDS.release);
    await barrier;
    await expect(vscode.commands.executeCommand(TEST_HOOK_COMMANDS.read)).resolves.toMatchObject({
      lastOutcome: { changed: 2, skipped: 1 },
    });
  });
});
