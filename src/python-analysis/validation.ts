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
/** Return the leading whitespace of the first content line as the base indent. */
function baseIndentOf(analysis: DocumentAnalysis, literal: SupportedLiteral): string {
  const content = analysis.sourceMap.slice(literal.contentSpan);
  const firstLine = content.split("\n").find((line) => line.trim() !== "");
  return /^[ \t]*/.exec(firstLine ?? "")?.[0] ?? "";
}

/** Apply a shared base indent plus one extra level to SQL lines. */
function applyBaseIndent(text: string, baseIndent: string, extraIndent: string): string {
  if (baseIndent === "") return text;
  const lines = text.split("\n");
  let seenContent = false;
  return lines
    .map((line) => {
      if (line === "") return line;
      const indent = seenContent ? `${baseIndent}${extraIndent}` : baseIndent;
      seenContent = true;
      const stripped = line.startsWith(indent) ? line.slice(indent.length) : line;
      return `${indent}${stripped}`;
    })
    .join("\n");
}

function normalizeFrame(content: string, literal: SupportedLiteral): string {
  if (literal.delimiter.length !== 3 || !content.includes("\n")) return content;
  let normalized = content;
  if (!normalized.startsWith("\n") && !normalized.startsWith("\r\n")) {
    normalized = `\n${normalized}`;
  }
  if (!normalized.endsWith("\n") && !normalized.endsWith("\r")) {
    normalized = `${normalized}\n`;
  }
  return normalized;
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
  const indented = applyBaseIndent(
    restored,
    baseIndentOf(analysis, literal),
    " ".repeat(options.indentWidth),
  );
  return literalText(literal, normalizeFrame(indented, literal));
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
