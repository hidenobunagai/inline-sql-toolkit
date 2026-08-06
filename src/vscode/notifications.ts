import * as vscode from "vscode";

import type { FormatSummary, ReasonCode } from "../protocol.js";

export type TargetReasonCode =
  "NO_ACTIVE_EDITOR" | "NOTEBOOK_CELL_FOCUS_REQUIRED" | "UNSUPPORTED_DOCUMENT";

export interface NotificationSink {
  readonly reason: (code: ReasonCode) => void;
  readonly target: (code: TargetReasonCode) => void;
  readonly emptySelection: () => void;
  readonly summary: (summary: FormatSummary, skipped: number, reasons?: readonly string[]) => void;
}

function translate(message: string): string {
  // The production extension host always provides vscode.l10n. The fallback keeps
  // this module usable in the deliberately small unit-test host as well.
  try {
    const l10n = (vscode as unknown as { readonly l10n?: { t: (value: string) => string } }).l10n;
    return l10n === undefined ? message : l10n.t(message);
  } catch {
    return message;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled notification code: ${String(value)}`);
}

export function reasonMessage(code: ReasonCode): string {
  switch (code) {
    case "WORKSPACE_UNTRUSTED":
      return translate("Inline SQL formatting requires a trusted workspace.");
    case "INVALID_CONFIGURATION":
      return translate("An Inline SQL setting has an invalid value.");
    case "NO_SQL_CANDIDATE":
      return translate("No inline SQL candidate was found.");
    case "UNSUPPORTED_LITERAL":
      return translate("The selected SQL uses an unsupported Python literal shape.");
    case "UNSAFE_FSTRING_RESTORE":
      return translate("Formatting was skipped because an f-string could not be restored safely.");
    case "UNSAFE_RAW_STRING":
      return translate(
        "Formatting was skipped because a raw string could not be preserved safely.",
      );
    case "FORMATTER_FAILED":
      return translate("The SQL formatter could not format the selected candidate.");
    case "RESOURCE_LIMIT_EXCEEDED":
      return translate("The document or formatting result exceeded a safety limit.");
    case "PROCESS_CANCELLED":
      return translate("Inline SQL formatting was cancelled.");
    case "PROCESS_FAILED":
      return translate("Inline SQL formatting failed.");
    case "DOCUMENT_CHANGED":
      return translate("The document changed before formatting could be applied.");
    case "APPLY_EDIT_FAILED":
      return translate("VS Code could not apply the Inline SQL edit.");
    case "PROTOCOL_ERROR":
      return translate("Inline SQL formatting produced an invalid response.");
    default:
      return assertNever(code);
  }
}

export function targetMessage(code: TargetReasonCode): string {
  switch (code) {
    case "NO_ACTIVE_EDITOR":
      return translate("Open a supported Python document to format inline SQL.");
    case "NOTEBOOK_CELL_FOCUS_REQUIRED":
      return translate("Focus a supported notebook cell to format inline SQL.");
    case "UNSUPPORTED_DOCUMENT":
      return translate("Inline SQL formatting is not supported for this document.");
    default:
      return assertNever(code);
  }
}

export function emptySelectionMessage(): string {
  return translate("Select a non-empty range to format inline SQL.");
}

function plural(value: number, singular: string, pluralForm: string): string {
  return `${value} ${value === 1 ? singular : pluralForm}`;
}

/** Build a fixed summary using only numeric result fields. */
export function summaryMessage(
  summary: FormatSummary,
  skipped = summary.skipped,
  reasons: readonly string[] = [],
): string {
  const changed = summary.changed;
  if (changed === 0 && skipped === 0) {
    return translate("Inline SQL is already formatted.");
  }
  if (changed === 0) {
    const detail = reasons.length > 0 ? ` (${[...new Set(reasons)].join(", ")})` : "";
    return translate(
      `No changes applied; skipped ${plural(skipped, "candidate", "candidates")}${detail}.`,
    );
  }
  if (skipped === 0) {
    return translate(`Formatted ${plural(changed, "candidate", "candidates")}.`);
  }
  return translate(
    `Formatted ${plural(changed, "candidate", "candidates")}; skipped ${plural(skipped, "candidate", "candidates")}.`,
  );
}

export function createNotifications(
  output: Pick<
    typeof vscode.window,
    "showInformationMessage" | "showWarningMessage"
  > = vscode.window,
): NotificationSink {
  const showInformation = (message: string): void => {
    try {
      output.showInformationMessage(message);
    } catch {
      // A headless/unit Extension Host may not expose the notification UI.
    }
  };
  const showWarning = (message: string): void => {
    try {
      output.showWarningMessage(message);
    } catch {
      // A headless/unit Extension Host may not expose the notification UI.
    }
  };
  return {
    reason(code) {
      showWarning(reasonMessage(code));
    },
    target(code) {
      showInformation(targetMessage(code));
    },
    emptySelection() {
      showInformation(emptySelectionMessage());
    },
    summary(summary, skipped, reasons) {
      showInformation(summaryMessage(summary, skipped, reasons));
    },
  };
}
