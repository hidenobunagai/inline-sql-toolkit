import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly name?: unknown;
  readonly displayName?: unknown;
  readonly publisher?: unknown;
  readonly version?: unknown;
  readonly engines?: unknown;
  readonly main?: unknown;
  readonly activationEvents?: unknown;
  readonly capabilities?: unknown;
  readonly configurationDefaults?: unknown;
  readonly extensionDependencies?: unknown;
  readonly contributes?: unknown;
  readonly repository?: unknown;
  readonly homepage?: unknown;
  readonly bugs?: unknown;
}

function loadPackageJson(): PackageManifest {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
  ) as PackageManifest;
}

function readProjectDocument(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("extension manifest", () => {
  it("declares the approved extension identity and entry point", () => {
    const manifest = loadPackageJson();

    expect({
      name: manifest.name,
      displayName: manifest.displayName,
      publisher: manifest.publisher,
      version: manifest.version,
      engines: manifest.engines,
      main: manifest.main,
    }).toEqual({
      name: "inline-sql-toolkit",
      displayName: "Inline SQL Toolkit",
      publisher: "hidenobunagai",
      version: "0.3.17",
      engines: { vscode: "^1.95.0" },
      main: "./dist/extension.js",
    });
  });

  it("activates only for the approved commands and languages", () => {
    const manifest = loadPackageJson();

    expect(manifest.activationEvents).toEqual([
      "onCommand:inlineSql.formatAtCursor",
      "onCommand:inlineSql.formatSelection",
      "onCommand:inlineSql.formatAll",
      "onLanguage:python",
      "onLanguage:mo-python",
    ]);
  });

  it("contributes only the approved public surface", () => {
    const manifest = loadPackageJson();
    const contributes = (manifest.contributes ?? {}) as {
      readonly commands?: readonly {
        readonly command: string;
        readonly title?: unknown;
        readonly description?: unknown;
      }[];
      readonly configuration?: {
        readonly properties?: Readonly<Record<string, unknown>>;
      };
    };
    const capabilities = (manifest.capabilities ?? {}) as {
      readonly untrustedWorkspaces?: {
        readonly supported: string;
        readonly restrictedConfigurations: readonly string[];
      };
    };
    expect(contributes.commands?.map(({ command }) => command)).toEqual([
      "inlineSql.formatAtCursor",
      "inlineSql.formatSelection",
      "inlineSql.formatAll",
    ]);
    expect(
      contributes.commands?.every(
        ({ title, description }) => typeof title === "string" && typeof description === "string",
      ),
    ).toBe(true);
    expect(Object.keys(contributes.configuration?.properties ?? {})).toHaveLength(7);
    expect((manifest.contributes as Record<string, unknown>).keybindings).toBeUndefined();
    expect((manifest.contributes as Record<string, unknown>).languages).toBeUndefined();
    expect(manifest.extensionDependencies).toBeUndefined();
    expect(capabilities.untrustedWorkspaces).toEqual({
      supported: "limited",
      description: "%untrustedWorkspaces.description%",
      restrictedConfigurations: [],
    });
  });

  it("maps both injected grammar scopes to their embedded languages", () => {
    const manifest = loadPackageJson();
    const contributes = (manifest.contributes ?? {}) as {
      readonly grammars?: readonly unknown[];
    };

    expect(contributes.grammars).toEqual([
      {
        scopeName: "inline-sql.python.injection",
        path: "./syntaxes/inline-sql-python.tmLanguage.json",
        injectTo: ["source.python", "source.mo-python"],
        embeddedLanguages: {
          "meta.embedded.inline.sql": "sql",
        },
      },
      {
        scopeName: "inline-sql.fstring-islands.injection",
        path: "./syntaxes/inline-sql-fstring-islands.tmLanguage.json",
        injectTo: ["source.python", "source.mo-python"],
        embeddedLanguages: {
          "meta.embedded.inline.python": "python",
        },
      },
    ]);
  });

  it("keeps notebook contributions in the test-only marimo fixture", () => {
    const manifest = loadPackageJson();
    const productionContributes = (manifest.contributes ?? {}) as Record<string, unknown>;
    expect(productionContributes.notebooks).toBeUndefined();

    const fixture = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "test/fixtures/extensions/marimo-language/package.json"),
        "utf8",
      ),
    ) as {
      readonly contributes?: {
        readonly notebooks?: readonly { readonly type?: unknown }[];
      };
    };
    expect(fixture.contributes?.notebooks).toEqual([
      expect.objectContaining({ type: "marimo-notebook" }),
    ]);
  });

  it("documents every public command, setting, and safety boundary", () => {
    const readme = readProjectDocument("README.md");

    for (const command of [
      "inlineSql.formatAtCursor",
      "inlineSql.formatSelection",
      "inlineSql.formatAll",
    ]) {
      expect(readme).toContain(command);
    }
    for (const setting of [
      "inlineSql.format.keywordCase",
      "inlineSql.format.indentWidth",
      "inlineSql.format.wrapAfter",
      "inlineSql.format.useSpaceAroundOperators",
      "inlineSql.format.expandSelectList",
      "inlineSql.format.trimBlankBoundaries",
      "inlineSql.format.dialect",
    ]) {
      expect(readme).toContain(setting);
    }

    for (const assertion of [
      "first logical line",
      "-- sql",
      "--sql",
      "SELECT",
      "WITH",
      "INSERT",
      "UPDATE",
      "DELETE",
      "MERGE",
      "CREATE",
      "ALTER",
      "DROP",
      "TRUNCATE",
      "EXPLAIN",
      "word boundary",
      "ASCII space",
      "tab",
      "CR",
      "LF",
      ".py",
      "Jupyter",
      "marimo",
      "plain",
      "raw",
      "f-string",
      "rf",
      "fr",
      "triple",
      "SQL-language cells",
      "%sql",
      "%%sql",
      "bytes",
      "concatenat",
      "t-string",
      "invalid Python",
      "manual-only",
      "never executed",
      "never validated",
      "sql-formatter",
      "dialect",
      "unsafe",
      "untrusted",
      "highlighting only",
      "WorkspaceEdit",
      "document version",
      "atomic",
      "privacy",
      "offline",
      "troubleshoot",
    ]) {
      expect(readme.toLowerCase()).toContain(assertion.toLowerCase());
    }
  });

  it("keeps manifest links on files retained in the VSIX", () => {
    const manifest = loadPackageJson();
    const contributes = (manifest.contributes ?? {}) as {
      readonly grammars?: readonly { readonly path?: unknown }[];
    };
    const main = manifest.main;
    expect(typeof main).toBe("string");
    if (typeof main === "string") {
      expect(main).toBe("./dist/extension.js");
      expect(main.startsWith("./")).toBe(true);
      expect(main.endsWith(".ts")).toBe(false);
    }
    for (const grammar of contributes.grammars ?? []) {
      expect(typeof grammar.path).toBe("string");
      if (typeof grammar.path === "string") {
        expect(existsSync(resolve(process.cwd(), grammar.path))).toBe(true);
        expect(grammar.path.startsWith("./")).toBe(true);
        expect(grammar.path.endsWith(".tmLanguage.json")).toBe(true);
      }
    }

    for (const packagedDocument of [
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
      "SECURITY.md",
      "SUPPORT.md",
      "THIRD_PARTY_NOTICES.md",
    ]) {
      expect(existsSync(resolve(process.cwd(), packagedDocument))).toBe(true);
    }

    const vscodeignore = readProjectDocument(".vscodeignore");
    expect(vscodeignore).toContain("!dist/extension.js");
    expect(vscodeignore).toContain("!syntaxes/**");

    expect(manifest.repository).toEqual({
      type: "git",
      url: "https://github.com/hidenobunagai/inline-sql-toolkit.git",
    });
    expect(manifest.homepage).toBe("https://github.com/hidenobunagai/inline-sql-toolkit#readme");
    expect(manifest.bugs).toEqual({
      url: "https://github.com/hidenobunagai/inline-sql-toolkit/issues",
    });

    const localReadmeLinks = Array.from(
      readProjectDocument("README.md").matchAll(/\]\(([^)]+)\)/g),
      ({ 1: link }) => link,
    ).filter((link): link is string => link !== undefined && !/^[a-z]+:/i.test(link));
    for (const link of localReadmeLinks) {
      expect(link.startsWith("docs/")).toBe(false);
      expect(existsSync(resolve(process.cwd(), link))).toBe(true);
    }
  });
});
