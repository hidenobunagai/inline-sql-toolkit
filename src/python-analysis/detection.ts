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
const KEYWORDS = [
  "select",
  "with",
  "insert",
  "update",
  "delete",
  "merge",
  "create",
  "alter",
  "drop",
  "truncate",
  "explain",
];
const ASCII_WHITESPACE = new Set([" ", "\t", "\r", "\n"]);

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
  const folded = text.slice(significant).toLowerCase();
  for (const keyword of KEYWORDS) {
    if (!folded.startsWith(keyword)) continue;
    const following = text[significant + keyword.length] ?? "";
    if (!continuesIdentifier(following)) {
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
