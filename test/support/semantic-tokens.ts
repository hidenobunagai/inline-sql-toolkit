import * as vscode from "vscode";

import { strictPosition } from "../../src/vscode/edit-applicator.js";

/**
 * Decode VS Code's five-integer semantic-token delta stream into half-open
 * ranges.  Keeping this helper independent from an Extension Host makes the
 * overlap policy unit-testable and prevents a provider returning malformed
 * data from making the integration check pass vacuously.
 */
export function decodeSemanticTokens(
  document: vscode.TextDocument,
  tokens: vscode.SemanticTokens,
): readonly vscode.Range[] {
  if (tokens.data.length === 0 || tokens.data.length % 5 !== 0) {
    throw new Error("semantic provider returned no complete token");
  }

  const ranges: vscode.Range[] = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index < tokens.data.length; index += 5) {
    const deltaLine = tokens.data[index];
    const deltaStart = tokens.data[index + 1];
    const length = tokens.data[index + 2];
    if (deltaLine === undefined || deltaStart === undefined || length === undefined) {
      throw new Error("semantic provider returned a truncated token");
    }
    if (length === 0) throw new Error("semantic provider returned an empty token");

    const nextLine = line + deltaLine;
    if (!Number.isSafeInteger(nextLine)) {
      throw new Error("semantic provider returned an overflowing line delta");
    }
    const nextCharacter = deltaLine === 0 ? character + deltaStart : deltaStart;
    if (!Number.isSafeInteger(nextCharacter)) {
      throw new Error("semantic provider returned an overflowing character delta");
    }
    const endCharacter = nextCharacter + length;
    if (!Number.isSafeInteger(endCharacter)) {
      throw new Error("semantic provider returned an overflowing token length");
    }
    line = nextLine;
    character = nextCharacter;

    const start = strictPosition(document, { line, character });
    const end = strictPosition(document, {
      line,
      character: endCharacter,
    });
    if (start === undefined || end === undefined || start.isAfterOrEqual(end)) {
      throw new Error("semantic provider returned an invalid token");
    }
    ranges.push(new vscode.Range(start, end));
  }
  return ranges;
}

/** Assert strict (not merely inclusive) range overlap. */
export function assertNoSemanticSqlOverlap(
  semanticRanges: readonly vscode.Range[],
  sqlRanges: readonly vscode.Range[],
): void {
  for (const semantic of semanticRanges) {
    for (const sql of sqlRanges) {
      if (semantic.start.isBefore(sql.end) && sql.start.isBefore(semantic.end)) {
        throw new Error("semantic token overrides inline SQL");
      }
    }
  }
}
