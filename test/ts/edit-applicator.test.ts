import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import type { FormatSuccess } from "../../src/protocol.js";
import type { DocumentSnapshot } from "../../src/vscode/edit-applicator.js";
import { DefaultEditApplicator, strictPosition } from "../../src/vscode/edit-applicator.js";
import { __mock } from "../support/vscode-mock.js";

beforeEach(() => {
  __mock.reset();
});

function response(edits: FormatSuccess["edits"]): FormatSuccess {
  return {
    protocolVersion: 1,
    operation: "format",
    ok: true,
    edits,
    skips: [],
    summary: {
      discovered: edits.length,
      selected: edits.length,
      changed: edits.length,
      unchanged: 0,
      skipped: 0,
    },
  };
}

function setup(text = "SELECT 1\nSELECT 2") {
  const document = __mock.document({
    uri: "file:///workspace/query.py",
    languageId: "python",
    text,
  });
  const snapshot: DocumentSnapshot = { uri: document.uri, version: document.version, text };
  const apply = vi.fn<(edit: vscode.WorkspaceEdit) => Promise<boolean>>(() =>
    Promise.resolve(true),
  );
  const applicator = new DefaultEditApplicator({ applyWorkspaceEdit: apply });
  const guard = {
    token: new vscode.CancellationTokenSource().token,
    isWorkspaceTrusted: () => true,
  };
  return { document, snapshot, apply, applicator, guard };
}

function edit(
  start: vscode.Position,
  end: vscode.Position,
  expectedText: string,
  newText = expectedText,
): FormatSuccess["edits"][number] {
  return {
    range: {
      start: { line: start.line, character: start.character },
      end: { line: end.line, character: end.character },
    },
    expectedText,
    newText,
  };
}

describe("strictPosition", () => {
  it("rejects out-of-bounds and a surrogate-interior UTF-16 boundary", () => {
    const document = __mock.document({
      uri: "file:///emoji.py",
      languageId: "python",
      text: "😀SELECT",
    });
    expect(strictPosition(document, { line: 0, character: 1 })).toBeUndefined();
    expect(strictPosition(document, { line: 0, character: 99 })).toBeUndefined();
    expect(strictPosition(document, { line: 1, character: 0 })).toBeUndefined();
    expect(strictPosition(document, { line: 0, character: 2 })).toEqual(new vscode.Position(0, 2));
  });

  it("accepts CRLF line starts and the empty final line", () => {
    const document = __mock.document({
      uri: "file:///crlf.py",
      languageId: "python",
      text: "SELECT\r\n",
    });
    expect(strictPosition(document, { line: 1, character: 0 })).toEqual(new vscode.Position(1, 0));
    expect(strictPosition(document, { line: 1, character: 1 })).toBeUndefined();
  });
});

describe("DefaultEditApplicator", () => {
  it("validates every edit before constructing/applying one workspace edit", async () => {
    const { document, snapshot, apply, applicator, guard } = setup();
    const result = await applicator.apply(
      document,
      snapshot,
      response([
        edit(new vscode.Position(0, 0), new vscode.Position(0, 8), "SELECT 1", "SELECT 9"),
        edit(new vscode.Position(1, 0), new vscode.Position(1, 8), "SELECT 2", "SELECT 8"),
      ]),
      guard,
    );
    expect(result).toEqual({ ok: true, applied: 2 });
    expect(apply).toHaveBeenCalledTimes(1);
    const workspaceEdit = apply.mock.calls[0]?.[0];
    expect(workspaceEdit).toBeDefined();
    expect(workspaceEdit?.get(document.uri)).toHaveLength(2);
  });

  it.each([
    [
      "expected text",
      () => response([edit(new vscode.Position(0, 0), new vscode.Position(0, 8), "SECRET")]),
    ],
    [
      "empty range",
      () => response([edit(new vscode.Position(0, 0), new vscode.Position(0, 0), "")]),
    ],
    [
      "overlap",
      () =>
        response([
          edit(new vscode.Position(0, 0), new vscode.Position(0, 8), "SELECT 1"),
          edit(new vscode.Position(0, 7), new vscode.Position(0, 9), "1\n"),
        ]),
    ],
    [
      "duplicate",
      () =>
        response([
          edit(new vscode.Position(0, 0), new vscode.Position(0, 8), "SELECT 1"),
          edit(new vscode.Position(0, 0), new vscode.Position(0, 8), "SELECT 1"),
        ]),
    ],
    [
      "out of bounds",
      () => response([edit(new vscode.Position(0, 0), new vscode.Position(0, 99), "SELECT")]),
    ],
  ] as const)("rejects %s without applying", async (_name, makeResponse) => {
    const setupResult = setup();
    const result = await setupResult.applicator.apply(
      setupResult.document,
      setupResult.snapshot,
      makeResponse(),
      setupResult.guard,
    );
    expect(result).toEqual({ ok: false, reason: "PROTOCOL_ERROR" });
    expect(setupResult.apply).not.toHaveBeenCalled();
  });

  it("maps stale snapshots and apply false without retry", async () => {
    const stale = setup();
    const staleResult = await stale.applicator.apply(
      stale.document,
      { ...stale.snapshot, version: stale.snapshot.version + 1 },
      response([]),
      stale.guard,
    );
    expect(staleResult).toEqual({ ok: false, reason: "DOCUMENT_CHANGED" });
    const failedApply = setup();
    failedApply.apply.mockResolvedValue(false);
    const result = await failedApply.applicator.apply(
      failedApply.document,
      failedApply.snapshot,
      response([
        edit(new vscode.Position(0, 0), new vscode.Position(0, 8), "SELECT 1", "SELECT 9"),
      ]),
      failedApply.guard,
    );
    expect(result).toEqual({ ok: false, reason: "APPLY_EDIT_FAILED" });
    expect(failedApply.apply).toHaveBeenCalledTimes(1);
  });

  it("checks cancellation and trust immediately before apply", async () => {
    const cancelled = setup();
    const source = new vscode.CancellationTokenSource();
    const cancelledResult = await cancelled.applicator.apply(
      cancelled.document,
      cancelled.snapshot,
      response([
        edit(new vscode.Position(0, 0), new vscode.Position(0, 8), "SELECT 1", "SELECT 9"),
      ]),
      { token: source.token, isWorkspaceTrusted: () => true },
    );
    expect(cancelledResult).toEqual({ ok: true, applied: 1 });
    source.cancel();
    const result = await cancelled.applicator.apply(
      cancelled.document,
      cancelled.snapshot,
      response([
        edit(new vscode.Position(0, 0), new vscode.Position(0, 8), "SELECT 1", "SELECT 9"),
      ]),
      { token: source.token, isWorkspaceTrusted: () => true },
    );
    expect(result).toEqual({ ok: false, reason: "PROCESS_CANCELLED" });
    expect(cancelled.apply).toHaveBeenCalledTimes(1);
  });
});
