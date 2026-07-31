import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import type { FormatResponse, FormatSuccess, ReasonCode } from "../../src/protocol.js";
import { DefaultFormatController, protocolTarget } from "../../src/vscode/format-controller.js";
import type { HelperClient } from "../../src/vscode/helper-client.js";
import type { NotificationSink } from "../../src/vscode/notifications.js";
import type { IntegrationTestHooks, TestOperationOutcome } from "../../src/vscode/test-hooks.js";
import { createTestHooks, TEST_HOOK_COMMANDS } from "../../src/vscode/test-hooks.js";
import { __mock } from "../support/vscode-mock.js";

beforeEach(() => {
  __mock.reset();
});

function success(
  text = "SELECT 1",
  newText = "SELECT 1",
  skips: FormatSuccess["skips"] = [],
): FormatResponse {
  return {
    protocolVersion: 1,
    operation: "format",
    ok: true,
    edits:
      newText === text
        ? []
        : [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } },
              expectedText: text,
              newText,
            },
          ],
    skips,
    summary: {
      discovered: 1,
      selected: 1,
      changed: newText === text ? 0 : 1,
      unchanged: newText === text ? 1 : 0,
      skipped: skips.length,
    },
  };
}

function error(code: ReasonCode): FormatResponse {
  return { protocolVersion: 1, operation: "format", ok: false, error: { code } };
}

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

function setup(response: FormatResponse = success()) {
  const document = __mock.document({
    uri: "file:///workspace/query.py",
    languageId: "python",
    text: "SELECT 1",
  });
  const editor = __mock.editor(document);
  __mock.setActiveEditor(editor);
  const format = vi.fn<
    (
      snapshot: Parameters<HelperClient["format"]>[0],
      target: Parameters<HelperClient["format"]>[1],
      configuration: Parameters<HelperClient["format"]>[2],
      resource: Parameters<HelperClient["format"]>[3],
      token: Parameters<HelperClient["format"]>[4],
    ) => Promise<FormatResponse>
  >(() => Promise.resolve(response));
  const helper: HelperClient = {
    locate: vi.fn(),
    format,
  };
  const hook = hooks();
  let trusted = true;
  (hook as { isWorkspaceTrusted: (value: boolean) => boolean }).isWorkspaceTrusted = (value) =>
    trusted && value;
  const note = notifications();
  const controller = new DefaultFormatController({ helper, hooks: hook, notifications: note });
  return {
    document,
    editor,
    helper,
    format,
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
    const value = setup(success("SELECT 1", "SELECT 2"));
    await value.controller.execute("all");
    expect(value.format).toHaveBeenCalledTimes(1);
    expect(value.hook.outcomes).toEqual([{ changed: 1, skipped: 0 }]);
    expect(value.note.calls).toEqual([]);
  });

  it("summarizes unchanged and all-skipped results", async () => {
    const unchanged = setup(success());
    await unchanged.controller.execute("all");
    expect(unchanged.note.calls).toEqual(["summary:0:0"]);
    const skipped = setup({
      protocolVersion: 1,
      operation: "format",
      ok: true,
      edits: [],
      skips: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
          reason: "UNSUPPORTED_LITERAL",
        },
      ],
      summary: { discovered: 1, selected: 1, changed: 0, unchanged: 0, skipped: 1 },
    });
    await skipped.controller.execute("all");
    expect(skipped.note.calls).toEqual(["summary:0:1"]);
  });

  it("maps helper errors and empty selections without applying", async () => {
    const failed = setup(error("FORMATTER_FAILED"));
    await failed.controller.execute("all");
    expect(failed.note.calls).toEqual(["reason:FORMATTER_FAILED"]);
    expect(failed.hook.outcomes).toEqual([{ changed: 0, skipped: 0, reason: "FORMATTER_FAILED" }]);
    const empty = setup();
    (empty.editor as { selection: vscode.Selection }).selection = new vscode.Selection(0, 0, 0, 0);
    await empty.controller.execute("selection");
    expect(empty.format).not.toHaveBeenCalled();
    expect(empty.note.calls).toEqual(["empty-selection"]);
  });

  it("passes selection and cursor targets to the helper", async () => {
    const value = setup();
    (value.editor as { selection: vscode.Selection }).selection = new vscode.Selection(0, 1, 0, 4);
    await value.controller.execute("cursor");
    expect(value.format.mock.calls[0]?.[1]).toEqual({
      mode: "cursor",
      cursor: { line: 0, character: 4 },
    });
    await value.controller.execute("selection");
    expect(value.format.mock.calls[1]?.[1]).toEqual({
      mode: "selection",
      selection: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
    });
  });

  it("rejects trust and unsupported targets before helper", async () => {
    const untrusted = setup();
    untrusted.setTrusted(false);
    await untrusted.controller.execute("all");
    expect(untrusted.format).not.toHaveBeenCalled();
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
