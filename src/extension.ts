import * as vscode from "vscode";

import { InlineSqlCodeActionProvider, LocateCache } from "./vscode/code-actions.js";
import { registerCommandsAndGetDisposables } from "./vscode/commands.js";
import { INLINE_SQL_SELECTOR } from "./vscode/document-target.js";
import { createEditApplicator } from "./vscode/edit-applicator.js";
import { createFormatController } from "./vscode/format-controller.js";
import { createTestHooks } from "./vscode/test-hooks.js";

interface ActiveExtensionState {
  readonly disposables: readonly vscode.Disposable[];
  dispose(): void;
}

let activeState: ActiveExtensionState | undefined;

function disposeActiveState(): void {
  const state = activeState;
  activeState = undefined;
  state?.dispose();
}

function createState(context: vscode.ExtensionContext): ActiveExtensionState {
  const owned: vscode.Disposable[] = [];
  const own = <T extends vscode.Disposable>(disposable: T): T => {
    owned.push(disposable);
    return disposable;
  };

  // Test hooks register their own unmanifested commands only in ExtensionMode.Test.
  // Capture those subscriptions as module-owned state so a second test activation
  // cannot leave stale commands behind.
  const hookSubscriptionStart = context.subscriptions.length;
  const hooks = createTestHooks(context);
  for (const subscription of context.subscriptions.slice(hookSubscriptionStart)) own(subscription);

  const applicator = createEditApplicator({
    applyWorkspaceEdit: hooks.applyWorkspaceEdit,
  });
  const controller = createFormatController({ applicator, hooks });
  const cache = new LocateCache();
  const provider = new InlineSqlCodeActionProvider(
    {
      isWorkspaceTrusted: () => hooks.isWorkspaceTrusted(vscode.workspace.isTrusted),
    },
    cache,
  );

  for (const disposable of registerCommandsAndGetDisposables(context, controller)) own(disposable);

  const registrationState: { provider: vscode.Disposable | undefined } = {
    provider: undefined,
  };
  const registerCodeActionsOnce = (): void => {
    if (registrationState.provider !== undefined) return;
    const registration = vscode.languages.registerCodeActionsProvider(
      INLINE_SQL_SELECTOR,
      provider,
      {
        providedCodeActionKinds: InlineSqlCodeActionProvider.providedCodeActionKinds,
      },
    );
    registrationState.provider = own(registration);
    context.subscriptions.push(registration);
  };

  let trustGrant: vscode.Disposable | undefined;
  if (vscode.workspace.isTrusted) {
    registerCodeActionsOnce();
  } else {
    trustGrant = own(
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        cache.clear();
        registerCodeActionsOnce();
        trustGrant?.dispose();
        trustGrant = undefined;
      }),
    );
    context.subscriptions.push(trustGrant);
  }

  const changeSubscription = own(
    vscode.workspace.onDidChangeTextDocument((event) => {
      cache.deleteUri(event.document.uri);
    }),
  );
  const closeSubscription = own(
    vscode.workspace.onDidCloseTextDocument((document) => {
      cache.deleteUri(document.uri);
    }),
  );
  context.subscriptions.push(changeSubscription, closeSubscription);

  return {
    disposables: owned,
    dispose(): void {
      for (const disposable of owned.splice(0)) disposable.dispose();
    },
  };
}

export function activate(context: vscode.ExtensionContext): void {
  disposeActiveState();
  activeState = createState(context);
}

export function deactivate(): void {
  disposeActiveState();
}
