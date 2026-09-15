import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { REASON_CODES } from "../../src/constants.js";
import { buildExtension } from "../../tools/build.js";

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
      engines: manifest.engines,
      main: manifest.main,
    }).toEqual({
      name: "inline-sql-toolkit",
      displayName: "Inline SQL Toolkit",
      publisher: "hidenobunagai",
      engines: { vscode: "^1.95.0" },
      main: "./dist/extension.js",
    });
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("activates only for the approved languages", () => {
    const manifest = loadPackageJson();

    // Command activation events are synthesized by VS Code from
    // contributes.commands, so only language events belong here.
    expect(manifest.activationEvents).toEqual(["onLanguage:python", "onLanguage:mo-python"]);
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
    expect(Object.keys(contributes.configuration?.properties ?? {})).toHaveLength(6);
    expect((manifest.contributes as Record<string, unknown>).keybindings).toBeUndefined();
    expect((manifest.contributes as Record<string, unknown>).languages).toBeUndefined();
    expect(manifest.extensionDependencies).toBeUndefined();
    expect(capabilities.untrustedWorkspaces).toEqual({
      supported: "limited",
      description: "%untrustedWorkspaces.description%",
      restrictedConfigurations: [],
    });
  });

  it("maps the injected grammar scope to its embedded language", () => {
    const manifest = loadPackageJson();
    const contributes = (manifest.contributes ?? {}) as {
      readonly grammars?: readonly unknown[];
    };

    expect(contributes.grammars).toEqual([
      {
        scopeName: "inline-sql.injection",
        path: "./syntaxes/inline-sql.tmLanguage.json",
        injectTo: ["source.python", "source.mo-python"],
        embeddedLanguages: {
          "meta.embedded.sql": "sql",
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

  it("keeps the packaged diagnostic reason codes aligned with REASON_CODES", () => {
    const support = readProjectDocument("SUPPORT.md");
    const documented = Array.from(
      support.matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`/gm),
      (match) => match[1],
    ).filter((code): code is string => code !== undefined);
    // A code the implementation cannot emit is as wrong as an emitted code the
    // packaged reference omits.
    expect([...documented].sort()).toEqual([...REASON_CODES].sort());

    // Troubleshooting is the only README surface that names reason codes.
    const readme = readProjectDocument("README.md");
    const troubleshooting = readme.slice(readme.indexOf("## Troubleshooting"));
    const mentioned = Array.from(
      troubleshooting.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g),
      (match) => match[1],
    ).filter((code): code is string => code !== undefined);
    expect(mentioned.length).toBeGreaterThan(0);
    for (const code of mentioned) {
      expect(REASON_CODES).toContain(code);
    }
  });

  it("keeps the third-party notices aligned with the packaged notice tree", () => {
    const notices = readProjectDocument("THIRD_PARTY_NOTICES.md");
    const referenced = new Set(
      Array.from(notices.matchAll(/\(third_party\/([a-z0-9-]+)\//g), ({ 1: name }) => name),
    );
    const present = readdirSync(resolve(process.cwd(), "third_party"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    // A notice for a component that is no longer bundled is as wrong as a
    // bundled component without a notice.
    expect([...referenced].sort()).toEqual([...present].sort());
  });

  it("notices every npm package the bundle inlines", async () => {
    // The esbuild metafile is the only place that knows which node_modules
    // code ends up inside dist/extension.js, so the guard builds the real
    // bundle instead of trusting a hand-kept list.
    const metafile = await buildExtension();
    const bundle = metafile.outputs["dist/extension.js"];
    expect(bundle).toBeDefined();
    const inlined = new Map<string, string>();
    for (const input of Object.keys(bundle?.inputs ?? {})) {
      const name = /node_modules\/((?:@[^/]+\/)?[^/]+)\//u.exec(input)?.[1];
      if (name === undefined || inlined.has(name)) continue;
      const version = (
        JSON.parse(readProjectDocument(`node_modules/${name}/package.json`)) as {
          readonly version?: unknown;
        }
      ).version;
      expect(typeof version).toBe("string");
      if (typeof version !== "string") continue;
      inlined.set(name, version);
    }
    expect(inlined.size).toBeGreaterThan(0);

    const notices = readProjectDocument("THIRD_PARTY_NOTICES.md");
    for (const name of inlined.keys()) {
      expect(existsSync(resolve(process.cwd(), "third_party", name))).toBe(true);
      expect(notices).toContain(`(third_party/${name}/)`);
    }

    // tools/verify_vsix.py builds the osv-packaged-components input from those
    // same notice headings, so a notice that names another version than the
    // one esbuild inlined would make the advisory scan cover the wrong code.
    const declared = new Map<string, string>();
    for (const match of notices.matchAll(/^## `([^`]+)` npm package \(v(\d+\.\d+\.\d+)\)$/gm)) {
      const [, name, version] = match;
      if (name !== undefined && version !== undefined) {
        declared.set(name, version);
      }
    }
    expect([...declared.keys()].sort()).toEqual([...inlined.keys()].sort());
    for (const [name, version] of inlined) {
      expect(declared.get(name)).toBe(version);
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

    // Every negated allowlist entry must name a path this repository has, so a
    // removed runtime root cannot linger in the packaging rules.
    const allowlisted = vscodeignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("!"));
    expect(allowlisted.length).toBeGreaterThan(0);
    for (const entry of allowlisted) {
      const target = entry.slice(1);
      // dist/ is a build output; a fresh checkout has no dist/extension.js yet.
      if (target.startsWith("dist/")) continue;
      const literalRoot = target.split("*")[0]?.replace(/\/$/, "") ?? "";
      expect(literalRoot).not.toBe("");
      expect(existsSync(resolve(process.cwd(), literalRoot))).toBe(true);
    }

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
