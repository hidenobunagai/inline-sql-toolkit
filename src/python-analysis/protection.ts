import type { SqlDetection } from "./detection.js";
import { SourceMap, SourceSpan } from "./positions.js";
import type { LiteralKind, SupportedLiteral } from "./tokenizer.js";

/** Kind of source text replaced by an opaque formatter marker. */
export type ProtectedKind = "field" | "escaped_brace" | "python_escape" | "sql_marker";

/** A source-free failure to restore protected Python text. */
export class UnsafeRestore extends Error {}

/** One source span replaced by a nonce-bearing marker. */
export interface ProtectedFragment {
  readonly kind: ProtectedKind;
  readonly ordinal: number;
  readonly sourceSpan: SourceSpan;
  readonly sourceText: string;
  readonly marker: string;
  readonly requiredOffset: number | undefined;
}

/** The masked literal body and its exact restoration fragments. */
export interface ProtectionPlan {
  readonly nonce: string;
  readonly protectedSql: string;
  readonly fragments: readonly ProtectedFragment[];
}

/** Allocate a 32-hex-character request nonce absent from *source*. */
export function allocateNonce(source: string, randomHex: () => string): string {
  for (let attempt = 0; attempt < 128; attempt++) {
    const candidate = randomHex();
    if (!/^[0-9a-f]{32}$/.test(candidate)) {
      throw new UnsafeRestore("invalid protection nonce");
    }
    if (!source.includes(candidate)) return candidate;
  }
  throw new UnsafeRestore("unable to allocate protection nonce");
}

/** Return the stable opaque token used for one protected fragment. */
export function markerText(
  nonce: string,
  kind: ProtectedKind,
  ordinal: number,
  options: { readonly sqlComment: boolean; readonly canonicalNewline: boolean },
): string {
  const token = `__INLINE_SQL_${nonce}_${kind.toUpperCase()}_${ordinal}__`;
  if (options.sqlComment) return `-- ${token}${options.canonicalNewline ? "\n" : ""}`;
  return `${token}${options.canonicalNewline ? "\n" : ""}`;
}

function intersectsAny(span: SourceSpan, blocked: readonly SourceSpan[]): boolean {
  return blocked.some((other) => span.start < other.end && other.start < span.end);
}

/** Return the complete source spelling of an escape at *start*. */
function pythonEscapeEnd(source: string, start: number, limit: number): number {
  if (start + 1 >= limit || source[start] !== "\\") {
    throw new UnsafeRestore("invalid Python escape boundary");
  }
  const next = source[start + 1] ?? "";
  if (next === "\r" && start + 2 < limit && source[start + 2] === "\n") return start + 3;
  if (next === "\r" || next === "\n") return start + 2;
  if (next === "N" && start + 2 < limit && source[start + 2] === "{") {
    const close = source.indexOf("}", start + 3);
    if (close < 0 || close >= limit) {
      throw new UnsafeRestore("unterminated named Python escape");
    }
    return close + 1;
  }
  const widths: Record<string, number> = { x: 2, u: 4, U: 8 };
  if (next in widths) {
    const width = widths[next];
    if (width === undefined) {
      throw new UnsafeRestore("unterminated fixed-width Python escape");
    }
    const end = start + 2 + width;
    if (end > limit) throw new UnsafeRestore("unterminated fixed-width Python escape");
    return end;
  }
  if ("01234567".includes(next)) {
    let end = start + 2;
    while (end < Math.min(start + 4, limit) && "01234567".includes(source[end] ?? "")) {
      end++;
    }
    return end;
  }
  return start + 2;
}

interface FragmentSpec {
  readonly kind: ProtectedKind;
  readonly sourceSpan: SourceSpan;
  readonly sqlComment: boolean;
  readonly canonicalNewline: boolean;
  readonly requiredOffset: number | undefined;
}

function spec(
  kind: ProtectedKind,
  sourceSpan: SourceSpan,
  options: Partial<Omit<FragmentSpec, "kind" | "sourceSpan">> = {},
): FragmentSpec {
  return {
    kind,
    sourceSpan,
    sqlComment: options.sqlComment ?? false,
    canonicalNewline: options.canonicalNewline ?? false,
    requiredOffset: options.requiredOffset,
  };
}

/** Discover protected syntax spans without evaluating Python text. */
function discoverSourceSpecs(
  sourceMap: SourceMap,
  literal: SupportedLiteral,
  detection: SqlDetection,
): readonly FragmentSpec[] {
  const content = literal.contentSpan;
  const specs: FragmentSpec[] = [];
  if (detection.markerSpan !== undefined) {
    if (detection.sqlSpan === undefined) {
      throw new UnsafeRestore("marker detection has no SQL boundary");
    }
    const markerSpan = new SourceSpan(content.start, detection.sqlSpan.start);
    const markerSource = sourceMap.slice(markerSpan);
    specs.push(
      spec("sql_marker", markerSpan, {
        sqlComment: true,
        canonicalNewline: /[\r\n]$/.test(markerSource),
        requiredOffset: 0,
      }),
    );
  }
  specs.push(...literal.fieldSpans.map((span) => spec("field", span)));
  const fixedSpans = specs.map((item) => item.sourceSpan);

  if (literal.kind !== "raw" && literal.kind !== "raw_fstring") {
    let cursor = content.start;
    while (cursor < content.end) {
      if (sourceMap.text[cursor] !== "\\") {
        cursor++;
        continue;
      }
      const end = pythonEscapeEnd(sourceMap.text, cursor, content.end);
      const span = new SourceSpan(cursor, end);
      if (!intersectsAny(span, fixedSpans)) {
        specs.push(spec("python_escape", span));
      }
      cursor = end;
    }
  }

  let cursor = content.start;
  while (cursor + 1 < content.end) {
    const pair = sourceMap.text.slice(cursor, cursor + 2);
    if (pair === "{{") {
      const close = sourceMap.text.indexOf("}}", cursor + 2);
      const span = new SourceSpan(cursor, close === -1 ? content.end : close + 2);
      const overlaps = specs.filter((item) => intersectsAny(span, [item.sourceSpan]));
      if (overlaps.length === 0) {
        specs.push(spec("escaped_brace", span));
      } else if (overlaps.every((item) => item.kind === "python_escape")) {
        const merged = new SourceSpan(
          Math.min(span.start, ...overlaps.map((item) => item.sourceSpan.start)),
          Math.max(span.end, ...overlaps.map((item) => item.sourceSpan.end)),
        );
        const overlapSet = new Set(overlaps);
        const filtered = specs.filter((item) => !overlapSet.has(item));
        filtered.push(spec("python_escape", merged));
        specs.length = 0;
        specs.push(...filtered);
      }
      cursor = span.end;
      continue;
    }
    if (pair === "}}") {
      const span = new SourceSpan(cursor, cursor + 2);
      const overlaps = specs.filter((item) => intersectsAny(span, [item.sourceSpan]));
      if (overlaps.length === 0) {
        specs.push(spec("escaped_brace", span));
      }
      cursor += 2;
      continue;
    }
    cursor += 1;
  }
  return [...specs].sort((left, right) => left.sourceSpan.start - right.sourceSpan.start);
}

/** Replace source fragments in order, rejecting overlap or out-of-range spans. */
function maskFragments(
  content: string,
  contentStart: number,
  fragments: readonly ProtectedFragment[],
): string {
  const pieces: string[] = [];
  let cursor = 0;
  for (const fragment of fragments) {
    const start = fragment.sourceSpan.start - contentStart;
    const end = fragment.sourceSpan.end - contentStart;
    if (start < cursor || end < start || end > content.length) {
      throw new UnsafeRestore("protected source spans overlap");
    }
    pieces.push(content.slice(cursor, start), fragment.marker);
    cursor = end;
  }
  pieces.push(content.slice(cursor));
  return pieces.join("");
}

/** Build an exact source mask for one detected SQL literal. */
export function buildProtectionPlan(
  sourceMap: SourceMap,
  literal: SupportedLiteral,
  detection: SqlDetection,
  nonce: string,
): ProtectionPlan {
  if (
    !detection.matched ||
    detection.sqlSpan === undefined ||
    !/^[0-9a-f]{32}$/.test(nonce) ||
    sourceMap.text.includes(nonce)
  ) {
    throw new UnsafeRestore("invalid protection-plan input");
  }
  if (
    literal.contentSpan.start < 0 ||
    literal.contentSpan.end > sourceMap.text.length ||
    detection.sqlSpan.start < literal.contentSpan.start ||
    detection.sqlSpan.end !== literal.contentSpan.end
  ) {
    throw new UnsafeRestore("invalid protection-plan span");
  }
  const specs = discoverSourceSpecs(sourceMap, literal, detection);
  const fragments: ProtectedFragment[] = [];
  let previousEnd = literal.contentSpan.start;
  for (let ordinal = 0; ordinal < specs.length; ordinal++) {
    const item = specs[ordinal];
    if (item === undefined) throw new UnsafeRestore("protected source spans overlap");
    const span = item.sourceSpan;
    if (
      span.start < previousEnd ||
      span.start < literal.contentSpan.start ||
      span.end > literal.contentSpan.end
    ) {
      throw new UnsafeRestore("protected source spans overlap");
    }
    fragments.push({
      kind: item.kind,
      ordinal,
      sourceSpan: span,
      sourceText: sourceMap.slice(span),
      marker: markerText(nonce, item.kind, ordinal, {
        sqlComment: item.sqlComment,
        canonicalNewline: item.canonicalNewline,
      }),
      requiredOffset: item.requiredOffset,
    });
    previousEnd = span.end;
  }
  return {
    nonce,
    protectedSql: maskFragments(
      sourceMap.slice(literal.contentSpan),
      literal.contentSpan.start,
      fragments,
    ),
    fragments,
  };
}

/** Extract the bare token from a marker whose nonce must match *nonce*. */
function markerToken(marker: string, nonce: string): string {
  const escapedNonce = nonce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokenPattern = `__INLINE_SQL_${escapedNonce}_[A-Z_]+_[0-9]+__`;
  if (marker.startsWith("-- ")) {
    const match = new RegExp(`^-- ${tokenPattern}\\n?$`).exec(marker);
    if (match === null) throw new UnsafeRestore("invalid protected marker");
    return match[0].replace(/^-- /, "").replace(/\n$/, "");
  }
  const match = new RegExp(`^${tokenPattern}\\n?$`).exec(marker);
  if (match === null) throw new UnsafeRestore("invalid protected marker");
  return match[0].replace(/\n$/, "");
}

/** Restore all protected fragments in one validated ordered scan. */
export function restoreProtected(formatted: string, plan: ProtectionPlan): string {
  if (!/^[0-9a-f]{32}$/.test(plan.nonce)) {
    throw new UnsafeRestore("invalid protection nonce");
  }
  if (formatted.split(plan.nonce).length - 1 !== plan.fragments.length) {
    throw new UnsafeRestore("protection namespace count changed");
  }
  const escapedNonce = plan.nonce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const namespace = new RegExp(`__INLINE_SQL_${escapedNonce}_[A-Z_]+_[0-9]+__`, "g");
  const actualTokens = [...formatted.matchAll(namespace)].map((match) => match[0]);
  const expectedTokens = plan.fragments.map((fragment) => markerToken(fragment.marker, plan.nonce));
  if (actualTokens.join("\u0000") !== expectedTokens.join("\u0000")) {
    throw new UnsafeRestore("protected marker sequence changed");
  }

  const pieces: string[] = [];
  let cursor = 0;
  plan.fragments.forEach((fragment, index) => {
    const expectedToken = expectedTokens[index];
    if (expectedToken === undefined) {
      throw new UnsafeRestore("protected marker sequence changed");
    }
    const expectedIdentity = `__INLINE_SQL_${plan.nonce}_${fragment.kind.toUpperCase()}_${fragment.ordinal}__`;
    if (expectedToken !== expectedIdentity) {
      throw new UnsafeRestore("protected marker identity changed");
    }
    const position = formatted.indexOf(fragment.marker, cursor);
    if (position < 0) throw new UnsafeRestore("protected marker spelling changed");
    let tokenPosition = position;
    if (fragment.marker.startsWith("-- ")) tokenPosition += 3;
    else if (fragment.marker.startsWith('"')) tokenPosition += 1;
    if (formatted.slice(tokenPosition, tokenPosition + expectedToken.length) !== expectedToken) {
      throw new UnsafeRestore("protected marker identity changed");
    }
    if (fragment.requiredOffset !== undefined && position !== fragment.requiredOffset) {
      throw new UnsafeRestore("anchored marker moved");
    }
    pieces.push(formatted.slice(cursor, position), fragment.sourceText);
    cursor = position + fragment.marker.length;
  });
  pieces.push(formatted.slice(cursor));
  const restored = pieces.join("");
  if (restored.includes(plan.nonce)) {
    throw new UnsafeRestore("protection namespace remains after restore");
  }
  return restored;
}

export type { LiteralKind };
