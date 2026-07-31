import { readFileSync } from "node:fs";
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
  readonly extensionDependencies?: unknown;
  readonly contributes?: unknown;
}

function loadPackageJson(): PackageManifest {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
  ) as PackageManifest;
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
      version: "0.1.0",
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
      readonly commands?: readonly { readonly command: string }[];
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
    expect(Object.keys(contributes.configuration?.properties ?? {})).toHaveLength(5);
    expect(manifest.extensionDependencies).toBeUndefined();
    expect(capabilities.untrustedWorkspaces).toEqual({
      supported: "limited",
      description: "%untrustedWorkspaces.description%",
      restrictedConfigurations: ["inlineSql.pythonPath"],
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
});
