import { describe, expect, test, vi } from "vitest";

import { REASON_CODES } from "../../src/constants.js";
import type { ErrorResponse, FormatResponse, HelperRequest } from "../../src/protocol.js";
import { parseProtocolValue, ProtocolViolation, serializeRequest } from "../../src/protocol.js";
import { loadProtocolCases } from "../support/helper-fixtures.js";

const requiredInvalidCases = [
  "unknown-request-key",
  "unknown-nested-key",
  "protocol-version-zero",
  "protocol-version-two",
  "negative-cursor-line",
  "reversed-selection-range",
  "empty-selection-range",
  "cursor-mode-missing-cursor",
  "selection-mode-missing-selection",
  "all-mode-with-cursor",
  "indent-width-below-minimum",
  "indent-width-above-maximum",
  "wrap-after-below-minimum",
  "wrap-after-above-maximum",
  "boolean-used-as-integer",
  "integer-used-as-boolean",
  "unsafe-integer-position",
  "invalid-keyword-case",
  "error-response-with-edits",
  "unknown-error-key",
  "invalid-reason-code",
  "locate-error-with-unknown-operation",
  "format-error-with-unknown-operation",
  "predispatch-error-with-format-operation",
  "unknown-operation-locate-success",
  "unknown-operation-format-success",
  "locate-success-with-empty-range",
  "format-response-with-non-string-text",
  "format-response-with-empty-expected-text",
  "overlapping-edit-ranges",
  "descending-non-overlapping-edit-order",
  "changed-count-does-not-match-edits",
  "skipped-count-does-not-match-skips",
  "summary-parts-do-not-equal-selected",
  "selected-exceeds-discovered",
  "unsafe-integer-summary",
] as const;

describe("protocol fixtures", () => {
  test("covers every required invalid protocol class", () => {
    const names = new Set(loadProtocolCases("invalid").map(({ name }) => name));
    expect([...requiredInvalidCases].filter((name) => !names.has(name))).toEqual([]);
  });

  for (const testCase of loadProtocolCases("valid")) {
    test(`accepts ${testCase.name}`, () => {
      expect(() => parseProtocolValue(testCase.kind, testCase.value)).not.toThrow();
    });
  }

  for (const testCase of loadProtocolCases("invalid")) {
    test(`rejects ${testCase.name}`, () => {
      expect(() => parseProtocolValue(testCase.kind, testCase.value)).toThrow(
        new ProtocolViolation("PROTOCOL_ERROR"),
      );
    });
  }
});

test("rejects non-finite direct numeric values", () => {
  for (const wrapAfter of [Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() =>
      parseProtocolValue("request", {
        protocolVersion: 1,
        operation: "locate",
        source: "",
        target: { mode: "all" },
        options: {
          keywordCase: "upper",
          indentWidth: 2,
          wrapAfter,
          useSpaceAroundOperators: true,
          expandSelectList: false,
          trimBlankBoundaries: false,
          dialect: "postgresql",
        },
      }),
    ).toThrow(new ProtocolViolation("PROTOCOL_ERROR"));
  }
});

test.each(["SELECT '日本語'", "SELECT '𝄞'", "SELECT 'e\u0301'"])(
  "round-trips Unicode without diagnostics containing source",
  (source) => {
    const request: HelperRequest = {
      protocolVersion: 1,
      operation: "locate",
      source,
      target: { mode: "all" },
      options: {
        keywordCase: "upper",
        indentWidth: 2,
        wrapAfter: 88,
        useSpaceAroundOperators: true,
        expandSelectList: false,
          trimBlankBoundaries: false,
          dialect: "postgresql",
      },
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const encoded = serializeRequest(request);
      const value: unknown = JSON.parse(new TextDecoder().decode(encoded));
      expect(parseProtocolValue("request", value)).toEqual(request);
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  },
);

test("returns only a stable reason code for a private invalid source", () => {
  const source = 'secret_query = "select customer_email"';
  let caught: unknown;
  try {
    parseProtocolValue("request", {
      protocolVersion: 1,
      operation: "locate",
      source,
      target: { mode: "all" },
      options: {
        keywordCase: "upper",
        indentWidth: 0,
        wrapAfter: 88,
        useSpaceAroundOperators: true,
        expandSelectList: false,
          trimBlankBoundaries: false,
          dialect: "postgresql",
      },
    });
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProtocolViolation);
  expect(String(caught)).toBe("ProtocolViolation: PROTOCOL_ERROR");
  expect(String(caught)).not.toContain(source);
});

test("constructs fresh values without retaining decoded input objects", () => {
  const target = { mode: "all" };
  const decoded = {
    protocolVersion: 1,
    operation: "locate",
    source: "SELECT 1",
    target,
    options: {
      keywordCase: "upper",
      indentWidth: 2,
      wrapAfter: 88,
      useSpaceAroundOperators: true,
      expandSelectList: false,
          trimBlankBoundaries: false,
          dialect: "postgresql",
    },
  };
  const parsed = parseProtocolValue("request", decoded);
  expect(parsed).not.toBe(decoded);
  expect(parsed.target).not.toBe(target);
  expect(parsed.options).not.toBe(decoded.options);
});

test("keeps context-specific response types", () => {
  const formatResponse: FormatResponse = parseProtocolValue("formatResponse", {
    protocolVersion: 1,
    operation: "format",
    ok: false,
    error: { code: "PROCESS_FAILED" },
  });
  const error: ErrorResponse = parseProtocolValue("preDispatchError", {
    protocolVersion: 1,
    operation: "unknown",
    ok: false,
    error: { code: REASON_CODES.at(-1) },
  });
  expect(formatResponse.ok).toBe(false);
  expect(error.operation).toBe("unknown");
});
