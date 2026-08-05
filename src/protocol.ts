import { REASON_CODES } from "./constants.js";

export type FormatMode = "cursor" | "selection" | "all";
export type ReasonCode = (typeof REASON_CODES)[number];

export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface TextRange {
  readonly start: Position;
  readonly end: Position;
}

export interface FormatOptions {
  readonly keywordCase: "upper" | "lower" | "preserve";
  readonly indentWidth: number;
  readonly wrapAfter: number;
  readonly useSpaceAroundOperators: boolean;
  readonly replaceOrdinals: boolean;
  readonly dialect: "sql" | "mysql" | "postgresql" | "sqlite";
}

export interface FormatTarget {
  readonly mode: FormatMode;
  readonly cursor?: Position;
  readonly selection?: TextRange;
}

export interface FormatEdit {
  readonly range: TextRange;
  readonly expectedText: string;
  readonly newText: string;
}

export interface FormatSummary {
  readonly discovered: number;
  readonly selected: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly skipped: number;
}

export interface FormatSuccess {
  readonly edits: readonly FormatEdit[];
  readonly summary: FormatSummary;
}
