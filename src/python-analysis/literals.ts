import { SourceMap, SourceSpan } from "./positions.js";
import {
  fstringKind,
  scanFstringFieldSpans,
  scanStringSurfaces,
  type StringSurface,
  type SupportedLiteral,
  type UnsupportedLiteral,
} from "./tokenizer.js";

/** Parsed document and its source-ordered literal classifications. */
export interface DocumentAnalysis {
  readonly sourceMap: SourceMap;
  readonly supported: readonly SupportedLiteral[];
  readonly unsupported: readonly UnsupportedLiteral[];
}

function onlyWhitespace(text: string): boolean {
  return /^[\s]*$/.test(text);
}

/**
 * Drop comments and backslash line continuations from code that lies between
 * two string surfaces. Such text holds no string, so every `#` starts a comment.
 */
function codeOnly(text: string): string {
  return text.replace(/#.*$/gm, "").replace(/\\(?:\r\n|\r|\n)/g, " ");
}

const OPERATOR_ONLY = /^\s*[+\-*/%&|^<>]+\s*$/;

/** Return whether the surface at *index* participates in a string concatenation. */
function isConcatenated(
  source: string,
  surfaces: readonly StringSurface[],
  index: number,
): boolean {
  const current = surfaces[index];
  if (current === undefined) return false;
  const previous = surfaces[index - 1];
  const next = surfaces[index + 1];
  const before = codeOnly(source.slice(previous?.span.end ?? 0, current.span.start));
  const after = codeOnly(source.slice(current.span.end, next?.span.start ?? source.length));
  // Implicit concatenation, even across comments or `\` line continuations.
  if (previous !== undefined && onlyWhitespace(before)) return true;
  if (next !== undefined && onlyWhitespace(after)) return true;
  // `+` / `+=` joins this literal with another operand, literal or not.
  if (/\+=?\s*$/.test(before) || /^\s*\+/.test(after)) return true;
  // Any other operator directly between two literals, e.g. `"a" % "b"`.
  if (previous !== undefined && OPERATOR_ONLY.test(before)) return true;
  return next !== undefined && OPERATOR_ONLY.test(after);
}

/** Parse one complete document and collect plain-string syntax units. */
export function analyzeDocument(source: string): DocumentAnalysis {
  const sourceMap = SourceMap.fromText(source);
  const surfaces = scanStringSurfaces(source);
  const supported: SupportedLiteral[] = [];
  const unsupported: UnsupportedLiteral[] = [];
  surfaces.forEach((surface, index) => {
    if (isConcatenated(source, surfaces, index)) {
      unsupported.push({
        span: surface.span,
        detectionContentSpan: surface.contentSpan,
        reason: "UNSUPPORTED_LITERAL",
      });
      return;
    }
    if (surface.kind === "tstring") {
      unsupported.push({
        span: surface.span,
        detectionContentSpan: undefined,
        reason: "UNSUPPORTED_LITERAL",
      });
      return;
    }
    const prefix = surface.prefix.toLowerCase();
    if (prefix === "u" || prefix.includes("b")) {
      unsupported.push({
        span: surface.span,
        detectionContentSpan: undefined,
        reason: "UNSUPPORTED_LITERAL",
      });
      return;
    }
    if (surface.kind === "fstring") {
      const kind = fstringKind(surface.prefix);
      if (kind === undefined) {
        unsupported.push({
          span: surface.span,
          detectionContentSpan: undefined,
          reason: "UNSUPPORTED_LITERAL",
        });
        return;
      }
      supported.push({
        span: surface.span,
        contentSpan: surface.contentSpan,
        prefix: surface.prefix,
        delimiter: surface.delimiter as SupportedLiteral["delimiter"],
        kind,
        fieldSpans: scanFstringFieldSpans(source, surface.contentSpan),
      });
      return;
    }
    supported.push({
      span: surface.span,
      contentSpan: surface.contentSpan,
      prefix: surface.prefix,
      delimiter: surface.delimiter as SupportedLiteral["delimiter"],
      kind: prefix === "r" ? "raw" : "plain",
      fieldSpans: [],
    });
  });
  return {
    sourceMap,
    supported: [...supported].sort((left, right) => left.span.start - right.span.start),
    unsupported: [...unsupported].sort((left, right) => left.span.start - right.span.start),
  };
}

export type { SourceSpan };
