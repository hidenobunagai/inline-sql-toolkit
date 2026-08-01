import { REASON_CODES } from "./constants.js";

export type FormatMode = "cursor" | "selection" | "all";
export type ProtocolOperation = "locate" | "protect" | "finalize" | "format";
export type ProtocolValueKind =
  "request" | "locateResponse" | "protectResponse" | "formatResponse" | "preDispatchError";
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
  readonly expandSelectList: boolean;
  readonly trimBlankBoundaries: boolean;
  readonly dialect: "sql" | "mysql" | "postgresql" | "sqlite";
}

export interface ProtectCandidate {
  readonly range: TextRange;
  readonly sql: string;
  readonly singleLine: boolean;
}

export interface ProtectResponse {
  readonly protocolVersion: 1;
  readonly operation: "protect";
  readonly ok: true;
  readonly nonce: string;
  readonly skipped: number;
  readonly candidates: readonly ProtectCandidate[];
}

export interface FinalizeItem {
  readonly range: TextRange;
  readonly sql: string;
}

export interface FinalizeRequest {
  readonly protocolVersion: 1;
  readonly operation: "finalize";
  readonly source: string;
  readonly nonce: string;
  readonly options: FormatOptions;
  readonly formatted: readonly FinalizeItem[];
}

export interface FormatTarget {
  readonly mode: FormatMode;
  readonly cursor?: Position;
  readonly selection?: TextRange;
}

export interface HelperRequest {
  readonly protocolVersion: 1;
  readonly operation: ProtocolOperation;
  readonly source: string;
  readonly target: FormatTarget;
  readonly options: FormatOptions;
}

export interface FormatEdit {
  readonly range: TextRange;
  readonly expectedText: string;
  readonly newText: string;
}

export interface CandidateSkipPayload {
  readonly range: TextRange;
  readonly reason: ReasonCode;
}

export interface FormatSummary {
  readonly discovered: number;
  readonly selected: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly skipped: number;
}

export interface LocateSuccess {
  readonly protocolVersion: 1;
  readonly operation: "locate";
  readonly ok: true;
  readonly candidates: readonly TextRange[];
}

export interface FormatSuccess {
  readonly protocolVersion: 1;
  readonly operation: "format" | "finalize";
  readonly ok: true;
  readonly edits: readonly FormatEdit[];
  readonly skips: readonly CandidateSkipPayload[];
  readonly summary: FormatSummary;
}

export interface ErrorResponse {
  readonly protocolVersion: 1;
  readonly operation: ProtocolOperation | "unknown";
  readonly ok: false;
  readonly error: { readonly code: ReasonCode };
}

export type LocateResponse = LocateSuccess | ErrorResponse;
export type FormatResponse = FormatSuccess | ErrorResponse;

export class ProtocolViolation extends Error {
  readonly code = "PROTOCOL_ERROR" as const;

  constructor(code: "PROTOCOL_ERROR" = "PROTOCOL_ERROR") {
    super(code);
    this.name = "ProtocolViolation";
  }
}

function requireExactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolViolation();
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ProtocolViolation();
  }
  return record;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolViolation();
  }
  return value as Record<string, unknown>;
}

function requireNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolViolation();
  }
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProtocolViolation();
  }
  return value;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new ProtocolViolation();
  }
  return value;
}

function requireLiteral<const T extends string | number | boolean>(value: unknown, expected: T): T {
  if (value !== expected) {
    throw new ProtocolViolation();
  }
  return expected;
}

function requireEnum<const T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ProtocolViolation();
  }
  return value as T;
}

function parseArray<T>(value: unknown, parseItem: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(value)) {
    throw new ProtocolViolation();
  }
  return value.map(parseItem);
}

function comparePosition(left: Position, right: Position): number {
  return left.line === right.line
    ? Math.sign(left.character - right.character)
    : Math.sign(left.line - right.line);
}

function parsePosition(value: unknown): Position {
  const record = requireExactObject(value, ["line", "character"]);
  return {
    line: requireNonNegativeInteger(record.line),
    character: requireNonNegativeInteger(record.character),
  };
}

function parseRange(value: unknown, allowEmpty = true): TextRange {
  const record = requireExactObject(value, ["start", "end"]);
  const result = {
    start: parsePosition(record.start),
    end: parsePosition(record.end),
  };
  const order = comparePosition(result.start, result.end);
  if (order > 0 || (!allowEmpty && order === 0)) {
    throw new ProtocolViolation();
  }
  return result;
}

function parseOptions(value: unknown): FormatOptions {
  const record = requireExactObject(value, [
    "keywordCase",
    "indentWidth",
    "wrapAfter",
    "useSpaceAroundOperators",
    "expandSelectList",
    "trimBlankBoundaries",
    "dialect",
  ]);
  const indentWidth = requireNonNegativeInteger(record.indentWidth);
  const wrapAfter = requireNonNegativeInteger(record.wrapAfter);
  if (indentWidth < 1 || indentWidth > 8 || wrapAfter < 20 || wrapAfter > 500) {
    throw new ProtocolViolation();
  }
  return {
    keywordCase: requireEnum(record.keywordCase, ["upper", "lower", "preserve"]),
    indentWidth,
    wrapAfter,
    useSpaceAroundOperators: requireBoolean(record.useSpaceAroundOperators),
    expandSelectList: requireBoolean(record.expandSelectList),
    trimBlankBoundaries: requireBoolean(record.trimBlankBoundaries),
    dialect: requireEnum(record.dialect, ["sql", "mysql", "postgresql", "sqlite"]),
  };
}

function parseTarget(value: unknown): FormatTarget {
  const object = requireObject(value);
  if (object.mode === "cursor") {
    const record = requireExactObject(value, ["mode", "cursor"]);
    return { mode: "cursor", cursor: parsePosition(record.cursor) };
  }
  if (object.mode === "selection") {
    const record = requireExactObject(value, ["mode", "selection"]);
    return {
      mode: "selection",
      selection: parseRange(record.selection, false),
    };
  }
  const record = requireExactObject(value, ["mode"]);
  return { mode: requireLiteral(record.mode, "all") };
}

function parseRequest(value: unknown): HelperRequest {
  const record = requireExactObject(value, [
    "protocolVersion",
    "operation",
    "source",
    "target",
    "options",
  ]);
  return {
    protocolVersion: requireLiteral(record.protocolVersion, 1),
    operation: requireEnum(record.operation, ["locate", "protect", "format"]),
    source: requireString(record.source),
    target: parseTarget(record.target),
    options: parseOptions(record.options),
  };
}

const reasonCodeSet = new Set<string>(REASON_CODES);

function parseReasonCode(value: unknown): ReasonCode {
  if (typeof value !== "string" || !reasonCodeSet.has(value)) {
    throw new ProtocolViolation();
  }
  return value as ReasonCode;
}

function parseErrorResponse(
  value: unknown,
  operation: ProtocolOperation | "unknown",
): ErrorResponse {
  const record = requireExactObject(value, ["protocolVersion", "operation", "ok", "error"]);
  const error = requireExactObject(record.error, ["code"]);
  return {
    protocolVersion: requireLiteral(record.protocolVersion, 1),
    operation: requireLiteral(record.operation, operation),
    ok: requireLiteral(record.ok, false),
    error: { code: parseReasonCode(error.code) },
  };
}

function parseEdit(value: unknown): FormatEdit {
  const record = requireExactObject(value, ["range", "expectedText", "newText"]);
  const expectedText = requireString(record.expectedText);
  if (expectedText.length === 0) {
    throw new ProtocolViolation();
  }
  return {
    range: parseRange(record.range, false),
    expectedText,
    newText: requireString(record.newText),
  };
}

function parseSkip(value: unknown): CandidateSkipPayload {
  const record = requireExactObject(value, ["range", "reason"]);
  return {
    range: parseRange(record.range, false),
    reason: parseReasonCode(record.reason),
  };
}

function parseSummary(value: unknown): FormatSummary {
  const record = requireExactObject(value, [
    "discovered",
    "selected",
    "changed",
    "unchanged",
    "skipped",
  ]);
  return {
    discovered: requireNonNegativeInteger(record.discovered),
    selected: requireNonNegativeInteger(record.selected),
    changed: requireNonNegativeInteger(record.changed),
    unchanged: requireNonNegativeInteger(record.unchanged),
    skipped: requireNonNegativeInteger(record.skipped),
  };
}

function validateOrderedNonOverlappingEdits(edits: readonly FormatEdit[]): void {
  const [first, ...remaining] = edits;
  if (first === undefined) {
    return;
  }
  let previous = first;
  for (const current of remaining) {
    if (comparePosition(current.range.start, previous.range.end) < 0) {
      throw new ProtocolViolation();
    }
    previous = current;
  }
}

function validateFormatRelations(response: FormatSuccess): FormatSuccess {
  const { summary } = response;
  if (
    response.edits.length !== summary.changed ||
    response.skips.length !== summary.skipped ||
    summary.changed + summary.unchanged + summary.skipped !== summary.selected ||
    summary.selected > summary.discovered
  ) {
    throw new ProtocolViolation();
  }
  return response;
}

function parseLocateResponse(value: unknown): LocateResponse {
  const object = requireObject(value);
  if (object.ok === false) {
    return parseErrorResponse(value, "locate");
  }
  const record = requireExactObject(value, ["protocolVersion", "operation", "ok", "candidates"]);
  return {
    protocolVersion: requireLiteral(record.protocolVersion, 1),
    operation: requireLiteral(record.operation, "locate"),
    ok: requireLiteral(record.ok, true),
    candidates: parseArray(record.candidates, (item) => parseRange(item, false)),
  };
}

function parseProtectResponse(value: unknown): ProtectResponse | ErrorResponse {
  const object = requireObject(value);
  if (object.ok === false) {
    return parseErrorResponse(value, "protect");
  }
  const record = requireExactObject(value, [
    "protocolVersion",
    "operation",
    "ok",
    "nonce",
    "skipped",
    "candidates",
  ]);
  return {
    protocolVersion: requireLiteral(record.protocolVersion, 1),
    operation: requireLiteral(record.operation, "protect"),
    ok: requireLiteral(record.ok, true),
    nonce: requireString(record.nonce),
    skipped: requireNonNegativeInteger(record.skipped),
    candidates: parseArray(record.candidates, (item) => {
      const candidate = requireExactObject(item, ["range", "sql", "singleLine"]);
      return {
        range: parseRange(candidate.range, false),
        sql: requireString(candidate.sql),
        singleLine: requireBoolean(candidate.singleLine),
      };
    }),
  };
}

function parseFormatSuccessObject(value: unknown): FormatSuccess {
  const record = requireExactObject(value, [
    "protocolVersion",
    "operation",
    "ok",
    "edits",
    "skips",
    "summary",
  ]);
  return {
    protocolVersion: requireLiteral(record.protocolVersion, 1),
    operation: requireEnum(record.operation, ["format", "finalize"]),
    ok: requireLiteral(record.ok, true),
    edits: parseArray(record.edits, parseEdit),
    skips: parseArray(record.skips, parseSkip),
    summary: parseSummary(record.summary),
  };
}

function parseFormatResponse(value: unknown): FormatResponse {
  const object = requireObject(value);
  if (object.ok === false) {
    return parseErrorResponse(value, "format");
  }
  const response = parseFormatSuccessObject(value);
  validateOrderedNonOverlappingEdits(response.edits);
  return validateFormatRelations(response);
}

function assertNever(value: never): never {
  void value;
  throw new ProtocolViolation();
}

export function parseProtocolValue(kind: "request", value: unknown): HelperRequest;
export function parseProtocolValue(kind: "locateResponse", value: unknown): LocateResponse;
export function parseProtocolValue(
  kind: "protectResponse",
  value: unknown,
): ProtectResponse | ErrorResponse;
export function parseProtocolValue(kind: "formatResponse", value: unknown): FormatResponse;
export function parseProtocolValue(kind: "preDispatchError", value: unknown): ErrorResponse;
export function parseProtocolValue(
  kind: ProtocolValueKind,
  value: unknown,
): HelperRequest | LocateResponse | ProtectResponse | ErrorResponse | FormatResponse;
export function parseProtocolValue(
  kind: ProtocolValueKind,
  value: unknown,
): HelperRequest | LocateResponse | ProtectResponse | ErrorResponse | FormatResponse {
  switch (kind) {
    case "request":
      return parseRequest(value);
    case "locateResponse":
      return parseLocateResponse(value);
    case "protectResponse":
      return parseProtectResponse(value);
    case "formatResponse":
      return parseFormatResponse(value);
    case "preDispatchError":
      return parseErrorResponse(value, "unknown");
    default:
      return assertNever(kind);
  }
}

export function serializeRequest(request: HelperRequest): Uint8Array {
  const validated = parseRequest(request);
  return new TextEncoder().encode(JSON.stringify(validated));
}

function parseFinalizeRequest(value: unknown): FinalizeRequest {
  const record = requireExactObject(value, [
    "protocolVersion",
    "operation",
    "source",
    "nonce",
    "options",
    "formatted",
  ]);
  return {
    protocolVersion: requireLiteral(record.protocolVersion, 1),
    operation: requireLiteral(record.operation, "finalize"),
    source: requireString(record.source),
    nonce: requireString(record.nonce),
    options: parseOptions(record.options),
    formatted: parseArray(record.formatted, (item) => {
      const itemRecord = requireExactObject(item, ["range", "sql"]);
      return {
        range: parseRange(itemRecord.range, false),
        sql: requireString(itemRecord.sql),
      };
    }),
  };
}

export function serializeFinalizeRequest(request: FinalizeRequest): Uint8Array {
  const validated = parseFinalizeRequest(request);
  return new TextEncoder().encode(JSON.stringify(validated));
}
