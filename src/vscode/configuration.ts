import * as vscode from "vscode";

import { type FormatOptionsResult, resolveFormatOptions } from "../format-options.js";

export type { FormatOptionsResult };

export function readFormatOptions(resourceUri: vscode.Uri): FormatOptionsResult {
  const configuration = vscode.workspace.getConfiguration("inlineSql", resourceUri);
  const keywordCase = configuration.get<unknown>("format.keywordCase");
  const indentWidth = configuration.get<unknown>("format.indentWidth");
  const wrapAfter = configuration.get<unknown>("format.wrapAfter");
  const useSpaceAroundOperators = configuration.get<unknown>("format.useSpaceAroundOperators");
  const replaceOrdinals = configuration.get<unknown>("format.replaceOrdinals");
  const dialect = configuration.get<unknown>("format.dialect");
  const commaPosition = configuration.get<unknown>("format.commaPosition");
  const keepFunctionsInline = configuration.get<unknown>("format.keepFunctionsInline");
  return resolveFormatOptions({
    keywordCase,
    indentWidth,
    wrapAfter,
    useSpaceAroundOperators,
    replaceOrdinals,
    dialect,
    commaPosition,
    keepFunctionsInline,
  });
}
