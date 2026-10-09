import { REASON_CODES } from "../constants.js";
import type { FormatOptions } from "../protocol.js";
import { detectSql, isSqlMarker, type SqlDetection } from "./detection.js";
import { analyzeDocument, type DocumentAnalysis } from "./literals.js";
import { replaceOrdinals } from "./ordinals.js";
import { SourceSpan } from "./positions.js";
import { buildProtectionPlan, restoreProtected, UnsafeRestore } from "./protection.js";
import { lexSql, sqlTokenDifference } from "./sql-lexer.js";
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
  const isMarker = isSqlMarker(firstTrimmed);
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
  const startsWithMarker = firstNonEmptyLine !== undefined && isSqlMarker(firstNonEmptyLine);
  const lines = content.split("\n");
  const markerIndex = lines.findIndex(isSqlMarker);
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

/**
 * Move a field marker that ends the formatted SQL onto its own line. A marker
 * inside a trailing comment stays put: on the next line it would become code.
 */
function breakTrailingFieldMarkers(text: string, dialect: FormatOptions["dialect"]): string {
  const markerPattern = /(__INLINE_SQL_[0-9a-f]{32}_[A-Z_]+_[0-9]+__)\s*$/;
  const match = markerPattern.exec(text);
  if (match === null || match[1] === undefined) return text;
  const markerStart = match.index;
  const token = lexSql(text, dialect).find(
    (candidate) => candidate.start <= markerStart && markerStart < candidate.end,
  );
  if (token?.kind !== "word") return text;
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

/**
 * Break a trailing `DISTRIBUTE <word>` clause onto its own line. Only a code
 * DISTRIBUTE that follows other code on its line moves; one inside a string,
 * quoted identifier, or comment is text and is never split.
 */
function breakTrailingDistributeLines(text: string, dialect: FormatOptions["dialect"]): string {
  const tokens = lexSql(text, dialect);
  const splits: number[] = [];
  tokens.forEach((token, index) => {
    if (token.kind !== "word" || token.text.toLowerCase() !== "distribute") return;
    const gap = tokens[index + 1];
    const clause = tokens[index + 2];
    if (gap?.kind !== "space" || /[\r\n]/.test(gap.text) || clause?.kind !== "word") return;
    const lineStart = text.lastIndexOf("\n", token.start - 1) + 1;
    if (text.slice(lineStart, token.start).trim() !== "") splits.push(token.start);
  });
  let result = text;
  for (const start of splits.reverse()) {
    const lineStart = result.lastIndexOf("\n", start - 1) + 1;
    const indent = /^[ \t]*/.exec(result.slice(lineStart))?.[0] ?? "";
    result = `${result.slice(0, start).trimEnd()}\n${indent}${result.slice(start)}`;
  }
  return result;
}

/** Offset of the separator comma allowed to wrap on this line, else -1. */
function wrappingComma(line: string): number {
  let comma = -1;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === "'" || char === '"' || char === "`") {
      for (index += 1; index < line.length && line[index] !== char; index++) {
        if (line[index] === "\\") index += 1;
      }
      continue;
    }
    // A comma inside a trailing line comment is text, not a separator.
    if (char === "-" && line[index + 1] === "-") break;
    if (char === ",") comma = index;
  }
  if (comma < 0) return -1;
  // Only a comma that ends the line, or heads a trailing comment, may wrap.
  return /^[ \t]*(?:--.*)?$/.test(line.slice(comma + 1)) ? comma : -1;
}

/** Move every wrapping separator comma to the front of the next line. */
function moveCommasToLineStarts(text: string, dialect: FormatOptions["dialect"]): string {
  const lines = text.split("\n");
  const inserts = new Map<number, number>(); // line index -> item column
  for (let index = 0; index + 1 < lines.length; index++) {
    const line = lines[index] ?? "";
    const next = lines[index + 1] ?? "";
    if (next.trim() === "") continue;
    const comma = wrappingComma(line);
    // A comma that already leads its line needs no move.
    if (comma < 0 || line.slice(0, comma).trim() === "") continue;
    const nextParts = /^([ \t]*)([\s\S]*)$/.exec(next);
    const indent = nextParts?.[1] ?? "";
    const content = nextParts?.[2] ?? "";
    lines[index] = `${line.slice(0, comma)}${line.slice(comma + 1)}`.trimEnd();
    lines[index + 1] = `${indent}, ${content}`;
    inserts.set(index + 1, indent.length);
  }
  if (inserts.size === 0) return text;
  return shiftMovedItems(lines, inserts, dialect).join("\n");
}

/**
 * The ", " pushes an item's first line two columns right; push the rest of the
 * item (`WHEN …`, `END`, a closing `)`) with it so it stays aligned. An item
 * runs over the lines indented past it plus the `)` / `]` / `END` that closes
 * it at its own column; any other line at or left of its column (the next
 * item, a comment, `JOIN`, the next statement) ends it. Nested items add up. A
 * line that continues a string, dollar quote, or block comment is text and
 * never moves.
 */
function shiftMovedItems(
  lines: string[],
  inserts: ReadonlyMap<number, number>,
  dialect: FormatOptions["dialect"],
): string[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const tokens = lexSql(lines.join("\n"), dialect);
  const textLines = new Set<number>();
  for (const token of tokens) {
    if (token.kind === "space" || !token.text.includes("\n")) continue;
    starts.forEach((start, line) => {
      if (start > token.start && start < token.end) textLines.add(line);
    });
  }
  const shifts = new Array<number>(lines.length).fill(0);
  for (const [target, column] of inserts) {
    for (let index = target + 1; index < lines.length; index++) {
      const line = lines[index] ?? "";
      const indent = line.length - line.trimStart().length;
      if (indent === line.length || textLines.has(index)) continue;
      if (indent < column) break;
      if (indent === column && !/^(?:[)\]]|END\b)/i.test(line.slice(indent))) break;
      shifts[index] = (shifts[index] ?? 0) + 2;
    }
  }
  return lines.map((line, index) => {
    const shift = shifts[index] ?? 0;
    if (shift === 0) return line;
    const indent = line.length - line.trimStart().length;
    return `${line.slice(0, indent)}${" ".repeat(shift)}${line.slice(indent)}`;
  });
}

const DOLLAR_QUOTE = /\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/y;

/**
 * Re-join the line breaks sql-formatter inserts inside `word(...)` groups so
 * `SUM(...)`, `COUNT(CASE … END)`, and friends stay on one line
 * (`keepFunctionsInline: true`). Only newlines in code state are removed: a
 * newline inside a string, a dollar quote, a block comment, or the line
 * comment it terminates is copied verbatim, so literal content and comment
 * bodies are never rewritten. ponytail: any `word (` opener counts as a
 * function — `IN (…)` groups collapse too, and there is no keyword blacklist.
 */
function rejoinFunctionCalls(text: string): string {
  const stack: boolean[] = []; // per open paren: true when a word(...) call owns it
  let out = "";
  let i = 0;
  const at = (index: number): string => text.charAt(index); // "" past the end, never undefined

  const isCallOpener = (): boolean => {
    const match = /[A-Za-z_][A-Za-z0-9_]*\s*$/.exec(out);
    if (match === null) return false;
    const before = out.slice(0, match.index);
    return before === "" || !/[A-Za-z0-9_]$/.test(before);
  };

  while (i < text.length) {
    const ch = at(i);
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < text.length) {
        if (at(i) === quote && at(i + 1) === quote) {
          out += at(i) + at(i + 1);
          i += 2;
          continue;
        }
        out += at(i);
        i += 1;
        if (at(i - 1) === quote) break;
        if (at(i - 1) === "\\" && quote !== "`" && i < text.length) {
          out += at(i);
          i += 1;
        }
      }
      continue;
    }
    if (ch === "$") {
      DOLLAR_QUOTE.lastIndex = i;
      const dollar = DOLLAR_QUOTE.exec(text);
      if (dollar !== null) {
        const end = text.indexOf(dollar[0], i + dollar[0].length);
        const stop = end === -1 ? text.length : end + dollar[0].length;
        out += text.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if ((ch === "-" && at(i + 1) === "-") || ch === "#") {
      while (i < text.length && at(i) !== "\n") {
        out += at(i);
        i += 1;
      }
      if (i < text.length) {
        out += at(i); // the newline ending a line comment stays verbatim
        i += 1;
      }
      continue;
    }
    if (ch === "/" && at(i + 1) === "*") {
      out += "/*";
      i += 2;
      while (i < text.length && !(at(i) === "*" && at(i + 1) === "/")) {
        out += at(i);
        i += 1;
      }
      if (i < text.length) {
        out += "*/";
        i += 2;
      }
      continue;
    }
    if (ch === "\n") {
      if (stack.includes(true)) {
        let indent = i + 1;
        while (indent < text.length && (at(indent) === " " || at(indent) === "\t")) {
          indent += 1;
        }
        let peek = indent;
        while (peek < text.length && (at(peek) === "\n" || at(peek) === " " || at(peek) === "\t")) {
          peek += 1;
        }
        const next = at(peek);
        const prev = out.slice(-1);
        i = indent; // swallow this newline and its indent
        // `(` and `,`/`)` need no separating space; everything else does.
        if (prev !== "(" && next !== "," && next !== ")") out += " ";
      } else {
        out += ch;
        i += 1;
      }
      continue;
    }
    if (ch === "(") {
      stack.push(isCallOpener());
      out += ch;
      i += 1;
      continue;
    }
    if (ch === ")") {
      stack.pop();
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Protect, format, restore, and wrap one literal exactly once. *analysis*
 * covers just the literal; *baseIndent* is its line's indent in the document.
 */
function formatOnce(
  analysis: DocumentAnalysis,
  literal: SupportedLiteral,
  detection: SqlDetection,
  options: FormatOptions,
  nonce: string,
  sqlFormatter: SqlFormatter,
  baseIndent: string,
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
  formatted = breakTrailingFieldMarkers(formatted, options.dialect);
  formatted = moveCommasBeforeLineComments(formatted);
  if (options.keepFunctionsInline) {
    formatted = rejoinFunctionCalls(formatted);
  }
  if (options.commaPosition === "before") {
    formatted = moveCommasToLineStarts(formatted, options.dialect);
  }
  formatted = breakTrailingDistributeLines(formatted, options.dialect);
  // Final gate: the formatter and every post-pass may only move whitespace
  // and change keyword case. Anything else would change what the SQL means.
  const difference = sqlTokenDifference(plan.protectedSql, formatted, options.dialect);
  if (difference !== undefined) {
    throw new CandidateFailure("FORMATTER_FAILED", `formatting changed the SQL: ${difference}`);
  }
  const restored = restoreProtected(formatted, plan);
  const resolved = options.replaceOrdinals ? replaceOrdinals(restored) : restored;
  if (literal.delimiter.length !== 3) {
    return literalText(
      literal,
      singleLineContent(analysis.sourceMap.slice(literal.contentSpan), resolved),
    );
  }
  const indented = applyBaseIndent(resolved, baseIndent, " ".repeat(options.indentWidth), true);
  return literalText(literal, normalizeFrame(indented, literal, analysis, baseIndent));
}

/**
 * Join single-quoted output onto one line and keep the source's leading and
 * trailing spaces: the literal may be glued to other text at runtime
 * (`+=`, `"".join`, interpolation), where a dropped edge space breaks SQL.
 */
function singleLineContent(sourceContent: string, formatted: string): string {
  const leading = /^[ \t]*/.exec(sourceContent)?.[0] ?? "";
  const trailing = /[ \t]*$/.exec(sourceContent)?.[0] ?? "";
  return `${leading}${formatted.replace(/\s*\n\s*/g, " ").trim()}${trailing}`;
}

/**
 * Analyze one literal's text on its own. It must read back as exactly one
 * supported literal covering the whole text, with the original's prefix,
 * delimiter, and kind. A literal is self-contained, so this equals reading it
 * inside its document; formatDocument re-checks the document as a whole once.
 */
function analyzeLiteral(
  text: string,
  original: SupportedLiteral,
): { readonly analysis: DocumentAnalysis; readonly literal: SupportedLiteral } {
  let analysis: DocumentAnalysis;
  try {
    analysis = analyzeDocument(text);
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new CandidateFailure("FORMATTER_FAILED", `reparse threw: ${message}`);
  }
  const literal = analysis.supported[0];
  if (
    literal === undefined ||
    analysis.supported.length !== 1 ||
    analysis.unsupported.length !== 0 ||
    literal.span.start !== 0 ||
    literal.span.end !== text.length
  ) {
    throw new CandidateFailure("UNSAFE_RAW_STRING");
  }
  if (
    literal.prefix !== original.prefix ||
    literal.delimiter !== original.delimiter ||
    literal.kind !== original.kind
  ) {
    throw new CandidateFailure("UNSAFE_RAW_STRING");
  }
  return { analysis, literal };
}

/** Return source spellings of every replacement field. */
function fieldTexts(analysis: DocumentAnalysis, literal: SupportedLiteral): readonly string[] {
  return literal.fieldSpans.map((span) => analysis.sourceMap.slice(span));
}

/** Require each iteration to be a valid candidate, then re-format until stable. */
function convergeToFixedPoint(
  analysis: DocumentAnalysis,
  literal: SupportedLiteral,
  detection: SqlDetection,
  options: FormatOptions,
  nonce: string,
  sqlFormatter: SqlFormatter,
  baseIndent: string,
): string {
  const fieldsBefore = fieldTexts(analysis, literal).join("\u0000");
  let current = formatOnce(analysis, literal, detection, options, nonce, sqlFormatter, baseIndent);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const updated = analyzeLiteral(current, literal);
    const fieldsAfter = fieldTexts(updated.analysis, updated.literal).join("\u0000");
    if (fieldsBefore !== fieldsAfter) {
      throw new CandidateFailure(
        "UNSAFE_FSTRING_RESTORE",
        `field texts changed: before=[${fieldsBefore.split("\u0000").join(", ")}] after=[${fieldsAfter
          .split("\u0000")
          .join(", ")}]`,
      );
    }
    const updatedDetection = detectSql(updated.literal, updated.analysis.sourceMap);
    if (!updatedDetection.matched) {
      throw new CandidateFailure("FORMATTER_FAILED", "updated candidate no longer matches --sql");
    }
    const next = formatOnce(
      updated.analysis,
      updated.literal,
      updatedDetection,
      options,
      nonce,
      sqlFormatter,
      baseIndent,
    );
    if (next === current) return current;
    current = next;
  }
  throw new CandidateFailure(
    "FORMATTER_FAILED",
    "formatting did not converge to a fixed point in 3 attempts",
  );
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
    // Work on the literal alone so each candidate costs its own size, not the
    // document's; only the line's indent comes from the document.
    const local = analyzeLiteral(expected, literal);
    first = convergeToFixedPoint(
      local.analysis,
      local.literal,
      detectSql(local.literal, local.analysis.sourceMap),
      options,
      nonce,
      sqlFormatter,
      baseIndentOf(analysis, literal),
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
