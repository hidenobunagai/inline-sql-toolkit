import { REASON_CODES } from "../constants.js";
import type { FormatOptions } from "../protocol.js";
import { detectSql, type SqlDetection } from "./detection.js";
import { analyzeDocument, type DocumentAnalysis } from "./literals.js";
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

/** Internal source-free failure carrying the public skip reason. */
class CandidateFailure extends Error {
  readonly reason: ReasonCode;

  constructor(reason: ReasonCode) {
    super(reason);
    this.reason = reason;
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
  const restored = restoreProtected(formatted, plan);
  const baseIndent = baseIndentOf(analysis, literal);
  const indented = applyBaseIndent(
    restored,
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
  if (matches.length !== 1) throw new CandidateFailure("FORMATTER_FAILED");
  const result = matches[0];
  if (result === undefined) throw new CandidateFailure("FORMATTER_FAILED");
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
  } catch {
    throw new CandidateFailure("FORMATTER_FAILED");
  }

  const updatedLiteral = replacementLiteral(updatedAnalysis, literal);
  if (
    fieldTexts(analysis, literal).join("\u0000") !==
    fieldTexts(updatedAnalysis, updatedLiteral).join("\u0000")
  ) {
    throw new CandidateFailure("UNSAFE_FSTRING_RESTORE");
  }

  const updatedDetection = detectSql(updatedLiteral, updatedAnalysis.sourceMap);
  if (!updatedDetection.matched) throw new CandidateFailure("FORMATTER_FAILED");
  const second = formatOnce(
    updatedAnalysis,
    updatedLiteral,
    updatedDetection,
    options,
    nonce,
    sqlFormatter,
  );
  if (second !== first) throw new CandidateFailure("FORMATTER_FAILED");
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
): CandidateResult {
  if (analysis.sourceMap.text !== source) {
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
      return { sourceSpan: literal.span, reason: error.reason };
    }
    if (error instanceof UnsafeRestore) {
      return { sourceSpan: literal.span, reason: "UNSAFE_FSTRING_RESTORE" };
    }
    return { sourceSpan: literal.span, reason: "FORMATTER_FAILED" };
  }
  if (first === expected) return { sourceSpan: literal.span };
  return { sourceSpan: literal.span, expectedText: expected, replacementText: first };
}
