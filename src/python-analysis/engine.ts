import type { FormatOptions, FormatTarget } from "../protocol.js";
import { detectSql, type SqlDetection } from "./detection.js";
import { analyzeDocument, type DocumentAnalysis } from "./literals.js";
import { PositionMappingError, SourceMap, SourceSpan } from "./positions.js";
import { allocateNonce } from "./protection.js";
import type { SupportedLiteral, UnsupportedLiteral } from "./tokenizer.js";
import {
  type CandidateEdit,
  formatCandidate,
  type ReasonCode,
  type SqlFormatter,
} from "./validation.js";

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_CANDIDATE_BYTES = 1024 * 1024;
export const MAX_CANDIDATES = 1_000;

/** One literal syntax unit whose source content looks like SQL. */
export interface DetectedUnit {
  readonly literal: SupportedLiteral | UnsupportedLiteral;
  readonly detection: SqlDetection;
}

/** The result of formatting one document with the TS engine. */
export interface EngineResult {
  readonly sourceMap: SourceMap;
  readonly edits: readonly CandidateEdit[];
  readonly skipped: number;
  readonly skipReasons: readonly ReasonCode[];
  readonly summary: {
    readonly discovered: number;
    readonly selected: number;
    readonly changed: number;
    readonly unchanged: number;
    readonly skipped: number;
  };
}

/** Discover SQL-looking literals in source order. */
export function discover(analysis: DocumentAnalysis): readonly DetectedUnit[] {
  const literals: readonly (SupportedLiteral | UnsupportedLiteral)[] = [
    ...analysis.supported,
    ...analysis.unsupported,
  ];
  const units = literals
    .map((literal) => ({
      literal,
      detection: detectSql(literal, analysis.sourceMap),
    }))
    .filter((unit) => unit.detection.matched);
  return [...units].sort((left, right) => left.literal.span.start - right.literal.span.start);
}

/** Select units intersecting the requested helper target. */
export function selectUnits(
  units: readonly DetectedUnit[],
  target: FormatTarget,
  sourceMap: SourceMap,
): readonly DetectedUnit[] {
  if (target.mode === "all") return units;
  if (target.mode === "cursor") {
    if (target.cursor === undefined) {
      throw new PositionMappingError("cursor payload is absent");
    }
    const cursor = sourceMap.offsetFromVscode(target.cursor.line, target.cursor.character);
    return units.filter(
      (unit) => unit.literal.span.start <= cursor && cursor < unit.literal.span.end,
    );
  }
  if (target.selection === undefined) {
    throw new PositionMappingError("selection payload is absent");
  }
  const start = sourceMap.offsetFromVscode(
    target.selection.start.line,
    target.selection.start.character,
  );
  const end = sourceMap.offsetFromVscode(target.selection.end.line, target.selection.end.character);
  if (end <= start) throw new PositionMappingError("selection is empty or reversed");
  return units.filter((unit) => unit.literal.span.start < end && start < unit.literal.span.end);
}

/** Combine candidate edits and reject overlapping spans. */
export function combinedSource(source: string, edits: readonly CandidateEdit[]): string {
  let result = source;
  let previousStart = source.length + 1;
  for (const edit of [...edits].sort((a, b) => a.sourceSpan.start - b.sourceSpan.start).reverse()) {
    if (edit.sourceSpan.end > previousStart) {
      throw new Error("candidate edits overlap");
    }
    result =
      result.slice(0, edit.sourceSpan.start) +
      edit.replacementText +
      result.slice(edit.sourceSpan.end);
    previousStart = edit.sourceSpan.start;
  }
  return result;
}

/** Format every selected SQL literal behind the shared safety checks. */
export function formatDocument(
  source: string,
  options: FormatOptions,
  target: FormatTarget,
  nonce: string,
  sqlFormatter: SqlFormatter,
): EngineResult {
  if (Buffer.byteLength(source, "utf8") > MAX_DOCUMENT_BYTES) {
    throw new PositionMappingError("document exceeds the size limit");
  }
  const analysis = analyzeDocument(source);
  const units = discover(analysis);
  if (units.length > MAX_CANDIDATES) {
    throw new PositionMappingError("candidate count exceeds the limit");
  }
  const selected = selectUnits(units, target, analysis.sourceMap);
  const edits: CandidateEdit[] = [];
  const skipReasons: ReasonCode[] = [];
  let changed = 0;
  let unchanged = 0;
  for (const unit of selected) {
    if (!("contentSpan" in unit.literal)) {
      skipReasons.push("UNSUPPORTED_LITERAL");
      continue;
    }
    if (unit.literal.contentSpan.end - unit.literal.contentSpan.start > MAX_CANDIDATE_BYTES) {
      skipReasons.push("RESOURCE_LIMIT_EXCEEDED");
      continue;
    }
    const result = formatCandidate(
      source,
      analysis,
      unit.literal,
      unit.detection,
      options,
      nonce,
      sqlFormatter,
    );
    if ("reason" in result) {
      skipReasons.push(result.reason);
    } else if ("replacementText" in result) {
      edits.push(result);
      changed++;
    } else {
      unchanged++;
    }
  }
  const combined = combinedSource(source, edits);
  analyzeDocument(combined);
  return {
    sourceMap: analysis.sourceMap,
    edits,
    skipped: skipReasons.length,
    skipReasons,
    summary: {
      discovered: units.length,
      selected: selected.length,
      changed,
      unchanged,
      skipped: skipReasons.length,
    },
  };
}

export { allocateNonce };
export type { SourceSpan, SupportedLiteral };
