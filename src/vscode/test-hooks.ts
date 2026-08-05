import * as vscode from "vscode";

import type { ReasonCode } from "../protocol.js";

export interface TestOperationOutcome {
  readonly changed: number;
  readonly skipped: number;
  readonly reason?: ReasonCode;
}

export interface IntegrationTestHooks {
  readonly afterHelperResponse: (cancelOperation: () => void) => Promise<void>;
  readonly isWorkspaceTrusted: (actualTrust: boolean) => boolean;
  readonly applyWorkspaceEdit: (edit: vscode.WorkspaceEdit) => Thenable<boolean>;
  readonly operationCompleted: (outcome: TestOperationOutcome) => void;
}

export interface TestHookConfiguration {
  readonly pauseBeforeApply?: boolean;
  readonly cancelAtBarrier?: boolean;
  readonly workspaceTrustOverride?: boolean;
  readonly forcedApplyResult?: boolean;
}

export interface HookSnapshot {
  readonly barrierReached: boolean;
  readonly lastOutcome: TestOperationOutcome | undefined;
}

export interface ReadHookOptions {
  readonly waitForBarrier?: boolean;
}

const TEST_COMMANDS = {
  configure: "inlineSql.test.configureHooks",
  release: "inlineSql.test.releaseBeforeApply",
  read: "inlineSql.test.readHooks",
} as const;

function productionHooks(): IntegrationTestHooks {
  return Object.freeze({
    afterHelperResponse: async () => {},
    isWorkspaceTrusted: (actualTrust: boolean) => actualTrust,
    applyWorkspaceEdit: (edit: vscode.WorkspaceEdit) => vscode.workspace.applyEdit(edit),
    operationCompleted: () => {},
  });
}

function readConfiguration(value: unknown): TestHookConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const result: {
    pauseBeforeApply?: boolean;
    cancelAtBarrier?: boolean;
    workspaceTrustOverride?: boolean;
    forcedApplyResult?: boolean;
  } = {};
  if (typeof record.pauseBeforeApply === "boolean")
    result.pauseBeforeApply = record.pauseBeforeApply;
  if (typeof record.cancelAtBarrier === "boolean") result.cancelAtBarrier = record.cancelAtBarrier;
  if (typeof record.workspaceTrustOverride === "boolean")
    result.workspaceTrustOverride = record.workspaceTrustOverride;
  if (typeof record.forcedApplyResult === "boolean")
    result.forcedApplyResult = record.forcedApplyResult;
  return result;
}

function createEnabledTestHooks(context: vscode.ExtensionContext): IntegrationTestHooks {
  let configuration: TestHookConfiguration = {};
  let barrierReached = false;
  let releaseBarrier: (() => void) | undefined;
  const barrierWaiters = new Set<() => void>();
  let lastOutcome: TestOperationOutcome | undefined;

  const hooks: IntegrationTestHooks = {
    async afterHelperResponse(cancelOperation) {
      if (configuration.pauseBeforeApply !== true) return;
      barrierReached = true;
      for (const resolve of barrierWaiters) resolve();
      barrierWaiters.clear();
      if (configuration.cancelAtBarrier === true) cancelOperation();
      await new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      barrierReached = false;
      releaseBarrier = undefined;
    },
    isWorkspaceTrusted(actualTrust) {
      return configuration.workspaceTrustOverride ?? actualTrust;
    },
    applyWorkspaceEdit(edit) {
      return configuration.forcedApplyResult === undefined
        ? vscode.workspace.applyEdit(edit)
        : Promise.resolve(configuration.forcedApplyResult);
    },
    operationCompleted(outcome) {
      lastOutcome = {
        changed: outcome.changed,
        skipped: outcome.skipped,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      };
    },
  };

  const readSnapshot = (): HookSnapshot => ({
    barrierReached,
    lastOutcome,
  });
  const dispose = (): void => {
    releaseBarrier?.();
    releaseBarrier = undefined;
    barrierReached = false;
    for (const resolve of barrierWaiters) resolve();
    barrierWaiters.clear();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(TEST_COMMANDS.configure, (value: unknown) => {
      configuration = readConfiguration(value);
      lastOutcome = undefined;
    }),
    vscode.commands.registerCommand(TEST_COMMANDS.release, () => {
      releaseBarrier?.();
    }),
    vscode.commands.registerCommand(
      TEST_COMMANDS.read,
      async (options?: ReadHookOptions): Promise<HookSnapshot> => {
        if (
          options?.waitForBarrier === true &&
          configuration.pauseBeforeApply === true &&
          !barrierReached
        ) {
          await new Promise<void>((resolve) => {
            barrierWaiters.add(resolve);
          });
        }
        return readSnapshot();
      },
    ),
    { dispose },
  );
  return hooks;
}

/**
 * Build the sole integration test seam. No test command is registered unless
 * VS Code explicitly created the extension host in ExtensionMode.Test.
 */
export function createTestHooks(context: vscode.ExtensionContext): IntegrationTestHooks {
  return context.extensionMode === vscode.ExtensionMode.Test
    ? createEnabledTestHooks(context)
    : productionHooks();
}

export const TEST_HOOK_COMMANDS = TEST_COMMANDS;
