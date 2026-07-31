import * as vscode from "vscode";

import type { FormatOptions } from "../protocol.js";

export type FormatOptionsResult =
  | { readonly ok: true; readonly options: FormatOptions }
  | { readonly ok: false; readonly reason: "INVALID_CONFIGURATION" };

export type PythonPathResult =
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly reason: "INVALID_CONFIGURATION" | "WORKSPACE_UNTRUSTED" };

function integerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

export function readFormatOptions(resourceUri: vscode.Uri): FormatOptionsResult {
  const configuration = vscode.workspace.getConfiguration("inlineSql", resourceUri);
  const keywordCaseValue = configuration.get<unknown>("format.keywordCase");
  const indentWidthValue = configuration.get<unknown>("format.indentWidth");
  const wrapAfterValue = configuration.get<unknown>("format.wrapAfter");
  const operatorSpacingValue = configuration.get<unknown>("format.useSpaceAroundOperators");
  const expandSelectListValue = configuration.get<unknown>("format.expandSelectList");
  const keywordCase = keywordCaseValue === undefined ? "upper" : keywordCaseValue;
  const indentWidth = indentWidthValue === undefined ? 2 : indentWidthValue;
  const wrapAfter = wrapAfterValue === undefined ? 88 : wrapAfterValue;
  const useSpaceAroundOperators = operatorSpacingValue === undefined ? true : operatorSpacingValue;
  const expandSelectList = expandSelectListValue === undefined ? true : expandSelectListValue;
  if (
    (keywordCase !== "upper" && keywordCase !== "lower" && keywordCase !== "preserve") ||
    !integerBetween(indentWidth, 1, 8) ||
    !integerBetween(wrapAfter, 20, 500) ||
    typeof useSpaceAroundOperators !== "boolean" ||
    typeof expandSelectList !== "boolean"
  )
    return { ok: false, reason: "INVALID_CONFIGURATION" };
  return {
    ok: true,
    options: { keywordCase, indentWidth, wrapAfter, useSpaceAroundOperators, expandSelectList },
  };
}

export function readConfiguredPythonPath(resourceUri: vscode.Uri): PythonPathResult {
  if (!vscode.workspace.isTrusted) return { ok: false, reason: "WORKSPACE_UNTRUSTED" };
  const value = vscode.workspace
    .getConfiguration("inlineSql", resourceUri)
    .get<unknown>("pythonPath");
  if (value === undefined || value === "") return { ok: true, value: undefined };
  return typeof value === "string"
    ? { ok: true, value }
    : { ok: false, reason: "INVALID_CONFIGURATION" };
}
