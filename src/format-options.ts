import type { FormatOptions } from "./protocol.js";

export type FormatOptionsResult =
  | { readonly ok: true; readonly options: FormatOptions }
  | { readonly ok: false; readonly reason: "INVALID_CONFIGURATION" };

export interface RawFormatOptions {
  readonly keywordCase?: unknown;
  readonly indentWidth?: unknown;
  readonly wrapAfter?: unknown;
  readonly useSpaceAroundOperators?: unknown;
  readonly replaceOrdinals?: unknown;
  readonly dialect?: unknown;
  readonly commaPosition?: unknown;
}

function integerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

export function resolveFormatOptions(raw: RawFormatOptions): FormatOptionsResult {
  const keywordCase = raw.keywordCase === undefined ? "upper" : raw.keywordCase;
  const indentWidth = raw.indentWidth === undefined ? 2 : raw.indentWidth;
  const wrapAfter = raw.wrapAfter === undefined ? 88 : raw.wrapAfter;
  const useSpaceAroundOperators =
    raw.useSpaceAroundOperators === undefined ? true : raw.useSpaceAroundOperators;
  const replaceOrdinals = raw.replaceOrdinals === undefined ? true : raw.replaceOrdinals;
  const dialect = raw.dialect === undefined ? "postgresql" : raw.dialect;
  const commaPosition = raw.commaPosition === undefined ? "after" : raw.commaPosition;

  if (
    (keywordCase !== "upper" && keywordCase !== "lower" && keywordCase !== "preserve") ||
    !integerBetween(indentWidth, 1, 8) ||
    !integerBetween(wrapAfter, 20, 500) ||
    typeof useSpaceAroundOperators !== "boolean" ||
    typeof replaceOrdinals !== "boolean" ||
    (dialect !== "sql" &&
      dialect !== "mysql" &&
      dialect !== "postgresql" &&
      dialect !== "sqlite") ||
    (commaPosition !== "after" && commaPosition !== "before")
  ) {
    return { ok: false, reason: "INVALID_CONFIGURATION" };
  }

  return {
    ok: true,
    options: {
      keywordCase,
      indentWidth,
      wrapAfter,
      useSpaceAroundOperators,
      replaceOrdinals,
      dialect,
      commaPosition,
    },
  };
}
