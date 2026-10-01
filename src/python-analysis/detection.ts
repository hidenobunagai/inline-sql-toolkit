import { SourceMap, SourceSpan } from "./positions.js";
import type { SupportedLiteral, UnsupportedLiteral } from "./tokenizer.js";

/** One source-level SQL detection result. */
export interface SqlDetection {
  readonly matched: boolean;
  readonly markerSpan: SourceSpan | undefined;
  readonly sqlSpan: SourceSpan | undefined;
  readonly reason: "marker" | "keyword" | "none";
}

const MARKERS = new Set(["-- sql", "--sql"]);
const ASCII_WHITESPACE = new Set([" ", "\t", "\r", "\n"]);

// A bare, quoted, or f-string/%-placeholder identifier, optionally dotted.
const IDENT = String.raw`(?:[\p{L}_][\p{L}\p{N}_$]*|"[^"]*"|\x60[^\x60]*\x60|\[[^\]]*\]|\{[^{}]*\}|%(?:\([^)]*\))?s)`;
const TABLE_REF = String.raw`${IDENT}(?:\s*\.\s*${IDENT})*`;
const OBJECT = String.raw`(?:table|view|index|schema|database|function|procedure|trigger|sequence|type|extension|domain|policy|aggregate|collation|tablespace|publication|subscription|event|server|rule|statistics)`;
const CREATE_MODIFIER = String.raw`(?:global|local|temp|temporary|unlogged|unique|materialized|recursive|virtual|external|fulltext|spatial|secure|transient)`;

/** A select list that reads as SQL even without a FROM clause (`SELECT 1`). */
const SELECT_LIST_START = new RegExp(
  String.raw`^\s*(?:[*(\d'"\x60{:@$?%-]|[\p{L}_][\p{L}\p{N}_$.]*\s*\(|(?:case|cast|exists|not|null|true|false|current_\w+|localtime\w*)\b)`,
  "iu",
);

/**
 * Each leading keyword must open a recognizable statement, so prose such as
 * "Update available" or a bare `"delete"` value is never taken for SQL.
 */
const KEYWORD_SHAPES: readonly (readonly [string, (text: string) => boolean])[] = [
  [
    "select",
    (text) => {
      const rest = text.slice("select".length);
      return /\bfrom\b/i.test(rest) || SELECT_LIST_START.test(rest);
    },
  ],
  [
    "with",
    shape(
      String.raw`with\s+(?:recursive\s+)?${IDENT}\s*(?:\([^)]*\)\s*)?as\s*(?:(?:not\s+)?materialized\s*)?\(`,
    ),
  ],
  [
    "insert",
    shape(
      String.raw`insert\s+(?:or\s+\w+\s+)?(?:(?:low_priority|delayed|high_priority|ignore)\s+)*(?:into|overwrite)\b`,
    ),
  ],
  [
    "update",
    shape(
      String.raw`update\s+(?:(?:only|low_priority|ignore)\s+|or\s+\w+\s+)*${TABLE_REF}(?:\s+(?:as\s+)?${IDENT})?\s+set\b`,
    ),
  ],
  [
    "delete",
    shape(
      String.raw`delete\s+(?:(?:low_priority|quick|ignore)\s+)*(?:from\b|${TABLE_REF}(?:\s*,\s*${TABLE_REF})*\s+from\b)`,
    ),
  ],
  ["merge", shape(String.raw`merge\s+into\b`)],
  ["create", shape(String.raw`create\s+(?:or\s+replace\s+)?(?:${CREATE_MODIFIER}\s+)*${OBJECT}\b`)],
  ["alter", shape(String.raw`alter\s+(?:materialized\s+)?${OBJECT}\b`)],
  ["drop", shape(String.raw`drop\s+(?:${CREATE_MODIFIER}\s+)*${OBJECT}\b`)],
  [
    "truncate",
    shape(
      String.raw`truncate\s+(?:table\b|(?:only\s+)?${TABLE_REF}(?:\s*,\s*${TABLE_REF})*\s*(?:;|$|(?:restart|continue|cascade|restrict)\b))`,
    ),
  ],
  [
    "explain",
    shape(
      String.raw`explain\s+(?:(?:analyze|analyse|verbose|extended|query\s+plan)\s+|\([^)]*\)\s*)*(?:select|with|insert|update|delete|merge|values|table|execute|create|declare)\b`,
    ),
  ],
];

/** Compile one case-insensitive statement prefix. */
function shape(pattern: string): (text: string) => boolean {
  const regex = new RegExp(`^${pattern}`, "iu");
  return (text) => regex.test(text);
}

/** Read `\n`, `\r`, `\t`, and backslash-newline escapes as whitespace. */
function shapeText(text: string): string {
  return text.replace(/\\(?:[nrt]|\r\n|\r|\n)/g, " ");
}

/** Return whether *character* continues a Python/Unicode identifier. */
function continuesIdentifier(character: string): boolean {
  if (character === "") return false;
  if (character === "_") return true;
  return /[\p{L}\p{N}]/u.test(character);
}

/** Split text into lines, keeping terminators, like Python splitlines(True). */
function splitLinesKeepends(text: string): readonly string[] {
  const lines: string[] = [];
  const parts = text.split(/(\r\n|\r|\n)/);
  for (let index = 0; index < parts.length; index += 2) {
    lines.push(`${parts[index] ?? ""}${parts[index + 1] ?? ""}`);
  }
  return lines;
}

/** Detect an explicit marker or leading SQL keyword in one source slice. */
function detectSourceSlice(text: string, base: number): SqlDetection {
  let cursor = 0;
  for (const line of splitLinesKeepends(text)) {
    const body = line.replace(/[\r\n]+$/, "");
    if (body.trim() === "") {
      cursor += line.length;
      continue;
    }
    if (MARKERS.has(body.trim().toLowerCase())) {
      const marker = new SourceSpan(base + cursor, base + cursor + body.length);
      return {
        matched: true,
        markerSpan: marker,
        sqlSpan: new SourceSpan(base + cursor + line.length, base + text.length),
        reason: "marker",
      };
    }
    break;
  }

  let significant = 0;
  while (significant < text.length && ASCII_WHITESPACE.has(text[significant] ?? "")) {
    significant++;
  }
  const statement = text.slice(significant);
  for (const [keyword, matchesShape] of KEYWORD_SHAPES) {
    const written = statement.slice(0, keyword.length);
    // SQL spells keywords in one case; "Select ..." / "Update ..." is prose.
    if (written !== keyword && written !== keyword.toUpperCase()) continue;
    const following = text[significant + keyword.length] ?? "";
    if (!continuesIdentifier(following) && matchesShape(shapeText(statement))) {
      return {
        matched: true,
        markerSpan: undefined,
        sqlSpan: new SourceSpan(base + significant, base + text.length),
        reason: "keyword",
      };
    }
  }
  return { matched: false, markerSpan: undefined, sqlSpan: undefined, reason: "none" };
}

/** Detect SQL from physical source characters without evaluating escapes. */
export function detectSql(
  literal: SupportedLiteral | UnsupportedLiteral,
  sourceMap: SourceMap,
): SqlDetection {
  const span = "contentSpan" in literal ? literal.contentSpan : literal.detectionContentSpan;
  if (span === undefined) {
    return { matched: false, markerSpan: undefined, sqlSpan: undefined, reason: "none" };
  }
  return detectSourceSlice(sourceMap.slice(span), span.start);
}
