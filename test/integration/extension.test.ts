import { strict as assert } from "node:assert";

import * as vscode from "vscode";

import { type HookSnapshot, TEST_HOOK_COMMANDS } from "../../src/vscode/test-hooks.js";
import {
  assertAllCommandAndSingleUndo,
  assertFormattingCodeAction,
  assertFstringAndPartialSuccess,
  assertNoDocumentFormattingProvider,
  assertSingleCommandAndUndo,
  configureIntegrationPython,
  openStandaloneFixture,
  preserveFinalNewline,
  replaceWholeDocument,
  runPausedRace,
  selectNeedle,
  waitForBarrier,
  withTimeout,
} from "../support/vscode-harness.js";

export async function testStandaloneFormatting(): Promise<void> {
  for (const language of ["python", "mo-python"] as const) {
    const document = await openStandaloneFixture(language);
    const editor = await vscode.window.showTextDocument(document);
    await configureIntegrationPython(document);
    await assertSingleCommandAndUndo(document, editor, "inlineSql.formatAtCursor");
    await assertSingleCommandAndUndo(document, editor, "inlineSql.formatSelection");
    await assertAllCommandAndSingleUndo(document, editor);
    await assertFstringAndPartialSuccess(document, editor);
    await assertFormattingCodeAction(document, editor);
    await assertNoDocumentFormattingProvider(document);
  }
}

export async function testApplyRaces(): Promise<void> {
  const document = await openStandaloneFixture("python");
  await vscode.window.showTextDocument(document);
  await configureIntegrationPython(document);
  try {
    const changed = preserveFinalNewline(document, 'query = "changed"');
    const changedVersion = await runPausedRace(document, {}, async () => {
      await replaceWholeDocument(document, changed);
    });
    assert.equal(document.getText(), changed);
    assert.equal(document.version, changedVersion);

    const cancelledVersion = await runPausedRace(
      document,
      { cancelAtBarrier: true },
      async () => {},
    );
    assert.equal(document.getText(), preserveFinalNewline(document, 'query = "select 1"'));
    assert.equal(document.version, cancelledVersion);

    const untrustedVersion = await runPausedRace(document, {}, async () => {
      await vscode.commands.executeCommand(TEST_HOOK_COMMANDS.configure, {
        workspaceTrustOverride: false,
      });
    });
    assert.equal(document.getText(), preserveFinalNewline(document, 'query = "select 1"'));
    assert.equal(document.version, untrustedVersion);

    await replaceWholeDocument(document, preserveFinalNewline(document, 'query = "select 1"'));
    await vscode.commands.executeCommand(TEST_HOOK_COMMANDS.configure, {
      forcedApplyResult: false,
    });
    const applyFalseVersion = document.version;
    await vscode.commands.executeCommand("inlineSql.formatAll");
    assert.equal(document.getText(), preserveFinalNewline(document, 'query = "select 1"'));
    assert.equal(document.version, applyFalseVersion);
  } finally {
    await vscode.commands.executeCommand(TEST_HOOK_COMMANDS.configure, {});
    await vscode.commands.executeCommand(TEST_HOOK_COMMANDS.release);
  }
}

export async function testDialectFormatting(): Promise<void> {
  const config = vscode.workspace.getConfiguration("inlineSql");
  const original = config.get("format.dialect");
  try {
    const document = await openStandaloneFixture("python");
    await vscode.window.showTextDocument(document);
    await configureIntegrationPython(document);

    await config.update("format.dialect", "postgresql", vscode.ConfigurationTarget.Workspace);
    await replaceWholeDocument(
      document,
      preserveFinalNewline(document, 'query = "select id::text from users"'),
    );
    await vscode.commands.executeCommand("inlineSql.formatAll");
    assert.equal(
      document.getText(),
      preserveFinalNewline(document, 'query = "SELECT id::text FROM users"'),
    );

    await config.update("format.dialect", "sqlite", vscode.ConfigurationTarget.Workspace);
    await replaceWholeDocument(
      document,
      preserveFinalNewline(document, 'query = "select id::text from users"'),
    );
    await vscode.commands.executeCommand("inlineSql.formatAll");
    assert.equal(
      document.getText(),
      preserveFinalNewline(document, 'query = "select id::text from users"'),
    );
  } finally {
    await config.update("format.dialect", original, vscode.ConfigurationTarget.Workspace);
  }
}

export function assertHookSnapshot(value: HookSnapshot | undefined): asserts value is HookSnapshot {
  if (value === undefined) throw new Error("missing integration hook snapshot");
}

void assertHookSnapshot;
void selectNeedle;
void waitForBarrier;
void withTimeout;
