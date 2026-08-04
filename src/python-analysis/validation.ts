import { REASON_CODES } from "../constants.js";
import type { FormatOptions } from "../protocol.js";
import { detectSql, type SqlDetection } from "./detection.js";
import { analyzeDocument, type DocumentAnalysis } from "./literals.js";
import { replaceOrdinals } from "./ordinals.js";
import { SourceSpan } from "./positions.js";
import { buildProtectionPlan, restoreProtected, UnsafeRestore } from "./protection.js";
import type { SupportedLiteral } from "./tokenizer.js";

export type ReasonCode = (typeof REASON_CODES)[number];

/** The deliberately small formatter surface used by the candidate gate. */
export interface SqlFormatter {
  (
    protectedSql: string,
    options: { readonly tripleQuoted: boolean; readonly options: FormatOptions },
  ): string;
}

/** A guarded replacement for one complete Python literal. */
export interface CandidateEdit {
  readonly sourceSpan: SourceSpan;
  readonly expectedText: string;
  readonly replacementText: string;
}

/** A candidate rejected by one stable safety reason. */
export interface CandidateSkip {
  readonly sourceSpan: SourceSpan;
  readonly reason: ReasonCode;
}

/** A valid candidate for which formatting produced no source change. */
export interface CandidateUnchanged {
  readonly sourceSpan: SourceSpan;
}

export type CandidateResult = CandidateEdit | CandidateUnchanged | CandidateSkip;

/** Debug sink for skipped candidates; defaults to no-op. */
export type DebugLogger = (message: string) => void;

/** Internal source-free failure carrying the public skip reason. */
class CandidateFailure extends Error {
  readonly reason: ReasonCode;
  readonly detail: string | undefined;

  constructor(reason: ReasonCode, detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}

/** Reassemble content with the exact source prefix and quote delimiter. */
function literalText(literal: SupportedLiteral, content: string): string {
  return `${literal.prefix}${literal.delimiter}${content}${literal.delimiter}`;
}

/** Keep triple-quoted frame boundaries on their own lines. */
/** Return the leading whitespace of the literal's source line. */
function baseIndentOf(analysis: DocumentAnalysis, literal: SupportedLiteral): string {
  const line = analysis.sourceMap.vscodeFromOffset(literal.span.start).line;
  const lineStart = analysis.sourceMap.lineStarts[line] ?? 0;
  return /^[ \t]*/.exec(analysis.sourceMap.text.slice(lineStart, literal.span.start))?.[0] ?? "";
}

/** Shift SQL body lines so they sit one level below the base indent. */
function applyBaseIndent(
  text: string,
  baseIndent: string,
  extraIndent: string,
  tripleQuoted: boolean,
): string {
  const lines = text.split("\n");
  const nonEmpty = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim() !== "");
  if (nonEmpty.length === 0) return text;
  const first = nonEmpty[0];
  if (first === undefined) return text;
  const firstTrimmed = first.line.trim();
  const isMarker = firstTrimmed.startsWith("--sql") || firstTrimmed.startsWith("-- sql");
  const keepsFirstLine = !tripleQuoted || isMarker;
  const shifted = keepsFirstLine ? nonEmpty.slice(1) : nonEmpty;
  const minIndent =
    shifted.length === 0
      ? 0
      : Math.min(...shifted.map(({ line }) => /^[ \t]*/.exec(line)?.[0].length ?? 0));
  return lines
    .map((line, index) => {
      if (line.trim() === "" || (keepsFirstLine && index === first.index)) return line;
      return `${baseIndent}${extraIndent}${line.slice(minIndent)}`;
    })
    .join("\n");
}

function normalizeFrame(
  content: string,
  literal: SupportedLiteral,
  analysis: DocumentAnalysis,
  baseIndent: string,
): string {
  if (literal.delimiter.length !== 3 || !content.includes("\n")) return content;
  const sourceContent = analysis.sourceMap.slice(literal.contentSpan);
  const firstNonEmptyLine = sourceContent.split("\n").find((line) => line.trim() !== "");
  const startsWithMarker =
    firstNonEmptyLine?.trim().startsWith("--sql") || firstNonEmptyLine?.trim().startsWith("-- sql");
  const lines = content.split("\n");
  const markerIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("--sql") || trimmed.startsWith("-- sql");
  });
  let normalized = content;
  if (startsWithMarker) {
    if (markerIndex > 0) {
      const markerLine = lines[markerIndex];
      normalized = [markerLine?.trim() ?? "", ...lines.slice(markerIndex + 1)].join("\n");
    }
  } else if (!normalized.startsWith("\n") && !normalized.startsWith("\r\n")) {
    normalized = `\n${normalized}`;
  }
  if (!normalized.endsWith("\n") && !normalized.endsWith("\r")) {
    normalized = `${normalized}\n`;
  }
  return `${normalized}${baseIndent}`;
}

/** Move a field marker that ends the formatted SQL onto its own line. */
function breakTrailingFieldMarkers(text: string): string {
  const markerPattern = /(__INLINE_SQL_[0-9a-f]{32}_[A-Z_]+_[0-9]+__)\s*$/;
  const match = markerPattern.exec(text);
  if (match === null || match[1] === undefined) return text;
  const markerStart = match.index;
  const lineStart = text.lastIndexOf("\n", markerStart - 1) + 1;
  const before = text.slice(lineStart, markerStart);
  if (before.trim() === "") return text;
  const indent = /^[ \t]*/.exec(before)?.[0] ?? "";
  return `${text.slice(0, lineStart)}${before.trimEnd()}\n${indent}${text.slice(markerStart)}`;
}

/** Move a leading comma after a line comment back before the comment. */
function moveCommasBeforeLineComments(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const next = lines[index + 1];
    const commentMatch = /^(.*?)(--[^\r\n]*)$/.exec(line);
    const commaMatch = next === undefined ? null : /^(\s*),\s*$/.exec(next);
    if (commentMatch !== null && commaMatch !== null) {
      const beforeComment = commentMatch[1] ?? "";
      const comment = commentMatch[2] ?? "";
      result.push(`${beforeComment.trimEnd()}, ${comment}`);
      index += 2;
      continue;
    }
    result.push(line);
    index += 1;
  }
  return result.join("\n");
}

/** Break a trailing DISTRIBUTE clause onto its own line. */
function breakTrailingDistributeLines(text: string): string {
  return text.replace(
    /^([ \t]*)(.*?)\s+(DISTRIBUTE\b.*)$/gim,
    (_, indent: string, before: string, rest: string) => `${indent}${before}\n${indent}${rest}`,
  );
}

/** Protect, format, restore, and wrap one literal exactly once. */
function formatOnce(
  analysis: DocumentAnalysis,
  literal: SupportedLiteral,
  detection: SqlDetection,
  options: FormatOptions,
  nonce: string,
  sqlFormatter: SqlFormatter,
): string {
  const plan = buildProtectionPlan(analysis.sourceMap, literal, detection, nonce);
  let formatted = sqlFormatter(plan.protectedSql, {
    tripleQuoted: literal.delimiter.length === 3,
    options,
  });
  for (const fragment of plan.fragments) {
    if (!fragment.marker.endsWith("\n")) continue;
    for (const lineEnding of ["\r\n", "\n", "\r"]) {
      formatted = formatted.replace(fragment.marker + lineEnding, fragment.marker);
    }
  }
  formatted = breakTrailingFieldMarkers(formatted);
  formatted = moveCommasBeforeLineComments(formatted);
  formatted = breakTrailingDistributeLines(formatted);
  const restored = restoreProtected(formatted, plan);
  const resolved = options.replaceOrdinals ? replaceOrdinals(restored) : restored;
  const baseIndent = baseIndentOf(analysis, literal);
  const indented = applyBaseIndent(
    resolved,
    baseIndent,
    " ".repeat(options.indentWidth),
    literal.delimiter.length === 3,
  );
  return literalText(literal, normalizeFrame(indented, literal, analysis, baseIndent));
}

/** Replace one half-open source span while preserving all surrounding text. */
function replaceSource(source: string, span: SourceSpan, replacement: string): string {
  return source.slice(0, span.start) + replacement + source.slice(span.end);
}

/** Find the reparsed literal and require its Python surface identity. */
function replacementLiteral(
  updated: DocumentAnalysis,
  original: SupportedLiteral,
): SupportedLiteral {
  const matches = updated.supported.filter((item) => item.span.start === original.span.start);
  if (matches.length !== 1) {
    throw new CandidateFailure("FORMATTER_FAILED", `reparse found ${matches.length} literals`);
  }
  const result = matches[0];
  if (result === undefined) throw new CandidateFailure("FORMATTER_FAILED", "reparse found none");
  if (
    result.prefix !== original.prefix ||
    result.delimiter !== original.delimiter ||
    result.kind !== original.kind
  ) {
    throw new CandidateFailure("UNSAFE_RAW_STRING");
  }
  return result;
}

/** Return source spellings of every replacement field. */
function fieldTexts(analysis: DocumentAnalysis, literal: SupportedLiteral): readonly string[] {
  return literal.fieldSpans.map((span) => analysis.sourceMap.slice(span));
}

/** Parse, reconcile, and format the candidate again with identical inputs. */
function validateReplacementAndIdempotency(
  source: string,
  analysis: DocumentAnalysis,
  literal: SupportedLiteral,
  options: FormatOptions,
  nonce: string,
  sqlFormatter: SqlFormatter,
  first: string,
): void {
  try {
    const reparsed = analyzeDocument(first);
    if (reparsed.supported.length !== 1 || reparsed.unsupported.length !== 0) {
      throw new CandidateFailure("UNSAFE_RAW_STRING");
    }
  } catch (error) {
    if (error instanceof CandidateFailure) throw error;
    throw new CandidateFailure("UNSAFE_RAW_STRING");
  }

  const updatedSource = replaceSource(source, literal.span, first);
  let updatedAnalysis: DocumentAnalysis;
  try {
    updatedAnalysis = analyzeDocument(updatedSource);
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new CandidateFailure("FORMATTER_FAILED", `reparse threw: ${message}`);
  }

  const updatedLiteral = replacementLiteral(updatedAnalysis, literal);
  const before = fieldTexts(analysis, literal).join("\u0000");
  const after = fieldTexts(updatedAnalysis, updatedLiteral).join("\u0000");
  if (before !== after) {
    throw new CandidateFailure(
      "UNSAFE_FSTRING_RESTORE",
      `field texts changed: before=[${before.split("\u0000").join(", ")}] after=[${after
        .split("\u0000")
        .join(", ")}]`,
    );
  }

  const updatedDetection = detectSql(updatedLiteral, updatedAnalysis.sourceMap);
  if (!updatedDetection.matched) {
    throw new CandidateFailure("FORMATTER_FAILED", "updated candidate no longer matches --sql");
  }
  const second = formatOnce(
    updatedAnalysis,
    updatedLiteral,
    updatedDetection,
    options,
    nonce,
    sqlFormatter,
  );
  if (second !== first) {
    const clip = (text: string): string => (text.length > 160 ? `${text.slice(0, 160)}...` : text);
    throw new CandidateFailure(
      "FORMATTER_FAILED",
      `not idempotent:\nfirst=${clip(first)}\nsecond=${clip(second)}`,
    );
  }
}

/** Return a changed, unchanged, or safely skipped candidate state. */
export function formatCandidate(
  source: string,
  analysis: DocumentAnalysis,
  literal: SupportedLiteral,
  detection: SqlDetection,
  options: FormatOptions,
  nonce: string,
  sqlFormatter: SqlFormatter,
  logger?: DebugLogger,
): CandidateResult {
  const preview = (text: string): string => (text.length > 200 ? `${text.slice(0, 200)}...` : text);
  if (analysis.sourceMap.text !== source) {
    logger?.("candidate skipped (FORMATTER_FAILED): stale source snapshot");
    return { sourceSpan: literal.span, reason: "FORMATTER_FAILED" };
  }
  const expected = analysis.sourceMap.slice(literal.span);
  if (!detection.matched) {
    return { sourceSpan: literal.span, reason: "NO_SQL_CANDIDATE" };
  }
  let first: string;
  try {
    first = formatOnce(analysis, literal, detection, options, nonce, sqlFormatter);
    validateReplacementAndIdempotency(
      source,
      analysis,
      literal,
      options,
      nonce,
      sqlFormatter,
      first,
    );
  } catch (error) {
    if (error instanceof CandidateFailure) {
      logger?.(
        `candidate skipped (${error.reason}): ${error.detail ?? "no detail"}\n` +
          `  literal: ${preview(expected)}`,
      );
      return { sourceSpan: literal.span, reason: error.reason };
    }
    if (error instanceof UnsafeRestore) {
      logger?.(
        `candidate skipped (UNSAFE_FSTRING_RESTORE): ${error.message}\n` +
          `  literal: ${preview(expected)}`,
      );
      return { sourceSpan: literal.span, reason: "UNSAFE_FSTRING_RESTORE" };
    }
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    logger?.(`candidate skipped (FORMATTER_FAILED): ${message}\n  literal: ${preview(expected)}`);
    return { sourceSpan: literal.span, reason: "FORMATTER_FAILED" };
  }
  if (first === expected) return { sourceSpan: literal.span };
  return { sourceSpan: literal.span, expectedText: expected, replacementText: first };
}
