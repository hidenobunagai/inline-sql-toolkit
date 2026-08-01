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

const STRING_OPERATORS = new Set(["+", "-", "*", "/", "%", "&", "|", "^", "<", ">"]);

function onlyWhitespace(text: string): boolean {
  return /^[\s]*$/.test(text);
}

/** Return whether the surface at *index* participates in a string concatenation. */
function isConcatenated(
  source: string,
  surfaces: readonly StringSurface[],
  index: number,
): boolean {
  const current = surfaces[index];
  if (current === undefined) return false;
  const neighbors = [
    index > 0 ? surfaces[index - 1] : undefined,
    index + 1 < surfaces.length ? surfaces[index + 1] : undefined,
  ];
  return neighbors.some((neighbor) => {
    if (neighbor === undefined) return false;
    const between =
      neighbor.span.end <= current.span.start
        ? source.slice(neighbor.span.end, current.span.start)
        : source.slice(current.span.end, neighbor.span.start);
    if (onlyWhitespace(between)) return true;
    const operator = between.match(/[+\-*/%&|^<>]/);
    return operator !== null && STRING_OPERATORS.has(operator[0]);
  });
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
