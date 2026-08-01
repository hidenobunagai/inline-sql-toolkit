import { beforeEach, describe, expect, it } from "vitest";

import { readConfiguredPythonPath, readFormatOptions } from "../../src/vscode/configuration.js";
import { __mock } from "../support/vscode-mock.js";

beforeEach(() => {
  __mock.reset();
});

const resource = "file:///workspace/query.py";

describe("readFormatOptions", () => {
  it("uses all approved defaults", () => {
    expect(readFormatOptions(__mock.document({ uri: resource, languageId: "python" }).uri)).toEqual(
      {
        ok: true,
        options: {
          keywordCase: "upper",
          indentWidth: 2,
          wrapAfter: 88,
          useSpaceAroundOperators: true,
          expandSelectList: true,
          trimBlankBoundaries: true,
        },
      },
    );
  });

  it("accepts valid boundaries", () => {
    __mock.setConfiguration(
      __mock.document({ uri: resource, languageId: "python" }).uri,
      "format.keywordCase",
      "preserve",
    );
    __mock.setConfiguration(
      __mock.document({ uri: resource, languageId: "python" }).uri,
      "format.indentWidth",
      1,
    );
    __mock.setConfiguration(
      __mock.document({ uri: resource, languageId: "python" }).uri,
      "format.wrapAfter",
      500,
    );
    __mock.setConfiguration(
      __mock.document({ uri: resource, languageId: "python" }).uri,
      "format.useSpaceAroundOperators",
      false,
    );
    expect(readFormatOptions(__mock.document({ uri: resource, languageId: "python" }).uri)).toEqual(
      {
        ok: true,
        options: {
          keywordCase: "preserve",
          indentWidth: 1,
          wrapAfter: 500,
          useSpaceAroundOperators: false,
          expandSelectList: true,
          trimBlankBoundaries: true,
        },
      },
    );
  });

  it.each([
    ["format.keywordCase", "mixed"],
    ["format.keywordCase", 1],
    ["format.keywordCase", null],
    ["format.indentWidth", 0],
    ["format.indentWidth", 9],
    ["format.indentWidth", 1.5],
    ["format.indentWidth", null],
    ["format.wrapAfter", 19],
    ["format.wrapAfter", 501],
    ["format.wrapAfter", 88.5],
    ["format.wrapAfter", null],
    ["format.useSpaceAroundOperators", "true"],
    ["format.useSpaceAroundOperators", null],
  ])("rejects invalid %s=%j without defaulting", (key, value) => {
    const uri = __mock.document({ uri: resource, languageId: "python" }).uri;
    __mock.setConfiguration(uri, key, value);
    const result = readFormatOptions(uri);
    expect(result).toEqual({ ok: false, reason: "INVALID_CONFIGURATION" });
  });

  it("reads configuration resource-scoped", () => {
    const uri = __mock.document({ uri: resource, languageId: "python" }).uri;
    __mock.setConfiguration(uri, "format.indentWidth", 4);
    expect(readFormatOptions(uri)).toMatchObject({ ok: true, options: { indentWidth: 4 } });
    expect(__mock.configurationReads("format.indentWidth")).toBe(1);
  });
});

describe("readConfiguredPythonPath", () => {
  it("returns undefined for the empty default", () => {
    const uri = __mock.document({ uri: resource, languageId: "python" }).uri;
    expect(readConfiguredPythonPath(uri)).toEqual({ ok: true, value: undefined });
  });

  it("returns a configured path when trusted", () => {
    const uri = __mock.document({ uri: resource, languageId: "python" }).uri;
    __mock.setConfiguration(uri, "pythonPath", "/opt/python");
    expect(readConfiguredPythonPath(uri)).toEqual({ ok: true, value: "/opt/python" });
  });

  it("does not read restricted configuration while untrusted", () => {
    const uri = __mock.document({ uri: resource, languageId: "python" }).uri;
    __mock.setConfiguration(uri, "pythonPath", "/opt/python");
    __mock.setTrusted(false);
    expect(readConfiguredPythonPath(uri)).toEqual({ ok: false, reason: "WORKSPACE_UNTRUSTED" });
    expect(__mock.configurationReads("pythonPath")).toBe(0);
  });

  it("rejects non-string configured paths", () => {
    const uri = __mock.document({ uri: resource, languageId: "python" }).uri;
    __mock.setConfiguration(uri, "pythonPath", 123);
    expect(readConfiguredPythonPath(uri)).toEqual({ ok: false, reason: "INVALID_CONFIGURATION" });
  });
});
